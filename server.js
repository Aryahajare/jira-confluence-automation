import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ─── ENV ─────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
const EMAIL = process.env.EMAIL;
const API_TOKEN = process.env.API_TOKEN;
const BASE_URL = process.env.BASE_URL;

// 🔥 HARD REQUIRED (NO AUTO FETCH)
const SPACE_ID = process.env.SPACE_ID || "9535494";
const PARENT_ID = process.env.PARENT_ID || "9535657";

if (!EMAIL || !API_TOKEN || !BASE_URL) {
  console.error("❌ Missing ENV");
  process.exit(1);
}

console.log("🚀 CONFIG:", {
  BASE_URL,
  SPACE_ID,
  PARENT_ID
});

// ─── AUTH ────────────────────────────────────────────
const authHeader = "Basic " + Buffer.from(`${EMAIL}:${API_TOKEN}`).toString("base64");

const headers = {
  Authorization: authHeader,
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent": "curl/7.88.1",
  "Accept-Encoding": "gzip, deflate, br",
  Connection: "keep-alive",
};

// ─── CLIENTS ─────────────────────────────────────────
const confluence = axios.create({
  baseURL: `${BASE_URL}/wiki/api/v2`,
  headers,
  decompress: true,
  timeout: 10000,
});

const jira = axios.create({
  baseURL: `${BASE_URL}/rest/api/3`,
  headers,
  decompress: true,
  timeout: 10000,
});

confluence.interceptors.request.use((config) => {
  console.log("\n🚀 FINAL REQUEST:");
  console.log("URL:", `${config.baseURL}${config.url}`);
  console.log("HEADERS:", JSON.stringify(config.headers, null, 2));
  return config;
});

// ─── LOGGER ──────────────────────────────────────────
async function api(label, client, method, url, data, params) {
  console.log(`\n──────── ${label} ────────`);
  console.log(`${method.toUpperCase()} ${url}`);
  if (params) console.log("PARAMS:", params);
  if (data) console.log("PAYLOAD:", JSON.stringify(data, null, 2));

  try {
    const res = await client.request({ method, url, data, params });
    console.log("✅ STATUS:", res.status);
    return res.data;
  } catch (err) {
    console.error("❌ ERROR:", err.response?.data || err.message);
    throw err;
  }
}

// ─── TABLE ───────────────────────────────────────────
const createTableHTML = () => `
<table>
  <tbody>
    <tr>
      <th>SB / Acquia</th>
      <th>Stage Only</th>
      <th>CI Dep ID</th>
      <th>PID</th>
      <th>Brief Description</th>
      <th>FE Dev Contact</th>
      <th>CI Contact</th>
      <th>Feed URL</th>
      <th>Deployment Status</th>
    </tr>
  </tbody>
</table>
`.trim();

// ─── GET FEED URL FROM WEB LINKS ─────────────────────
async function getFeedUrls(issueKey) {
  console.log(`🔗 Fetching Feed URL for ${issueKey}`);

  try {
    const links = await api(
      "GET REMOTE LINKS",
      jira,
      "get",
      `/issue/${issueKey}/remotelink`
    );

    const urls = links
      .filter(l => l.object?.title?.toLowerCase() === "feed url")
      .map(l => l.object?.url)
      .filter(Boolean);

    console.log("✅ Feed URLs:", urls);

    return urls.length ? urls.join("<br/>") : "N/A";

  } catch (err) {
    console.error("❌ Feed URL fetch failed");
    return "N/A";
  }
}

// ─── SEARCH PAGE ─────────────────────────────────────
async function findPage(title) {
  const res = await api(
    "SEARCH PAGE",
    confluence,
    "get",
    "/pages",
    null,
    { spaceId: SPACE_ID, limit: 100 }
  );

  return res.results.find(p => p.title === title);
}

// ─── WEBHOOK ─────────────────────────────────────────
app.post("/jira-webhook", async (req, res) => {
  console.log("\n🔥 WEBHOOK HIT");
  console.log("📦 Payload:", JSON.stringify(req.body, null, 2));

  try {
    const {
      ticketId,
      title,
      reporter,
      assignee,
      jiraLink,
      fixVersion,
      portfolioEpic,
      stageOnly,
      stageDeploymentDate
    } = req.body;

    if (!fixVersion) {
      console.log("⏭ No fixVersion → skip");
      return res.send("No fixVersion");
    }

    const pageTitle = `${fixVersion} - CMS Release`;

    // PID
    const pid = portfolioEpic?.split(":")[0]?.trim() || "";

    // SB
    const sb = title.match(/\[(.*?)\]/)?.[1] || "";

    // Feed URL
    const feedURL = await getFeedUrls(ticketId);

    console.log("📊 Processed:", {
      pageTitle,
      pid,
      sb,
      feedURL
    });

    // ─── FIND OR CREATE PAGE ─────────────────────────
    let page = await findPage(pageTitle);

    let pageId, body, version;

    if (!page) {
      console.log("🆕 Creating page");

      const created = await api("CREATE PAGE", confluence, "post", "/pages", {
        spaceId: SPACE_ID,
        parentId: PARENT_ID,
        title: pageTitle,
        status: "current",
        body: {
          representation: "storage",
          value: createTableHTML()
        }
      });

      pageId = created.id;
      version = 1;
      body = createTableHTML();

    } else {
      console.log("📄 Page exists");

      pageId = page.id;

      const full = await api(
        "GET PAGE",
        confluence,
        "get",
        `/pages/${pageId}`,
        null,
        { "body-format": "storage" }
      );

      body = full.body.storage.value;
      version = full.version.number;
    }

    // ─── ADD ROW ─────────────────────────────────────
    const row = `
<tr>
<td>${sb}</td>
<td>${stageOnly}</td>
<td><a href="${jiraLink}">${ticketId}</a></td>
<td>${pid}</td>
<td>${title}</td>
<td>${reporter}</td>
<td>${assignee}</td>
<td>${feedURL}</td>
<td>${stageDeploymentDate}</td>
</tr>
`;

    const updated = body.replace("</tbody>", `${row}</tbody>`);

    // ─── UPDATE PAGE ─────────────────────────────────
    await api("UPDATE PAGE", confluence, "put", `/pages/${pageId}`, {
      id: pageId,
      status: "current",
      title: pageTitle,
      version: { number: version + 1 },
      body: {
        representation: "storage",
        value: updated
      }
    });

    console.log("🎉 SUCCESS");
    res.send("Done");

  } catch (err) {
    console.error("❌ WEBHOOK FAILED");
    res.status(500).send("Error");
  }
});

// ─── START ───────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});