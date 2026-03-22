import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ─── ENV ──────────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT       || 5000;
const EMAIL          = process.env.EMAIL;          // your Atlassian account email
const API_TOKEN      = process.env.API_TOKEN;      // your Atlassian API token
const BASE_URL       = process.env.BASE_URL;       // https://your-org.atlassian.net
// Space we will CREATE (or reuse if already exists)
const NEW_SPACE_KEY  = process.env.NEW_SPACE_KEY  || "CMSWIKI";   // e.g. CMSWIKI
const NEW_SPACE_NAME = process.env.NEW_SPACE_NAME || "CMS Wiki Releases";

// ─── Sanity-check env at startup ─────────────────────────────────────────────
["EMAIL", "API_TOKEN", "BASE_URL"].forEach((k) => {
  if (!process.env[k]) {
    console.error(`❌ Missing required env var: ${k}`);
    process.exit(1);
  }
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
const authHeader = "Basic " + Buffer.from(`${EMAIL}:${API_TOKEN}`).toString("base64");

// ─── Axios instances ──────────────────────────────────────────────────────────
const v2 = axios.create({
  baseURL: `${BASE_URL}/wiki/api/v2`,
  headers: {
    Authorization: authHeader,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

// ─── Debug logger — dumps method, url, status, full response body ─────────────
function dbg(label, method, url, status, data) {
  console.log("\n" + "─".repeat(60));
  console.log(`🔎 [${label}]  ${method.toUpperCase()} ${url}`);
  console.log(`   Status : ${status}`);
  console.log(`   Body   :\n${JSON.stringify(data, null, 2)}`);
  console.log("─".repeat(60) + "\n");
}

// Wrap v2 calls so every response is auto-logged
async function call(label, method, url, payload, params) {
  console.log(`⏳ ${label} — ${method.toUpperCase()} ${url}`);
  try {
    const res = await v2.request({
      method,
      url,
      data: payload,
      params,
    });
    dbg(label, method, url, res.status, res.data);
    return res.data;
  } catch (err) {
    const status = err.response?.status ?? "no-response";
    const data   = err.response?.data   ?? err.message;
    dbg(`❌ ${label} FAILED`, method, url, status, data);
    throw err;
  }
}

// ─── Space bootstrap (runs once, result cached) ───────────────────────────────
//
// STRATEGY — full v2, zero v1:
//   1. GET  /wiki/api/v2/spaces?keys=CMSWIKI   → see if space already exists
//            NOTE: v2 GET /spaces does NOT support ?keys filter (returns all),
//            so we list and find manually.
//   2. If NOT found → POST /wiki/api/v2/spaces  → create it.
//            Response contains: { id, key, homepageId, ... }
//   3. Cache id (spaceId) + homepageId — both needed for page creation.
//
let _spaceId  = null;
let _parentId = null;   // homepageId of the managed space

async function bootstrapSpace() {
  if (_spaceId && _parentId) return;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`🚀 BOOTSTRAP — looking for space key="${NEW_SPACE_KEY}"...`);
  console.log(`${"═".repeat(60)}\n`);

  // ── Step A: list all spaces and scan for our key ──────────────────────────
  // The v2 GET /spaces endpoint returns pages of results; iterate until found
  // or we exhaust all pages.
  let cursor = null;
  let found  = null;

  do {
    const params = { limit: 50 };
    if (cursor) params.cursor = cursor;

    const listData = await call(
      "LIST SPACES",
      "get",
      "/spaces",
      undefined,
      params
    );

    found = (listData.results || []).find((s) => s.key === NEW_SPACE_KEY);
    if (found) break;

    // Follow pagination cursor
    const nextLink = listData._links?.next;
    if (nextLink) {
      // cursor is embedded in the next link as ?cursor=xxx
      const match = nextLink.match(/cursor=([^&]+)/);
      cursor = match ? decodeURIComponent(match[1]) : null;
    } else {
      cursor = null;
    }
  } while (cursor);

  if (found) {
    // ── Space already exists ────────────────────────────────────────────────
    console.log(`✅ Space "${NEW_SPACE_KEY}" already exists.`);
    console.log(`   id         : ${found.id}`);
    console.log(`   homepageId : ${found.homepageId}`);

    if (!found.homepageId) {
      console.warn("⚠️  homepageId is missing from list response — fetching space directly...");
      const spaceDetail = await call(
        "GET SPACE DETAIL",
        "get",
        `/spaces/${found.id}`
      );
      found.homepageId = spaceDetail.homepageId;
      console.log(`   homepageId (fetched) : ${found.homepageId}`);
    }

    _spaceId  = String(found.id);
    _parentId = String(found.homepageId);

  } else {
    // ── Create the space ─────────────────────────────────────────────────────
    console.log(`🆕 Space "${NEW_SPACE_KEY}" not found — creating...`);

    const created = await call(
      "CREATE SPACE",
      "post",
      "/spaces",
      {
        key:  NEW_SPACE_KEY,
        name: NEW_SPACE_NAME,
        description: {
          value: "Auto-created by the CMS release webhook automation.",
          representation: "plain",
        },
      }
    );

    console.log(`✅ Space created!`);
    console.log(`   id         : ${created.id}`);
    console.log(`   key        : ${created.key}`);
    console.log(`   homepageId : ${created.homepageId}`);

    if (!created.homepageId) {
      throw new Error(
        "Space was created but response contained no homepageId. " +
        "Full response logged above — inspect it and open a bug with Atlassian."
      );
    }

    _spaceId  = String(created.id);
    _parentId = String(created.homepageId);
  }

  console.log(`\n✅ Bootstrap complete → spaceId=${_spaceId}, parentId=${_parentId}\n`);
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
  console.log(`\n${"═".repeat(60)}`);
  console.log("🔥 WEBHOOK HIT");
  console.log(`${"═".repeat(60)}`);
  console.log("📦 BODY:\n" + JSON.stringify(req.body, null, 2) + "\n");

  try {
    const data = req.body;

    // ── 1. Extract release label ──────────────────────────────────────────────
    const labels    = data.labels || [];
    const labelList = Array.isArray(labels)
      ? labels
      : String(labels).split(",").map((l) => l.trim());

    console.log(`🏷  Labels parsed: ${JSON.stringify(labelList)}`);

    const release = labelList.find((l) => l.includes("release-"));
    if (!release) {
      console.log("⏭  No release-* label — skipping.");
      return res.status(200).send("No release label — nothing to do.");
    }

    const pageTitle = `${release.trim()} - CMS Wiki`;
    console.log(`📄 Target page title: "${pageTitle}"`);

    // ── 2. Bootstrap space (cached) ───────────────────────────────────────────
    await bootstrapSpace();
    const spaceId  = _spaceId;
    const parentId = _parentId;

    // ── 3. Search for existing page ───────────────────────────────────────────
    const searchData = await call(
      "SEARCH PAGE",
      "get",
      "/pages",
      undefined,
      { spaceId, title: pageTitle, "body-format": "storage", limit: 1 }
    );

    let pageId, currentBody, currentVersion;

    if (searchData.results.length === 0) {
      // ── 4a. Create page ───────────────────────────────────────────────────
      console.log("🆕 Page not found — creating...");

      const created = await call(
        "CREATE PAGE",
        "post",
        "/pages",
        {
          spaceId,
          parentId,
          status: "current",
          title:  pageTitle,
          body:   { representation: "storage", value: createTableHTML() },
        }
      );

      pageId         = created.id;
      currentBody    = created.body?.storage?.value ?? createTableHTML();
      currentVersion = created.version?.number ?? 1;
      console.log(`✅ Page created — id=${pageId}, version=${currentVersion}`);

    } else {
      // ── 4b. Fetch existing page ──────────────────────────────────────────
      console.log("📄 Page found — fetching full body...");
      pageId = searchData.results[0].id;

      const fullPage = await call(
        "GET PAGE BODY",
        "get",
        `/pages/${pageId}`,
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
      console.warn("⚠️  </tbody> not found in page body — reinitialising table.");
      currentBody = createTableHTML();
    }

    const updatedBody = currentBody.replace("</tbody>", `${newRow}\n</tbody>`);

    // ── 6. Update page ────────────────────────────────────────────────────────
    await call(
      "UPDATE PAGE",
      "put",
      `/pages/${pageId}`,
      {
        id:      pageId,
        status:  "current",
        title:   pageTitle,
        version: { number: currentVersion + 1 },
        body:    { representation: "storage", value: updatedBody },
      }
    );

    console.log("🎉 SUCCESS — ticket row appended to Confluence page.");
    res.status(200).send("✅ Done");

  } catch (err) {
    const detail = err.response?.data ?? err.message;
    console.error("❌ WEBHOOK HANDLER ERROR:\n" + JSON.stringify(detail, null, 2));
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
    console.warn("⚠️  Server is still running — bootstrap will retry on first webhook.");
  }
});