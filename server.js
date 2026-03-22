import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT      = process.env.PORT      || 5000;
const EMAIL     = process.env.EMAIL;
const API_TOKEN = process.env.API_TOKEN;
const BASE_URL  = process.env.BASE_URL;     // e.g. https://your-org.atlassian.net
const SPACE_ID  = process.env.SPACE_ID;     // ← REQUIRED: numeric System key e.g. "327691"
const SPACE_KEY = process.env.SPACE_KEY;    // fallback if SPACE_ID not set

// ─── Auth ─────────────────────────────────────────────────────────────────────
const authHeader = "Basic " + Buffer.from(`${EMAIL}:${API_TOKEN}`).toString("base64");

const confluenceV2 = axios.create({
  baseURL: `${BASE_URL}/wiki/api/v2`,
  headers: {
    Authorization: authHeader,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

// ─── Cached values (resolved once at startup) ─────────────────────────────────
let _cachedSpaceId   = SPACE_ID ? String(SPACE_ID) : null;
let _cachedParentId  = null;   // space homepageId — required by v2 POST /pages

// ─── Step 1: Resolve numeric spaceId ─────────────────────────────────────────
async function getSpaceId() {
  if (_cachedSpaceId) return _cachedSpaceId;

  if (!SPACE_KEY) {
    throw new Error(
      "Set SPACE_ID=327691 in your env (the numeric 'System key' from Confluence → Space Settings)."
    );
  }

  console.log(`🔍 Resolving spaceId for key "${SPACE_KEY}" via v1...`);
  try {
    const res = await axios.get(
      `${BASE_URL}/wiki/rest/api/space/${encodeURIComponent(SPACE_KEY)}`,
      { headers: { Authorization: authHeader, Accept: "application/json" } }
    );
    _cachedSpaceId = String(res.data.id);
    console.log(`✅ spaceId resolved: ${_cachedSpaceId}`);
    return _cachedSpaceId;
  } catch (err) {
    throw new Error(
      `v1 key lookup failed (HTTP ${err.response?.status}). ` +
      `Set SPACE_ID env var directly instead.`
    );
  }
}

// ─── Step 2: Resolve space homepageId (required as parentId for new pages) ───
//
// WHY: Confluence v2 POST /pages returns 404 if parentId is omitted.
// Every space has a homepage (root page). We fetch it from the space object
// and use it as the parent for all release wiki pages.
//
async function getParentId() {
  if (_cachedParentId) return _cachedParentId;

  const spaceId = await getSpaceId();
  console.log(`🔍 Fetching homepageId for space ${spaceId}...`);

  const res = await confluenceV2.get(`/spaces/${spaceId}`);
  const homepageId = res.data.homepageId;

  if (!homepageId) {
    throw new Error(
      `Space ${spaceId} has no homepageId. ` +
      `This can happen if the space was just created and has no root page yet. ` +
      `Create a page manually in the space first, then retry.`
    );
  }

  _cachedParentId = String(homepageId);
  console.log(`✅ parentId (homepageId): ${_cachedParentId}`);
  return _cachedParentId;
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

// ─── Webhook handler ──────────────────────────────────────────────────────────
app.post("/jira-webhook", async (req, res) => {
  console.log("🔥 WEBHOOK HIT");
  console.log("📦 BODY:", JSON.stringify(req.body, null, 2));

  try {
    const data = req.body;

    // ── 1. Extract release label ──────────────────────────────────────────────
    const labels    = data.labels || [];
    const labelList = Array.isArray(labels)
      ? labels
      : String(labels).split(",").map((l) => l.trim());

    const release = labelList.find((l) => l.includes("release-"));
    if (!release) {
      console.log("❌ No release label found:", labelList);
      return res.status(200).send("No release label — nothing to do.");
    }

    const releaseName = release.trim();
    const pageTitle   = `${releaseName} - CMS Wiki`;
    console.log("📄 Target page:", pageTitle);

    // ── 2. Resolve spaceId + parentId (cached after first call) ──────────────
    const spaceId  = await getSpaceId();
    const parentId = await getParentId();

    // ── 3. Search for existing page ───────────────────────────────────────────
    const searchRes = await confluenceV2.get("/pages", {
      params: { spaceId, title: pageTitle, "body-format": "storage", limit: 1 },
    });

    let pageId, currentBody, currentVersion;

    if (searchRes.data.results.length === 0) {
      // ── 4a. Create page (parentId is REQUIRED by v2 — omitting it = 404) ───
      console.log("🆕 Creating new page...");

      const createRes = await confluenceV2.post("/pages", {
        spaceId,
        parentId,          // ← THE FIX: space homepage as parent
        status: "current",
        title:  pageTitle,
        body:   { representation: "storage", value: createTableHTML() },
      });

      pageId         = createRes.data.id;
      currentBody    = createRes.data.body.storage.value;
      currentVersion = createRes.data.version.number;
      console.log(`✅ Page created — id: ${pageId}, version: ${currentVersion}`);

    } else {
      // ── 4b. Fetch existing page ───────────────────────────────────────────
      console.log("📄 Page exists — fetching...");
      pageId = searchRes.data.results[0].id;

      const fullPageRes = await confluenceV2.get(`/pages/${pageId}`, {
        params: { "body-format": "storage" },
      });
      currentBody    = fullPageRes.data.body.storage.value;
      currentVersion = fullPageRes.data.version.number;
      console.log(`📝 Fetched — version: ${currentVersion}`);
    }

    // ── 5. Build and inject new table row ─────────────────────────────────────
    const safe = (v) =>
      String(v || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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

    if (!currentBody.includes("</tbody>")) {
      throw new Error("Page body missing </tbody> — table template may be malformed.");
    }
    const updatedBody = currentBody.replace("</tbody>", `${newRow}\n</tbody>`);

    // ── 6. Update page ────────────────────────────────────────────────────────
    console.log("🔄 Updating page...");
    await confluenceV2.put(`/pages/${pageId}`, {
      id:      pageId,
      status:  "current",
      title:   pageTitle,
      version: { number: currentVersion + 1 },
      body:    { representation: "storage", value: updatedBody },
    });

    console.log("🎉 SUCCESS — row added.");
    res.status(200).send("✅ Done");

  } catch (err) {
    const detail = err.response?.data ?? err.message;
    console.error("❌ ERROR:", JSON.stringify(detail, null, 2));
    res.status(500).json({ error: "Internal error", detail });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🌍 Server running on port ${PORT}`);
  // Eagerly warm up both cached values at startup
  getParentId().catch((err) =>
    console.warn("⚠️  Startup pre-fetch failed:", err.message)
  );
});