import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ─── ENV ─────────────────────────────────────────
const PORT = process.env.PORT || 5000;
const EMAIL = process.env.EMAIL;
const API_TOKEN = process.env.API_TOKEN;
const BASE_URL = process.env.BASE_URL;

const SPACE_KEY = "REL"; // ✅ HARD CODED

if (!EMAIL || !API_TOKEN || !BASE_URL) {
  console.error("❌ Missing ENV variables");
  process.exit(1);
}

// ─── AUTH ────────────────────────────────────────
const authHeader =
  "Basic " + Buffer.from(`${EMAIL}:${API_TOKEN}`).toString("base64");

const headers = {
  Authorization: authHeader,
  Accept: "application/json",
  "Content-Type": "application/json",
  "User-Agent": "curl/7.88.1",
};

// ─── AXIOS CLIENTS ───────────────────────────────
const confluence = axios.create({
  baseURL: `${BASE_URL}/wiki/rest/api`,
  headers,
});

const jira = axios.create({
  baseURL: `${BASE_URL}/rest/api/3`,
  headers,
});

// ─── LOGGER ──────────────────────────────────────
async function api(label, client, method, url, payload, params) {
  console.log(`\n──────── ${label} ────────`);
  console.log(`${method.toUpperCase()} ${url}`);
  if (params) console.log("PARAMS:", params);
  if (payload) console.log("PAYLOAD:", JSON.stringify(payload, null, 2));

  try {
    const res = await client.request({
      method,
      url,
      data: payload,
      params,
    });

    console.log("✅ STATUS:", res.status);
    return res.data;
  } catch (err) {
    console.error("❌ ERROR:", err.response?.data || err.message);
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

// ─── FETCH FEED URL FROM WEB LINKS ───────────────
async function getFeedUrls(issueKey) {
  try {
    const res = await api(
      "GET REMOTE LINKS",
      jira,
      "get",
      `/issue/${issueKey}/remotelink`
    );

    const urls = res
      .filter((l) =>
        l.object?.title?.toLowerCase().includes("feed url")
      )
      .map((l) => l.object?.url)
      .filter(Boolean);

    console.log("✅ Feed URLs:", urls);

    return urls.join("<br/>") || "N/A";
  } catch (err) {
    console.error("❌ Feed URL fetch failed");
    return "N/A";
  }
}

// ─── WEBHOOK ─────────────────────────────────────
app.post("/jira-webhook", async (req, res) => {
  console.log("\n🔥 WEBHOOK HIT");
  console.log("📦 Payload:", JSON.stringify(req.body, null, 2));

  try {
    const data = req.body;

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
    } = data;

    if (!fixVersion) {
      return res.send("No fixVersion");
    }

    const pageTitle = `${fixVersion} - CMS Release`;

    const pid = portfolioEpic
      ? portfolioEpic.split(":")[0].trim()
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

    // ─── SEARCH PAGE ─────────────────────────────
    const search = await api(
      "SEARCH PAGE",
      confluence,
      "get",
      "/content",
      null,
      {
        spaceKey: SPACE_KEY,
        title: pageTitle,
        expand: "version,body.storage",
        limit: 1,
      }
    );

    let pageId, version, body;

    if (search.results.length === 0) {
      console.log("🆕 Creating page...");

      const created = await api(
        "CREATE PAGE",
        confluence,
        "post",
        "/content",
        {
          type: "page",
          title: pageTitle,
          space: { key: SPACE_KEY },
          body: {
            storage: {
              value: createTable(),
              representation: "storage",
            },
          },
        }
      );

      pageId = created.id;
      version = 1;
      body = createTable();
    } else {
      console.log("📄 Page exists");

      const page = search.results[0];
      pageId = page.id;
      version = page.version.number;
      body = page.body.storage.value;
    }

    // ─── APPEND ROW ─────────────────────────────
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

    const updatedBody = body.replace("</tbody>", `${row}</tbody>`);

    // ─── UPDATE PAGE ────────────────────────────
    await api("UPDATE PAGE", confluence, "put", `/content/${pageId}`, {
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