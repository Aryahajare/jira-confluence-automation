import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ─── ENV ──────────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT       || 5000;
const EMAIL      = process.env.EMAIL;        // your Atlassian account email
const API_TOKEN  = process.env.API_TOKEN;    // your Atlassian API token
const BASE_URL   = process.env.BASE_URL;     // https://your-org.atlassian.net
const SPACE_KEY  = process.env.SPACE_KEY  || "REL";  // key of your EXISTING space

["EMAIL", "API_TOKEN", "BASE_URL"].forEach((k) => {
  if (!process.env[k]) { console.error(`❌ Missing env var: ${k}`); process.exit(1); }
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
const authHeader = "Basic " + Buffer.from(`${EMAIL}:${API_TOKEN}`).toString("base64");
const hdrs = {
  Authorization: authHeader,
  "Content-Type": "application/json",
  Accept: "application/json",
};

// ─── ONE axios client (v2 only — no v1, no space creation) ───────────────────
//
//  WHY NO V1:   GET /wiki/rest/api/space/{key} returns 404 for newer tenants.
//  WHY NO CREATE: POST /spaces (v2) is RBAC-beta-only → 404 for most accounts.
//               POST /wiki/rest/api/space (v1) requires Confluence Admin
//               "Create Space" global permission → 403 for regular users.
//
//  SOLUTION:    Use GET /wiki/api/v2/spaces (paginated list) to find our space
//               by matching .key === SPACE_KEY. The list response includes
//               both .id (spaceId) and .homepageId (parentId for new pages).
//
const v2 = axios.create({ baseURL: `${BASE_URL}/wiki/api/v2`, headers: hdrs });

// ─── Universal call wrapper (full request + response logged) ──────────────────
async function api(label, method, url, payload, params) {
  const fullUrl = `${v2.defaults.baseURL}${url}`;
  console.log(`\n${"─".repeat(60)}`);
  console.log(`⏳ [${label}]  ${method.toUpperCase()} ${fullUrl}`);
  if (params)  console.log(`   PARAMS   : ${JSON.stringify(params)}`);
  if (payload) console.log(`   PAYLOAD  :\n${JSON.stringify(payload, null, 2)}`);

  try {
    const res = await v2.request({ method, url, data: payload, params });
    console.log(`   STATUS   : ${res.status} ✅`);
    console.log(`   RESPONSE :\n${JSON.stringify(res.data, null, 2)}`);
    console.log(`${"─".repeat(60)}\n`);
    return res.data;
  } catch (err) {
    const status = err.response?.status ?? "NO_RESPONSE";
    const body   = err.response?.data   ?? err.message;
    console.log(`   STATUS   : ${status} ❌`);
    console.log(`   ERROR    :\n${JSON.stringify(body, null, 2)}`);
    console.log(`${"─".repeat(60)}\n`);
    throw err;
  }
}

// ─── Bootstrap: find SPACE_KEY in paginated v2 /spaces list ──────────────────
//
//  v2 GET /spaces returns ALL spaces in pages. We walk them until we find
//  one where space.key === SPACE_KEY. Both .id and .homepageId live on the
//  same object so one pass gives us everything.
//
let _spaceId  = null;
let _parentId = null;

async function bootstrapSpace() {
  if (_spaceId && _parentId) {
    console.log(`✅ Bootstrap cache hit → spaceId=${_spaceId}  parentId=${_parentId}`);
    return;
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`🚀 BOOTSTRAP — searching for space key="${SPACE_KEY}" via v2 list`);
  console.log(`${"═".repeat(60)}`);

  let cursor = null;
  let found  = null;
  let page   = 0;

  do {
    page++;
    const params = { limit: 50 };
    if (cursor) params.cursor = cursor;

    const data = await api(`LIST SPACES page=${page}`, "get", "/spaces", undefined, params);

    console.log(`   Checking ${data.results?.length ?? 0} spaces on page ${page}...`);
    data.results?.forEach((s) => {
      console.log(`     • key="${s.key}"  id=${s.id}  homepageId=${s.homepageId}  name="${s.name}"`);
    });

    found = data.results?.find((s) => s.key === SPACE_KEY);
    if (found) break;

    // Pagination: extract cursor from _links.next
    const next = data._links?.next;
    if (next) {
      const m = next.match(/cursor=([^&]+)/);
      cursor = m ? decodeURIComponent(m[1]) : null;
    } else {
      cursor = null;
    }
  } while (cursor);

  if (!found) {
    throw new Error(
      `Space key="${SPACE_KEY}" was not found after scanning all visible spaces. ` +
      `Check that your API token has Confluence access and that key "${SPACE_KEY}" is correct.`
    );
  }

  console.log(`\n✅ Found space "${SPACE_KEY}":`);
  console.log(JSON.stringify(found, null, 2));

  if (!found.homepageId) {
    // Rare: list response omits homepageId — fetch space directly by id
    console.log(`⚠️  homepageId missing in list — fetching space detail...`);
    const detail = await api("GET SPACE DETAIL", "get", `/spaces/${found.id}`);
    found.homepageId = detail.homepageId;
    console.log(`   homepageId from detail: ${found.homepageId}`);
  }

  if (!found.homepageId) {
    throw new Error(
      `Space "${SPACE_KEY}" has no homepageId even after detail fetch. ` +
      `Create at least one page manually in this space, then restart the server.`
    );
  }

  _spaceId  = String(found.id);
  _parentId = String(found.homepageId);

  console.log(`\n✅ Bootstrap complete!`);
  console.log(`   spaceId  : ${_spaceId}`);
  console.log(`   parentId : ${_parentId} (space homepage — used as parent for new pages)\n`);
}

// ─── Table template ───────────────────────────────────────────────────────────
const createTableHTML = () => `
<table data-table-width="760" data-layout="default">
  <tbody>
    <tr>
      <th><p><strong>Ticket ID</strong></p></th>
      <th><p><strong>Summary</strong></p></th>
      <th><p><strong>Assignee</strong></p></th>
      <th><p><strong>Reporter</strong></p></th>
      <th><p><strong>Stage Only</strong></p></th>
      <th><p><strong>Link</strong></p></th>
    </tr>
  </tbody>
</table>`.trim();

// ─── /debug — hit this first to verify auth + space visibility ────────────────
app.get("/debug", async (req, res) => {
  console.log("\n🔬 /debug hit");
  const report = { env: {}, currentUser: null, spaces: [], targetSpace: null, error: null };

  report.env = {
    BASE_URL,
    EMAIL,
    SPACE_KEY,
    API_TOKEN: API_TOKEN ? `${API_TOKEN.slice(0, 6)}...` : "NOT SET",
  };

  try {
    // Who am I?
    const me = await api("GET CURRENT USER", "get", "/users/current");
    report.currentUser = { id: me.accountId, displayName: me.displayName, email: me.email };
  } catch (e) {
    report.error = `GET /users/current failed: ${e.response?.status} ${JSON.stringify(e.response?.data)}`;
    return res.status(500).json(report);
  }

  try {
    // List first page of spaces
    const spaces = await api("LIST SPACES (debug)", "get", "/spaces", undefined, { limit: 50 });
    report.spaces = spaces.results?.map((s) => ({
      key: s.key, id: s.id, homepageId: s.homepageId, name: s.name,
    }));
    report.targetSpace = report.spaces.find((s) => s.key === SPACE_KEY) ?? "NOT FOUND IN FIRST 50";
  } catch (e) {
    report.error = `GET /spaces failed: ${e.response?.status} ${JSON.stringify(e.response?.data)}`;
  }

  res.json(report);
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("✅ Backend running — hit GET /debug to verify auth & space"));

// ─── Webhook ──────────────────────────────────────────────────────────────────
app.post("/jira-webhook", async (req, res) => {
  console.log(`\n${"═".repeat(60)}`);
  console.log("🔥 WEBHOOK HIT");
  console.log(`${"═".repeat(60)}`);
  console.log("📦 BODY:\n" + JSON.stringify(req.body, null, 2));

  try {
    const data = req.body;

    // ── 1. Extract release label ──────────────────────────────────────────────
    const labels    = data.labels || [];
    const labelList = Array.isArray(labels)
      ? labels
      : String(labels).split(",").map((l) => l.trim());

    console.log(`🏷  Labels: ${JSON.stringify(labelList)}`);
    const release = labelList.find((l) => l.includes("release-"));
    if (!release) {
      console.log("⏭  No release-* label — skipping.");
      return res.status(200).send("No release label — nothing to do.");
    }

    const pageTitle = `${release.trim()} - CMS Wiki`;
    console.log(`📄 Target page: "${pageTitle}"`);

    // ── 2. Bootstrap (cached) ─────────────────────────────────────────────────
    await bootstrapSpace();

    // ── 3. Search for existing page ───────────────────────────────────────────
    const searchData = await api("SEARCH PAGE", "get", "/pages", undefined, {
      spaceId: _spaceId,
      title: pageTitle,
      "body-format": "storage",
      limit: 1,
    });

    let pageId, currentBody, currentVersion;

    if (searchData.results.length === 0) {
      // ── 4a. Create new page ───────────────────────────────────────────────
      console.log("🆕 Page not found — creating...");
      const created = await api("CREATE PAGE", "post", "/pages", {
        spaceId:  _spaceId,
        parentId: _parentId,   // ← space homepage; required by v2 or you get 404
        status:   "current",
        title:    pageTitle,
        body:     { representation: "storage", value: createTableHTML() },
      });

      pageId         = created.id;
      currentBody    = created.body?.storage?.value ?? createTableHTML();
      currentVersion = created.version?.number ?? 1;
      console.log(`✅ Page created — id=${pageId}, version=${currentVersion}`);

    } else {
      // ── 4b. Fetch existing page body ─────────────────────────────────────
      console.log("📄 Page exists — fetching...");
      pageId = searchData.results[0].id;
      const full = await api("GET PAGE BODY", "get", `/pages/${pageId}`, undefined, {
        "body-format": "storage",
      });
      currentBody    = full.body?.storage?.value;
      currentVersion = full.version?.number;
      console.log(`📝 Fetched — version=${currentVersion}`);
    }

    // ── 5. Inject new row ─────────────────────────────────────────────────────
    const safe = (v) =>
      String(v || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const newRow = [
      `<tr>`,
      `  <td><p>${safe(data.ticketId)}</p></td>`,
      `  <td><p>${safe(data.summary)}</p></td>`,
      `  <td><p>${safe(data.assignee) || "Unassigned"}</p></td>`,
      `  <td><p>${safe(data.reporter)}</p></td>`,
      `  <td><p>${safe(data.stageOnly) || "false"}</p></td>`,
      `  <td><p><a href="${data.link || "#"}">View</a></p></td>`,
      `</tr>`,
    ].join("\n");

    if (!currentBody?.includes("</tbody>")) {
      console.warn("⚠️  No </tbody> found — reinitialising table.");
      currentBody = createTableHTML();
    }
    const updatedBody = currentBody.replace("</tbody>", `${newRow}\n</tbody>`);

    // ── 6. Update page ────────────────────────────────────────────────────────
    await api("UPDATE PAGE", "put", `/pages/${pageId}`, {
      id:      pageId,
      status:  "current",
      title:   pageTitle,
      version: { number: currentVersion + 1 },
      body:    { representation: "storage", value: updatedBody },
    });

    console.log("🎉 SUCCESS — ticket row appended.");
    res.status(200).send("✅ Done");

  } catch (err) {
    const detail = err.response?.data ?? err.message;
    console.error("❌ WEBHOOK ERROR:\n" + JSON.stringify(detail, null, 2));
    res.status(500).json({ error: "Internal error", detail });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🌍 Server starting on port ${PORT}`);
  console.log(`   BASE_URL  : ${BASE_URL}`);
  console.log(`   EMAIL     : ${EMAIL}`);
  console.log(`   SPACE_KEY : ${SPACE_KEY}`);
  console.log(`\n   👉 Hit GET /debug to verify auth & confirm space is visible\n`);

  try {
    await bootstrapSpace();
  } catch (err) {
    console.error("❌ Bootstrap failed at startup:", err.message);
    console.warn("⚠️  Server still running — bootstrap retries on first webhook.");
  }
});