import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";

const app = express();
app.use(express.json());

// ─── ENV ─────────────────────────────────────────
const PORT = process.env.PORT || 5000;
const EMAIL = process.env.EMAIL;
const API_TOKEN = process.env.API_TOKEN;
const BASE_URL = process.env.BASE_URL;

const SPACE_ID = "327691";

// ─── AUTH ────────────────────────────────────────
const authHeader =
  "Basic " + Buffer.from(`${EMAIL}:${API_TOKEN}`).toString("base64");

const headers = {
  Authorization: authHeader,
  Accept: "application/json",
  "Content-Type": "application/json",
  "User-Agent": "jira-confluence-bot/1.0",
};

// ─── AXIOS CLIENTS ───────────────────────────────
const confluence = axios.create({
  baseURL: `${BASE_URL}/wiki/rest/api`,
  headers,
  timeout: 15000,
});

const jira = axios.create({
  baseURL: `${BASE_URL}/rest/api/3`,
  headers,
  timeout: 15000,
});

// ─── LOGGER ──────────────────────────────────────
async function api(label, config) {
  const start = Date.now();

  console.log(`\n════════ ${label} ════════`);
  console.log("➡️", config.method.toUpperCase(), config.baseURL + config.url);

  try {
    const res = await axios(config);
    console.log("✅ STATUS:", res.status, "| ⏱️", Date.now() - start, "ms");
    return res.data;
  } catch (err) {
    console.error("❌ ERROR:", err.response?.status);
    throw err;
  }
}

// ─── TABLE TEMPLATE ──────────────────────────────
const createTable = () => `
<table>
<tbody>
<tr>
<th>SB/Acquia</th>
<th>Stage Only</th>
<th>CI Link</th>
<th>PID</th>
<th>Description</th>
<th>DEV Contact</th>
<th>CI Contact</th>
<th>Feed URL</th>
<th>Deployment Date</th>
<th>CMS Release name</th>
<th>Validation Status</th>
</tr>
</tbody>
</table>
`.trim();

// ─── FETCH FEED URLS ─────────────────────────────
async function getFeedUrls(issueKey) {
  try {
    const res = await api("GET REMOTE LINKS", {
      method: "get",
      baseURL: `${BASE_URL}/rest/api/3`,
      url: `/issue/${issueKey}/remotelink`,
      headers,
    });

    const urls = res
      .filter((l) => {
        const isConfluence =
          l.application?.type === "com.atlassian.confluence";

        const isFeed =
          l.object?.title?.toLowerCase().includes("feed");

        return !isConfluence && isFeed;
      })
      .map((l) => l.object?.url)
      .filter(Boolean);

    if (!urls.length) return "N/A";

    // ✅ Each URL as clickable link + new line
    return urls
      .map((url) => `<a href="${url}">${url}</a>`)
      .join("<br/>");

  } catch (err) {
    console.error("❌ FEED URL FETCH FAILED");
    return "N/A";
  }
}

// ─── WEBHOOK ─────────────────────────────────────
app.post("/jira-webhook", async (req, res) => {
  console.log("\n🔥 WEBHOOK HIT");

  try {
    const data = req.body;

    const pageTitle = `${data.fixVersion} - CMS Release`;

    // SB extraction
    const sbMatch = data.title.match(/\[(.*?)\]/);
    const sb = sbMatch ? sbMatch[1] : "";

    // PID extraction
    const pid = data.portfolioEpic
      ? data.portfolioEpic.split(":")[0].trim()
      : "";

    const feedURL = await getFeedUrls(data.ticketId);

    // ─── FETCH PAGE ─────────────────────────────
    const search = await api("FETCH PAGES", {
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

    const page = search.results.find(
      (p) => p.title.trim() === pageTitle.trim()
    );

    let pageId, version, body;

    if (!page) {
      console.log("🆕 CREATING PAGE");

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
      pageId = page.id;
      version = page.version.number;
      body = page.body.storage.value;
    }

    // ─── CHEERIO PARSE ──────────────────────────
    const $ = cheerio.load(body);

    const ciLinkHTML = `<a href="${data.jiraLink}">${data.jiraLink}</a>`;

    const newRow = `
<tr>
<td>${sb}</td>
<td>${data.stageOnly}</td>
<td>${ciLinkHTML}</td>
<td>${pid}</td>
<td>${data.title}</td>
<td>${data.reporter}</td>
<td>${data.assignee}</td>
<td>${feedURL}</td>
<td>${data.stageDeploymentDate}</td>
  <td></td>
  <td></td>
</tr>
`;

    let updated = false;

    $("tbody tr").each((i, el) => {
      const rowText = $(el).text();

      if (rowText.includes(data.ticketId)) {
        console.log("♻️ UPDATING EXISTING ROW");
        $(el).replaceWith(newRow);
        updated = true;
      }
    });

    if (!updated) {
      console.log("🆕 ADDING NEW ROW");
      $("tbody").append(newRow);
    }

    const updatedBody = $.html();

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

    console.log("🎉 SUCCESS");
    res.send("Done");

  } catch (err) {
    console.error("❌ WEBHOOK FAILED");
    res.status(500).send("Error");
  }
});

// ─── START ──────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});