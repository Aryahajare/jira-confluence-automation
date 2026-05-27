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
// normalize base url to avoid double slashes when concatenating paths
const BASE = (BASE_URL || "").replace(/\/+$/, "");

const SPACE_KEY = process.env.SPACE_KEY || "IE";
const PARENT_TITLE = process.env.PARENT_TITLE || "UF - CMS Release Scope";

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
  baseURL: `${BASE}/wiki/rest/api`,
  headers,
  timeout: 15000,
});

// ─── HELPERS ─────────────────────────────────────
function formatLaunchDate(input) {
  const s = (input ?? "").toString().trim();
  if (!s) return "";
  // Expected incoming format: YYYY-MM-DD — convert to MM.DD.YYYY
  const ymd = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymd) {
    const yyyy = ymd[1];
    const mm = String(ymd[2]).padStart(2, "0");
    const dd = String(ymd[3]).padStart(2, "0");
    return `${mm}.${dd}.${yyyy}`;
  }

  // If already MM.DD.YYYY, pass through
  if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(s)) return s;

  console.warn('formatLaunchDate: unexpected format, using raw value:', s);
  return s;
}

const jira = axios.create({
  baseURL: `${BASE}/rest/api/3`,
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
    if (!issueKey) {
      console.warn('getFeedUrls: no issueKey provided, skipping remote link lookup');
      return "N/A";
    }
    const res = await api("GET REMOTE LINKS", {
      method: "get",
      baseURL: `${BASE}/rest/api/3`,
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

    // Use LaunchDate (new field) for page title; warn if missing
    const launchRaw = (data.LaunchDate ?? "").toString().trim();
    if (!launchRaw) {
      console.warn('Webhook payload missing LaunchDate:', JSON.stringify(data));
      console.log('❌ PAGE CREATION CANCELED: missing LaunchDate');
      return res.status(400).send('Aborted: missing LaunchDate');
    }
    const launch = formatLaunchDate(launchRaw);
    const pageTitle = `${launch} - CMS Release`;

    // SB extraction
    const sbMatch = data.title.match(/\[(.*?)\]/);
    const sb = sbMatch ? sbMatch[1] : "";

    // PID extraction
    const pid = data.portfolioEpic
      ? data.portfolioEpic.split(":")[0].trim()
      : "";

    console.log('Webhook payload stageOnly:', JSON.stringify(data.stageOnly));
    if (!data.ticketId) console.warn('Webhook payload missing ticketId:', JSON.stringify(data));
    const feedURL = await getFeedUrls(data.ticketId);

    // ─── FETCH PAGE / FIND PARENT ─────────────────────────────
    // Find the parent page by title in the configured space key
    const parentSearch = await api("FIND PARENT", {
      method: "get",
      baseURL: `${BASE}/wiki/rest/api`,
      url: "/content",
      headers,
      params: {
        spaceKey: SPACE_KEY,
        title: PARENT_TITLE,
        expand: "version",
      },
    });

    const parent = parentSearch.results?.[0];
    const parentId = parent?.id;

    // Try to find an existing page as a child of the parent first
    let page;

    if (parentId) {
      const children = await api("FETCH CHILD PAGES", {
        method: "get",
        baseURL: `${BASE}/wiki/rest/api`,
        url: `/content/${parentId}/child/page`,
        headers,
        params: {
          limit: 100,
          expand: "version,body.storage",
        },
      });

      page = children.results.find((p) => p.title.trim() === pageTitle.trim());
    }

    // Fallback: search across the space key if not found under parent
    if (!page) {
      const search = await api("FETCH PAGES", {
        method: "get",
        baseURL: `${BASE}/wiki/rest/api`,
        url: "/content",
        headers,
        params: {
          spaceKey: SPACE_KEY,
          limit: 100,
          expand: "version,body.storage",
        },
      });

      page = search.results.find((p) => p.title.trim() === pageTitle.trim());
    }

    let pageId, version, body;

    if (!page) {
      console.log("🆕 CREATING PAGE");

      const createData = {
        type: "page",
        title: pageTitle,
        space: { key: SPACE_KEY },
        body: {
          storage: {
            value: createTable(),
            representation: "storage",
          },
        },
      };

      if (parentId) createData.ancestors = [{ id: parentId }];

      const created = await api("CREATE PAGE", {
        method: "post",
        baseURL: `${BASE}/wiki/rest/api`,
        url: "/content",
        headers,
        data: createData,
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
      baseURL: `${BASE}/wiki/rest/api`,
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