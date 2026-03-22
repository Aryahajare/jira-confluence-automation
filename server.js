import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ─── ENV ──────────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT           || 5000;
const EMAIL          = process.env.EMAIL;          // your Atlassian account email
const API_TOKEN      = process.env.API_TOKEN;      // your Atlassian API token
const BASE_URL       = process.env.BASE_URL;       // https://your-org.atlassian.net
const NEW_SPACE_KEY  = process.env.NEW_SPACE_KEY  || "CMSWIKI";
const NEW_SPACE_NAME = process.env.NEW_SPACE_NAME || "CMS Wiki Releases";

// ─── Startup env check ────────────────────────────────────────────────────────
["EMAIL", "API_TOKEN", "BASE_URL"].forEach((k) => {
  if (!process.env[k]) { console.error(`❌ Missing env: ${k}`); process.exit(1); }
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
const authHeader = "Basic " + Buffer.from(`${EMAIL}:${API_TOKEN}`).toString("base64");
const commonHeaders = { Authorization: authHeader, "Content-Type": "application/json", Accept: "application/json" };

// ─── Two axios instances ──────────────────────────────────────────────────────
//
//  v1 → /wiki/rest/api   — used for: create space, lookup space
//  v2 → /wiki/api/v2     — used for: search pages, create page, update page
//
//  WHY SPLIT:
//    POST /wiki/api/v2/spaces  →  404 unless tenant is in Atlassian RBAC Beta.
//    POST /wiki/rest/api/space →  works for ALL Confluence Cloud tenants. ✅
//
const v1 = axios.create({ baseURL: `${BASE_URL}/wiki/rest/api`, headers: commonHeaders });
const v2 = axios.create({ baseURL: `${BASE_URL}/wiki/api/v2`,  headers: commonHeaders });

// ─── Universal debug wrapper ──────────────────────────────────────────────────
async function api(client, label, method, url, payload, params) {
  console.log(`\n${"─".repeat(55)}`);
  console.log(`⏳  ${label}`);
  console.log(`    ${method.toUpperCase()} ${client.defaults.baseURL}${url}`);
  if (params)  console.log(`    PARAMS  : ${JSON.stringify(params)}`);
  if (payload) console.log(`    PAYLOAD : ${JSON.stringify(payload, null, 2)}`);

  try {
    const res = await client.request({ method, url, data: payload, params });
    console.log(`    STATUS  : ${res.status}`);
    console.log(`    RESPONSE: ${JSON.stringify(res.data, null, 2)}`);
    console.log(`${"─".repeat(55)}\n`);
    return res.data;
  } catch (err) {
    const status = err.response?.status ?? "NO_RESPONSE";
    const body   = err.response?.data   ?? err.message;
    console.log(`    STATUS  : ${status}  ❌`);
    console.log(`    ERROR   : ${JSON.stringify(body, null, 2)}`);
    console.log(`${"─".repeat(55)}\n`);
    throw err;
  }
}

// ─── Bootstrap cache ──────────────────────────────────────────────────────────
let _spaceId  = null;   // v2 numeric space id  (used for: search pages, create page)
let _parentId = null;   // homepageId            (required as parentId for POST /pages)

// ─── bootstrapSpace ───────────────────────────────────────────────────────────
//
//  STEP 1 — Try GET  v1 /space/{key}         → space already exists
//  STEP 2 — If 404,  POST v1 /space          → create the space
//  STEP 3 — Extract .id and .homepage.id from response
//
async function bootstrapSpace() {
  if (_spaceId && _parentId) {
    console.log(`✅ Bootstrap cached → spaceId=${_spaceId}  parentId=${_parentId}`);
    return;
  }

  console.log(`\n${"═".repeat(55)}`);
  console.log(`🚀 BOOTSTRAP — space key="${NEW_SPACE_KEY}"`);
  console.log(`${"═".repeat(55)}`);

  // ── STEP 1: check if space already exists ─────────────────────────────────
  let spaceData = null;
  try {
    spaceData = await api(v1, "CHECK SPACE EXISTS", "get",
      `/space/${encodeURIComponent(NEW_SPACE_KEY)}`,
      undefined,
      { expand: "homepage" }
    );
    console.log(`✅ Space already exists.`);
  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`ℹ️  Space not found (404) — will create it.`);
    } else {
      throw err; // unexpected error — surface it
    }
  }

  // ── STEP 2: create space if it didn't exist ───────────────────────────────
  if (!spaceData) {
    spaceData = await api(v1, "CREATE SPACE", "post", "/space", {
      key:  NEW_SPACE_KEY,
      name: NEW_SPACE_NAME,
      description: {
        plain: {
          value: "Auto-created by the CMS release webhook automation.",
          representation: "plain",
        },
      },
    });
    console.log(`✅ Space created.`);

    // Fetch again with homepage expanded so we get homepageId
    spaceData = await api(v1, "FETCH SPACE AFTER CREATE", "get",
      `/space/${encodeURIComponent(NEW_SPACE_KEY)}`,
      undefined,
      { expand: "homepage" }
    );
  }

  // ── STEP 3: extract ids ───────────────────────────────────────────────────
  console.log(`\n📋 SPACE OBJECT DUMP:`);
  console.log(JSON.stringify(spaceData, null, 2));

  const spaceId    = spaceData?.id;
  const homepageId = spaceData?.homepage?.id;

  if (!spaceId) {
    throw new Error("Bootstrap failed: space response has no 'id' field. See dump above.");
  }
  if (!homepageId) {
    throw new Error(
      "Bootstrap failed: space has no 'homepage.id'. " +
      "This can happen if the space was JUST created and Confluence hasn't generated " +
      "the root page yet. Wait 5 seconds and restart the server."
    );
  }

  _spaceId  = String(spaceId);
  _parentId = String(homepageId);

  console.log(`\n✅ Bootstrap complete!`);
  console.log(`   spaceId  (for v2 page ops) : ${_spaceId}`);
  console.log(`   parentId (space homepage)  : ${_parentId}\n`);
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

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("✅ Backend running"));

// ─── Webhook ──────────────────────────────────────────────────────────────────
app.post("/jira-webhook", async (req, res) => {
  console.log(`\n${"═".repeat(55)}`);
  console.log(`🔥 WEBHOOK HIT`);
  console.log(`${"═".repeat(55)}`);
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

    // ── 2. Bootstrap (cached after first run) ─────────────────────────────────
    await bootstrapSpace();

    // ── 3. Search for existing page ───────────────────────────────────────────
    const searchData = await api(v2, "SEARCH PAGE", "get", "/pages",
      undefined,
      { spaceId: _spaceId, title: pageTitle, "body-format": "storage", limit: 1 }
    );

    let pageId, currentBody, currentVersion;

    if (searchData.results.length === 0) {
      // ── 4a. Create page ────────────────────────────────────────────────────
      console.log("🆕 Page not found — creating...");

      const created = await api(v2, "CREATE PAGE", "post", "/pages", {
        spaceId:  _spaceId,
        parentId: _parentId,
        status:   "current",
        title:    pageTitle,
        body:     { representation: "storage", value: createTableHTML() },
      });

      pageId         = created.id;
      currentBody    = created.body?.storage?.value ?? createTableHTML();
      currentVersion = created.version?.number ?? 1;
      console.log(`✅ Page created — id=${pageId}, version=${currentVersion}`);

    } else {
      // ── 4b. Fetch existing page ────────────────────────────────────────────
      console.log("📄 Page exists — fetching full body...");
      pageId = searchData.results[0].id;

      const fullPage = await api(v2, "GET PAGE BODY", "get", `/pages/${pageId}`,
        undefined,
        { "body-format": "storage" }
      );

      currentBody    = fullPage.body?.storage?.value;
      currentVersion = fullPage.version?.number;
      console.log(`📝 Fetched — version=${currentVersion}`);
    }

    // ── 5. Build new row ──────────────────────────────────────────────────────
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
    await api(v2, "UPDATE PAGE", "put", `/pages/${pageId}`, {
      id:      pageId,
      status:  "current",
      title:   pageTitle,
      version: { number: currentVersion + 1 },
      body:    { representation: "storage", value: updatedBody },
    });

    console.log("🎉 SUCCESS — ticket row appended to Confluence page.");
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
  console.log(`   BASE_URL       : ${BASE_URL}`);
  console.log(`   EMAIL          : ${EMAIL}`);
  console.log(`   NEW_SPACE_KEY  : ${NEW_SPACE_KEY}`);
  console.log(`   NEW_SPACE_NAME : ${NEW_SPACE_NAME}\n`);

  try {
    await bootstrapSpace();
  } catch (err) {
    console.error("❌ Bootstrap failed at startup:", err.message);
    console.warn("⚠️  Server still running — bootstrap will retry on first webhook hit.");
  }
});