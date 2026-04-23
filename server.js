import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ─── ENV ─────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
const EMAIL = process.env.EMAIL;
const API_TOKEN = process.env.API_TOKEN;
const BASE_URL = process.env.BASE_URL; // https://your-domain.atlassian.net
const SPACE_KEY = process.env.SPACE_KEY || "REL";

if (!EMAIL || !API_TOKEN || !BASE_URL) {
  console.error("❌ Missing ENV variables");
  process.exit(1);
}

console.log("🚀 CONFIG:", { BASE_URL, SPACE_KEY });

// ─── AUTH ────────────────────────────────────────────
const authHeader =
  "Basic " + Buffer.from(`${EMAIL}:${API_TOKEN}`).toString("base64");

const headers = {
  Authorization: authHeader,
  Accept: "application/json",
  "Content-Type": "application/json",
};

// ─── CLIENTS ─────────────────────────────────────────
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

// ─── LOGGER ──────────────────────────────────────────
async function api(label, client, method, url, data, params) {
  console.log(`\n──────── ${label} ────────`);
  console.log(`${method.toUpperCase()} ${url}`);
  if (params) console.log("PARAMS:", params);
  if (data) console.log("PAYLOAD:", JSON.stringify(data, null, 2));

  try {
    const res = await client.request({ method, url, data, params });
    console.log(`✅ STATUS: ${res.status}`);
    return res.data;
  } catch (err) {
    console.error("❌ ERROR:", err.response?.data || err.message);
    throw err;
  }
}

// ─── TABLE TEMPLATE ──────────────────────────────────
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
      <th>Deployment Status (Stage)</th>
    </tr>
  </tbody>
</table>
`.trim();

// ─── GET FEED URL (WEB LINKS) ────────────────────────
async function getFeedUrls(issueKey) {
  console.log(`🔗 Fetching Feed URL for ${issueKey}`);

  try {
    const res = await api(
      "GET REMOTE LINKS",
      jira,
      "get",
      `/issue/${issueKey}/remotelink`
    );

    const links = res
      .filter((l) =>
        String(l.object?.title || "").toLowerCase().includes("feed url")
      )
      .map((l) => l.object?.url)
      .filter(Boolean);

    console.log("✅ Feed URLs:", links);

    return links.length ? links.join("<br/>") : "N/A";
  } catch (err) {
    console.error("❌ Failed to fetch Feed URL");
    return "N/A";
  }
}

// ─── FIND PAGE ───────────────────────────────────────
async function findPage(title) {
  const res = await api(
    "SEARCH PAGE",
    confluence,
    "get",
    "/content",
    null,
    {
      spaceKey: SPACE_KEY,
      title,
      expand: "version,body.storage",
      limit: 1,
    }
  );

  return res.results || [];
}

// ─── CREATE PAGE ─────────────────────────────────────
async function createPage(title) {
  const payload = {
    type: "page",
    title,
    space: { key: SPACE_KEY },
    body: {
      storage: {
        value: createTableHTML(),
        representation: "storage",
      },
    },
  };

  const res = await api("CREATE PAGE", confluence, "post", "/content", payload);

  return {
    id: res.id,
    version: 1,
    body: createTableHTML(),
  };
}

// ─── UPDATE PAGE ─────────────────────────────────────
async function updatePage(id, title, version, body) {
  const payload = {
    id,
    type: "page",
    title,
    version: { number: version + 1 },
    body: {
      storage: {
        value: body,
        representation: "storage",
      },
    },
  };

  await api("UPDATE PAGE", confluence, "put", `/content/${id}`, payload);
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
      stageDeploymentDate,
    } = req.body;

    if (!fixVersion) {
      console.log("⏭ No fixVersion → skipping");
      return res.send("Skipped");
    }

    // ─── DERIVED VALUES ─────────────────────────────
    const pageTitle = `${fixVersion} - CMS Release`;

    const pid = portfolioEpic
      ? String(portfolioEpic).split(":")[0].trim()
      : "";

    const sbMatch = title.match(/\[(.*?)\]/);
    const sb = sbMatch ? sbMatch[1] : "";

    const feedURL = await getFeedUrls(ticketId);

    console.log("📊 Processed:", {
      pageTitle,
      pid,
      sb,
      feedURL,
    });

    // ─── FIND OR CREATE PAGE ───────────────────────
    let pageId, version, body;

    const pages = await findPage(pageTitle);

    if (pages.length === 0) {
      console.log("🆕 Creating new page");
      const created = await createPage(pageTitle);
      pageId = created.id;
      version = created.version;
      body = created.body;
    } else {
      console.log("📄 Page exists");
      const page = pages[0];
      pageId = page.id;
      version = page.version.number;
      body = page.body.storage.value;
    }

    // ─── BUILD ROW ─────────────────────────────────
    const newRow = `
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

    if (!body.includes("</tbody>")) {
      body = createTableHTML();
    }

    const updatedBody = body.replace("</tbody>", `${newRow}</tbody>`);

    // ─── UPDATE PAGE ───────────────────────────────
    await updatePage(pageId, pageTitle, version, updatedBody);

    console.log("🎉 SUCCESS");
    res.send("Done");
  } catch (err) {
    console.error("❌ WEBHOOK FAILED:", err.message);
    res.status(500).send("Error");
  }
});

// ─── HEALTH ──────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("✅ Server running");
});

// ─── START ───────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});