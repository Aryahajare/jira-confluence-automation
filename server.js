import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ─── ENV ─────────────────────────────────────────
const PORT = process.env.PORT || 5000;
const EMAIL = process.env.EMAIL;
const API_TOKEN = process.env.API_TOKEN;
const BASE_URL = process.env.BASE_URL;

const SPACE_ID = "327691"; // ✅ ONLY TRUST THIS

// ─── AUTH ────────────────────────────────────────
const authHeader =
  "Basic " + Buffer.from(`${EMAIL}:${API_TOKEN}`).toString("base64");

const headers = {
  Authorization: authHeader,
  Accept: "application/json",
  "Content-Type": "application/json",
  "User-Agent": "curl/7.88.1",
};

// ─── AXIOS CLIENT ────────────────────────────────
const confluence = axios.create({
  baseURL: `${BASE_URL}/wiki/rest/api`,
  headers,
  timeout: 15000,
});

// ─── ADVANCED LOGGER ─────────────────────────────
async function api(label, config) {
  const start = Date.now();

  console.log(`\n════════ ${label} ════════`);
  console.log("➡️ METHOD:", config.method.toUpperCase());
  console.log("➡️ URL:", config.baseURL + config.url);
  console.log("➡️ PARAMS:", config.params);
  console.log("➡️ HEADERS:", config.headers);

  try {
    const res = await axios(config);

    console.log("✅ STATUS:", res.status);
    console.log("⏱️ TIME:", Date.now() - start, "ms");

    console.log("📦 RESPONSE META:", {
      size: JSON.stringify(res.data).length,
      keys: Object.keys(res.data),
    });

    return res.data;
  } catch (err) {
    console.error("❌ ERROR STATUS:", err.response?.status);
    console.error("❌ ERROR HEADERS:", err.response?.headers);

    if (typeof err.response?.data === "string") {
      console.error("❌ RAW HTML ERROR (CloudFront likely):");
      console.error(err.response.data.substring(0, 500));
    } else {
      console.error("❌ JSON ERROR:", err.response?.data);
    }

    console.error("⏱️ FAILED AFTER:", Date.now() - start, "ms");

    throw err;
  }
}

// ─── TABLE TEMPLATE ──────────────────────────────
const createTable = () => `
<table>
<tbody>
<tr>
<th>SB</th>
<th>Stage Only</th>
<th>CI Link</th>
<th>PID</th>
<th>Description</th>
<th>Reporter</th>
<th>Assignee</th>
<th>Feed URL</th>
<th>Deployment Date</th>
</tr>
</tbody>
</table>
`.trim();

// ─── WEBHOOK ─────────────────────────────────────
app.post("/jira-webhook", async (req, res) => {
  console.log("\n🔥 WEBHOOK HIT");
  console.log("📦 Payload:", JSON.stringify(req.body, null, 2));

  try {
    const data = req.body;

    const pageTitle = `${data.fixVersion} - CMS Release`;

    // ─── FETCH ALL PAGES (ONLY WORKING METHOD) ───
    const search = await api("FETCH ALL PAGES", {
      method: "get",
      baseURL: `${BASE_URL}/wiki/rest/api`,
      url: "/content",
      headers,
      params: {
        spaceId: SPACE_ID,
        limit: 100,
        expand: "version,body.storage",
      },
    });

    console.log("📄 TOTAL PAGES:", search.results.length);

    // 🔍 DEBUG: print titles
    search.results.forEach((p, i) => {
      console.log(`📄 [${i}]`, p.title);
    });

    // ─── FIND MATCH ──────────────────────────────
    const page = search.results.find(
      (p) => p.title.trim() === pageTitle.trim()
    );

    let pageId, version, body;

    if (!page) {
      console.log("🆕 PAGE NOT FOUND → CREATING");

      const created = await api("CREATE PAGE", {
        method: "post",
        baseURL: `${BASE_URL}/wiki/rest/api`,
        url: "/content",
        headers,
        data: {
          type: "page",
          title: pageTitle,
          space: { key: "REL" },
          body: {
            storage: {
              value: createTable(),
              representation: "storage",
            },
          },
        },
      });

      pageId = created.id;
      version = 1;
      body = createTable();
    } else {
      console.log("📄 PAGE FOUND:", page.id);

      pageId = page.id;
      version = page.version.number;
      body = page.body.storage.value;
    }

    // ─── APPEND ROW ─────────────────────────────
    const row = `
<tr>
<td>${data.ticketId}</td>
<td>${data.stageOnly}</td>
<td><a href="${data.jiraLink}">${data.ticketId}</a></td>
<td>${data.portfolioEpic}</td>
<td>${data.title}</td>
<td>${data.reporter}</td>
<td>${data.assignee}</td>
<td>N/A</td>
<td>${data.stageDeploymentDate}</td>
</tr>`;

    const updatedBody = body.replace("</tbody>", `${row}</tbody>`);

    // ─── UPDATE PAGE ────────────────────────────
    await api("UPDATE PAGE", {
      method: "put",
      baseURL: `${BASE_URL}/wiki/rest/api`,
      url: `/content/${pageId}`,
      headers,
      data: {
        id: pageId,
        type: "page",
        title: pageTitle,
        version: { number: version + 1 },
        body: {
          storage: {
            value: updatedBody,
            representation: "storage",
          },
        },
      },
    });

    console.log("🎉 SUCCESS FLOW COMPLETE");
    res.send("Done");

  } catch (err) {
    console.error("❌ WEBHOOK FAILED HARD");
    res.status(500).send("Error");
  }
});

// ─── START ──────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});