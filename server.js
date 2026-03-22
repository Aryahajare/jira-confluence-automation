import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT      = process.env.PORT      || 5000;
const EMAIL     = process.env.EMAIL;
const API_TOKEN = process.env.API_TOKEN;
const BASE_URL  = process.env.BASE_URL;   // e.g. https://your-org.atlassian.net
const SPACE_KEY = process.env.SPACE_KEY;  // e.g. "REL"  (fallback only)
const SPACE_ID  = process.env.SPACE_ID;   // e.g. "327691" ← set this directly!

// ─── Auth header ─────────────────────────────────────────────────────────────
const authHeader = "Basic " + Buffer.from(`${EMAIL}:${API_TOKEN}`).toString("base64");

const confluenceV2 = axios.create({
  baseURL: `${BASE_URL}/wiki/api/v2`,
  headers: {
    Authorization: authHeader,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

// ─── Space ID resolution ─────────────────────────────────────────────────────
//
// The Confluence v2 API requires a NUMERIC spaceId (e.g. "327691").
// You can find this on: Confluence → Space Settings → scroll to "System key".
//
// ✅ Best:     set  SPACE_ID=327691  in your env — used directly, no API call.
// ⚠️  Fallback: if only SPACE_KEY is set we try the v1 lookup, but this can
//              return 404 for spaces created on newer Confluence Cloud tenants.

let _cachedSpaceId = SPACE_ID ? String(SPACE_ID) : null;

async function getSpaceId() {
  if (_cachedSpaceId) {
    console.log(`✅ spaceId: ${_cachedSpaceId}`);
    return _cachedSpaceId;
  }

  if (!SPACE_KEY) {
    throw new Error(
      "No SPACE_ID or SPACE_KEY env var set. " +
      "Add SPACE_ID=327691 to your environment (find it under Confluence → Space Settings → System key)."
    );
  }

  console.log(`🔍 SPACE_ID not set — falling back to v1 key lookup for "${SPACE_KEY}"...`);
  try {
    const res = await axios.get(
      `${BASE_URL}/wiki/rest/api/space/${encodeURIComponent(SPACE_KEY)}`,
      { headers: { Authorization: authHeader, Accept: "application/json" } }
    );
    _cachedSpaceId = String(res.data.id);
    console.log(`✅ Resolved spaceId via key: ${_cachedSpaceId}`);
    return _cachedSpaceId;
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.message || err.message;
    throw new Error(
      `v1 key lookup failed (HTTP ${status}): ${msg}. ` +
      `→ Fix: set SPACE_ID=327691 in your env (the "System key" from Confluence Space Settings).`
    );
  }
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
      console.log("❌ No release label found in:", labelList);
      return res.status(200).send("No release label — nothing to do.");
    }

    const releaseName = release.trim();
    const pageTitle   = `${releaseName} - CMS Wiki`;
    console.log("📄 Target page:", pageTitle);

    // ── 2. Get numeric spaceId ────────────────────────────────────────────────
    const spaceId = await getSpaceId();

    // ── 3. Search for existing page ───────────────────────────────────────────
    const searchRes = await confluenceV2.get("/pages", {
      params: { spaceId, title: pageTitle, "body-format": "storage", limit: 1 },
    });

    let pageId, currentBody, currentVersion;

    if (searchRes.data.results.length === 0) {
      // ── 4a. Create new page ─────────────────────────────────────────────────
      console.log("🆕 Creating new page...");
      const createRes = await confluenceV2.post("/pages", {
        spaceId,
        status: "current",
        title:  pageTitle,
        body:   { representation: "storage", value: createTableHTML() },
      });
      pageId         = createRes.data.id;
      currentBody    = createRes.data.body.storage.value;
      currentVersion = createRes.data.version.number;
      console.log(`✅ Created — id: ${pageId}, version: ${currentVersion}`);

    } else {
      // ── 4b. Fetch existing page body ────────────────────────────────────────
      console.log("📄 Page exists — fetching...");
      pageId = searchRes.data.results[0].id;
      const fullPageRes = await confluenceV2.get(`/pages/${pageId}`, {
        params: { "body-format": "storage" },
      });
      currentBody    = fullPageRes.data.body.storage.value;
      currentVersion = fullPageRes.data.version.number;
      console.log(`📝 Fetched — version: ${currentVersion}`);
    }

    // ── 5. Inject new table row ───────────────────────────────────────────────
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
      throw new Error("Page body missing </tbody> — the table template may be malformed.");
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

    console.log("🎉 SUCCESS");
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
  getSpaceId().catch((err) =>
    console.warn("⚠️  spaceId pre-fetch failed:", err.message)
  );
});