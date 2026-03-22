import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT      = process.env.PORT      || 5000;
const EMAIL     = process.env.EMAIL;
const API_TOKEN = process.env.API_TOKEN;
const BASE_URL  = process.env.BASE_URL;   // e.g. https://your-org.atlassian.net
const SPACE_KEY = process.env.SPACE_KEY;  // e.g. "REL"  ← REQUIRED

// ─── Auth ─────────────────────────────────────────────────────────────────────
const authHeader = "Basic " + Buffer.from(`${EMAIL}:${API_TOKEN}`).toString("base64");

// v1 client — used ONLY for the one-time space bootstrap (spaceId + homepageId)
const confluenceV1 = axios.create({
  baseURL: `${BASE_URL}/wiki/rest/api`,
  headers: { Authorization: authHeader, Accept: "application/json" },
});

// v2 client — used for all page operations (search, create, update)
const confluenceV2 = axios.create({
  baseURL: `${BASE_URL}/wiki/api/v2`,
  headers: {
    Authorization: authHeader,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

// ─── Cached bootstrap values (resolved once at startup) ──────────────────────
//
// STRATEGY:
//   GET /wiki/rest/api/space/{key}?expand=homepage  (v1)
//   → returns both:
//       .id          → numeric spaceId   (needed for v2 page search/create)
//       .homepage.id → numeric pageId    (needed as parentId for v2 POST /pages)
//
//   The v2 /spaces/{id} endpoint returns 404 because the "System key" shown
//   in Confluence UI (e.g. 327691) is NOT the internal API space ID used by
//   the v2 spaces endpoint. Only the v1 endpoint reliably maps key → both IDs.
//
let _spaceId   = null;
let _parentId  = null;

async function bootstrap() {
  if (_spaceId && _parentId) return;

  if (!SPACE_KEY) {
    throw new Error("SPACE_KEY env var is required (e.g. SPACE_KEY=REL).");
  }

  console.log(`🔍 Bootstrapping space "${SPACE_KEY}"...`);

  let res;
  try {
    res = await confluenceV1.get(`/space/${encodeURIComponent(SPACE_KEY)}`, {
      params: { expand: "homepage" },
    });
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.message || err.message;
    throw new Error(
      `Failed to bootstrap space "${SPACE_KEY}" (HTTP ${status}): ${msg}\n` +
      `Check that SPACE_KEY, EMAIL, API_TOKEN, and BASE_URL are all correct.`
    );
  }

  const space = res.data;

  if (!space.id) {
    throw new Error(`Space "${SPACE_KEY}" response missing 'id' field.`);
  }
  if (!space.homepage?.id) {
    throw new Error(
      `Space "${SPACE_KEY}" has no homepage. ` +
      `Please create at least one page in the space manually, then restart the server.`
    );
  }

  _spaceId  = String(space.id);
  _parentId = String(space.homepage.id);

  console.log(`✅ spaceId:   ${_spaceId}`);
  console.log(`✅ parentId:  ${_parentId}  (space homepage)`);
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

    // ── 2. Bootstrap (cached after first call) ────────────────────────────────
    await bootstrap();
    const spaceId  = _spaceId;
    const parentId = _parentId;

    // ── 3. Search for existing page ───────────────────────────────────────────
    const searchRes = await confluenceV2.get("/pages", {
      params: { spaceId, title: pageTitle, "body-format": "storage", limit: 1 },
    });

    let pageId, currentBody, currentVersion;

    if (searchRes.data.results.length === 0) {
      // ── 4a. Create new page ───────────────────────────────────────────────
      console.log("🆕 Creating new page...");

      const createRes = await confluenceV2.post("/pages", {
        spaceId,
        parentId,           // ← required; omitting this causes 404
        status:  "current",
        title:   pageTitle,
        body:    { representation: "storage", value: createTableHTML() },
      });

      pageId         = createRes.data.id;
      currentBody    = createRes.data.body.storage.value;
      currentVersion = createRes.data.version.number;
      console.log(`✅ Page created — id: ${pageId}, version: ${currentVersion}`);

    } else {
      // ── 4b. Fetch existing page ──────────────────────────────────────────
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
  // Pre-warm the bootstrap cache at startup so first webhook is instant
  bootstrap().catch((err) =>
    console.warn("⚠️  Startup bootstrap failed:", err.message)
  );
});