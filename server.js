import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 5000;

const EMAIL     = process.env.EMAIL;
const API_TOKEN = process.env.API_TOKEN;
const BASE_URL  = process.env.BASE_URL;   // e.g. https://your-org.atlassian.net
const SPACE_KEY = process.env.SPACE_KEY;  // e.g. "CMS" or "~username"

// ─── Auth header ────────────────────────────────────────────────────────────
const authHeader = "Basic " + Buffer.from(`${EMAIL}:${API_TOKEN}`).toString("base64");

const confluenceV2 = axios.create({
  baseURL: `${BASE_URL}/wiki/api/v2`,
  headers: {
    Authorization: authHeader,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

// ─── Cache spaceId so we only resolve it once per server lifetime ────────────
let resolvedSpaceId = null;

/**
 * Resolve SPACE_KEY → numeric spaceId using the v2 /spaces endpoint.
 * The v2 API requires spaceId (number), NOT spaceKey (string).
 */
async function getSpaceId() {
  if (resolvedSpaceId) return resolvedSpaceId;

  console.log(`🔍 Resolving spaceId for key: ${SPACE_KEY}`);

  const res = await confluenceV2.get("/spaces", {
    params: { keys: SPACE_KEY, limit: 1 },
  });

  const results = res.data?.results;
  if (!results || results.length === 0) {
    throw new Error(
      `❌ Space with key "${SPACE_KEY}" not found. ` +
      `Check your SPACE_KEY env var and that the API token has access to that space.`
    );
  }

  resolvedSpaceId = results[0].id; // numeric string, e.g. "12345678"
  console.log(`✅ Resolved spaceId: ${resolvedSpaceId}`);
  return resolvedSpaceId;
}

// ─── Table template (Confluence storage format) ──────────────────────────────
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
</table>
`.trim();

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("✅ Backend running"));

// ─── Webhook handler ─────────────────────────────────────────────────────────
app.post("/jira-webhook", async (req, res) => {
  console.log("🔥 WEBHOOK HIT");
  console.log("📦 BODY:", JSON.stringify(req.body, null, 2));

  try {
    const data = req.body;

    // ── 1. Extract release label ─────────────────────────────────────────────
    const labels = data.labels || [];
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
    console.log("📄 Target page title:", pageTitle);

    // ── 2. Resolve spaceId (v2 requires numeric ID, not key string) ──────────
    const spaceId = await getSpaceId();

    // ── 3. Search for an existing page by title + spaceId ───────────────────
    //    v2 endpoint: GET /wiki/api/v2/pages?spaceId=...&title=...&body-format=storage
    const searchRes = await confluenceV2.get("/pages", {
      params: {
        spaceId,
        title: pageTitle,
        "body-format": "storage",
        limit: 1,
      },
    });

    let pageId, currentBody, currentVersion;

    if (searchRes.data.results.length === 0) {
      // ── 4a. Page doesn't exist — create it ──────────────────────────────
      console.log("🆕 Page not found — creating...");

      const createRes = await confluenceV2.post("/pages", {
        spaceId,          // ← numeric ID (required by v2)
        status: "current",
        title: pageTitle,
        body: {
          representation: "storage",
          value: createTableHTML(),
        },
      });

      pageId         = createRes.data.id;
      currentBody    = createRes.data.body.storage.value;
      currentVersion = createRes.data.version.number;
      console.log(`✅ Page created — id: ${pageId}, version: ${currentVersion}`);

    } else {
      // ── 4b. Page exists — fetch full body + version ──────────────────────
      console.log("📄 Page found — fetching full content...");

      pageId = searchRes.data.results[0].id;

      // v2 expand for body uses body-format=storage, NOT expand=body.storage
      const fullPageRes = await confluenceV2.get(`/pages/${pageId}`, {
        params: { "body-format": "storage" },
      });

      currentBody    = fullPageRes.data.body.storage.value;
      currentVersion = fullPageRes.data.version.number;
      console.log(`📝 Page fetched — version: ${currentVersion}`);
    }

    // ── 5. Build and inject the new table row ────────────────────────────────
    const safeText = (val) =>
      String(val || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const newRow = `
<tr>
  <td><p>${safeText(data.ticketId)}</p></td>
  <td><p>${safeText(data.summary)}</p></td>
  <td><p>${safeText(data.assignee) || "Unassigned"}</p></td>
  <td><p>${safeText(data.reporter)}</p></td>
  <td><p>${safeText(data.stageOnly) || "false"}</p></td>
  <td><p><a href="${data.link || "#"}">View</a></p></td>
</tr>`.trim();

    // Inject before the closing </tbody> tag
    if (!currentBody.includes("</tbody>")) {
      throw new Error("Page body does not contain a </tbody> tag — template may be malformed.");
    }
    const updatedBody = currentBody.replace("</tbody>", `${newRow}\n</tbody>`);

    // ── 6. Update the page (v2 PUT) ──────────────────────────────────────────
    console.log("🔄 Updating page...");

    await confluenceV2.put(`/pages/${pageId}`, {
      id:      pageId,
      status:  "current",
      title:   pageTitle,
      version: { number: currentVersion + 1 },  // ← must increment by exactly 1
      body: {
        representation: "storage",
        value: updatedBody,
      },
    });

    console.log("🎉 SUCCESS — row added to Confluence page.");
    res.status(200).send("✅ Done");

  } catch (err) {
    const detail = err.response?.data ?? err.message;
    console.error("❌ ERROR:", JSON.stringify(detail, null, 2));
    res.status(500).json({ error: "Internal error", detail });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🌍 Server running on port ${PORT}`);
  // Eagerly resolve spaceId at startup so the first webhook is fast
  getSpaceId().catch((err) =>
    console.warn("⚠️  Could not pre-resolve spaceId at startup:", err.message)
  );
});