import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ─── ENV ─────────────────────────────────────────────────────────────
const PORT       = process.env.PORT || 5000;
const EMAIL      = process.env.EMAIL;
const API_TOKEN  = process.env.API_TOKEN;
const BASE_URL   = process.env.BASE_URL;
const JIRA_BASE_URL = process.env.JIRA_BASE_URL || BASE_URL;
const CONFLUENCE_BASE_URL = process.env.CONFLUENCE_BASE_URL || BASE_URL;
const SPACE_KEY  = process.env.SPACE_KEY || "REL";
const SPACE_ID   = process.env.SPACE_ID;
const PARENT_ID  = process.env.PARENT_ID;

["EMAIL", "API_TOKEN", "BASE_URL"].forEach((k) => {
  if (!process.env[k]) {
    console.error(`❌ Missing env var: ${k}`);
    process.exit(1);
  }
});

console.log("🚀 Config:", {
  BASE_URL,
  JIRA_BASE_URL,
  CONFLUENCE_BASE_URL,
  SPACE_KEY,
  SPACE_ID,
  PARENT_ID,
});

// ─── AUTH ────────────────────────────────────────────────────────────
const authHeader = "Basic " + Buffer.from(`${EMAIL}:${API_TOKEN}`).toString("base64");

const hdrs = {
  Authorization: authHeader,
  "Content-Type": "application/json",
  Accept: "application/json",
};

// Confluence v2
const v2 = axios.create({
  baseURL: `${CONFLUENCE_BASE_URL}/wiki/api/v2`,
  headers: hdrs,
});

// Confluence v1 fallback
const v1 = axios.create({
  baseURL: `${CONFLUENCE_BASE_URL}/wiki/rest/api`,
  headers: hdrs,
});

// Jira API
const jira = axios.create({
  baseURL: `${JIRA_BASE_URL}/rest/api/3`,
  headers: hdrs,
});

// ─── API LOGGER ──────────────────────────────────────────────────────
async function api(label, client, method, url, payload, params) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`⏳ [${label}] ${method.toUpperCase()} ${url}`);
  if (params) console.log("PARAMS:", params);
  if (payload) console.log("PAYLOAD:", JSON.stringify(payload, null, 2));

  try {
    const res = await client.request({ method, url, data: payload, params });
    console.log(`✅ STATUS: ${res.status}`);
    return res.data;
  } catch (err) {
    console.error(`❌ ERROR:`, err.response?.data || err.message);
    console.error("   CONFIG:", {
      baseURL: err.config?.baseURL,
      url: err.config?.url,
      method: err.config?.method,
    });
    throw err;
  }
}

// ─── BOOTSTRAP ───────────────────────────────────────────────────────
let _spaceId = null;
let _parentId = null;

async function findPage(pageTitle) {
  try {
    const list = await api(
      "SEARCH PAGE",
      v2,
      "get",
      "/pages",
      null,
      {
        spaceId: _spaceId,
        limit: 100,
      }
    );

    const exactMatches = list.results.filter((page) =>
      String(page.title || "").trim() === String(pageTitle || "").trim()
    );

    console.log(`📄 Found ${list.results.length} pages in space; matched ${exactMatches.length} exact title(s)`);
    return { results: exactMatches };
  } catch (err) {
    if (err.response?.status === 403) {
      console.warn("⚠️ Confluence v2 search 403 detected; falling back to REST v1 content search");
      return await api(
        "SEARCH PAGE V1",
        v1,
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
    }
    throw err;
  }
}

async function bootstrapSpace() {
  if (_spaceId && _parentId) return;

  console.log("🚀 Bootstrapping space...");

  if (SPACE_ID) {
    _spaceId = SPACE_ID;
  }

  if (PARENT_ID) {
    _parentId = PARENT_ID;
  }

  if (_spaceId && _parentId) {
    console.log(`✅ spaceId=${_spaceId}, parentId=${_parentId} (from env)`);
    return;
  }

  if (_spaceId && !_parentId) {
    console.log(`⚠️ Using provided space ID ${_spaceId} without parentId; will create page at top-level if needed.`);
    // Verify the space exists and is accessible
    try {
      const spaceCheck = await api(
        "VERIFY SPACE ACCESS",
        v2,
        "get",
        `/spaces/${_spaceId}`,
        null,
        { expand: "name" }
      );
      console.log(`✅ Space verified: ${spaceCheck.name} (${spaceCheck.key})`);
    } catch (err) {
      if (err.response?.status === 404) {
        console.error(`❌ SPACE NOT FOUND: Space ID ${_spaceId} does not exist or you don't have access to it`);
        console.error(`💡 SOLUTION: Check SPACE_ID or grant Confluence access to the API token user`);
      } else if (err.response?.status === 403) {
        console.error(`❌ ACCESS DENIED: No permission to access space ID ${_spaceId}`);
        console.error(`💡 SOLUTION: Grant space access to the API token user account`);
      } else {
        console.error(`❌ SPACE VERIFICATION FAILED:`, err.response?.data || err.message);
      }
      throw err;
    }
    return;
  }

  console.log(`⚠️ No SPACE_ID provided, resolving from SPACE_KEY ${SPACE_KEY}`);

  const data = await api("LIST SPACES", v2, "get", "/spaces", null, { limit: 50 });

  const found = data.results.find((s) => s.key === SPACE_KEY);

  if (!found) {
    console.error(`❌ SPACE NOT FOUND: No space with key '${SPACE_KEY}' found`);
    console.error(`💡 SOLUTION: Check SPACE_KEY or create the space`);
    console.error(`Available spaces:`, data.results.map(s => `${s.key}: ${s.name}`).join(', '));
    throw new Error(`Space with key '${SPACE_KEY}' not found`);
  }

  _spaceId = found.id;
  _parentId = found.homepageId;

  console.log(`✅ spaceId=${_spaceId}, parentId=${_parentId}`);
}

// ─── TABLE TEMPLATE ──────────────────────────────────────────────────
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

async function getFeedUrls(issueKey) {
  const key = String(issueKey || "").trim();
  console.log(`🔗 Fetching Web Links (Remote Links) for ${key}`);

  if (!key) {
    console.warn("⚠️ No issue key provided for feed URL fetch");
    return "N/A";
  }

  try {
    const res = await api("GET ISSUE LINKS", jira, "get", `/issue/${key}/remotelink`);

    console.log("📦 Remote Links Response:", JSON.stringify(res, null, 2));

    const feedLinks = res
      .filter((link) =>
        String(link.object?.title || "").toLowerCase().includes("feed url")
      )
      .map((link) => link.object?.url)
      .filter(Boolean);

    console.log("✅ Extracted Feed URLs:", feedLinks);

    return feedLinks.join("<br/>") || "N/A";

  } catch (err) {
    console.error("❌ Failed to fetch remote links:", err.response?.data || err.message);
    return "N/A";
  }
}

app.get("/diagnostics", async (req, res) => {
  console.log("\n🔍 Diagnostics requested");

  const result = {
    jira: null,
    confluence: null,
    spaceId: SPACE_ID || null,
    spaceKey: SPACE_KEY,
    spaces: null,
  };

  try {
    const jiraSelf = await api("DIAG JIRA", jira, "get", "/myself");
    result.jira = { ok: true, user: jiraSelf.displayName || jiraSelf.emailAddress || jiraSelf.accountId };
  } catch (err) {
    result.jira = {
      ok: false,
      error: err.response?.data || err.message,
    };
  }

  try {
    const spacesData = await api("DIAG CONFLUENCE SPACES", v2, "get", "/spaces", null, { limit: 50 });
    result.spaces = {
      count: spacesData.results.length,
      list: spacesData.results.map(s => ({ id: s.id, name: s.name, key: s.key }))
    };

    if (SPACE_ID) {
      const spaceExists = spacesData.results.find(s => s.id === SPACE_ID);
      if (spaceExists) {
        result.confluence = { ok: true, space: spaceExists };
      } else {
        result.confluence = {
          ok: false,
          error: `Space ID ${SPACE_ID} not found in accessible spaces`
        };
      }
    } else {
      result.confluence = { ok: true, message: "No SPACE_ID specified, using SPACE_KEY lookup" };
    }
  } catch (err) {
    result.confluence = {
      ok: false,
      error: err.response?.data || err.message,
    };
    result.spaces = { count: 0, error: "Cannot list spaces" };
  }

  const status = (result.jira?.ok && result.confluence?.ok) ? 200 : 502;
  res.status(status).json(result);
});

// ─── WEBHOOK ─────────────────────────────────────────────────────────
app.post("/jira-webhook", async (req, res) => {
  console.log("\n🔥 WEBHOOK RECEIVED");

  try {
    const data = req.body;
    console.log("📦 Incoming Payload:", JSON.stringify(data, null, 2));

    // ─── FIELD EXTRACTION ────────────────────────────────────────────
    const ticketId = data.ticketId;
    const title = data.title;
    const reporter = data.reporter;
    const assignee = data.assignee;
    const jiraLink = data.jiraLink;

    const fixVersion = data.fixVersion; // customfield
    const portfolioEpic = data.portfolioEpic;
    const stageOnly = data.stageOnly;
    const stageDeploymentDate = data.stageDeploymentDate;

    console.log("📊 Extracted Fields:", {
      ticketId,
      title,
      fixVersion,
      portfolioEpic,
    });

    // ─── PAGE NAME FROM FIX VERSION ─────────────────────────────────
    if (!fixVersion) {
      console.log("⏭ No fixVersion → skipping");
      return res.send("No fixVersion");
    }

    const pageTitle = `${fixVersion} - CMS Release`;
    console.log("📄 Page Title:", pageTitle);

    // ─── PID LOGIC ──────────────────────────────────────────────────
    let pid = "";
    if (portfolioEpic) {
      pid = String(portfolioEpic).split(":")[0].trim();
    }

    console.log("🆔 PID:", pid);

    // ─── SB / ACQUIA EXTRACTION ─────────────────────────────────────
    let sbValue = "";
    const match = title.match(/\[(.*?)\]/);
    if (match) sbValue = match[1];

    console.log("🏷 SB/Acquia:", sbValue);

    // ─── FETCH FEED URL FROM JIRA LINKS ─────────────────────────────
    const feedURL = await getFeedUrls(ticketId);

    // ─── BOOTSTRAP ─────────────────────────────────────────────────
    await bootstrapSpace();

    // ─── SEARCH PAGE ───────────────────────────────────────────────
    const search = await findPage(pageTitle);

    let pageId, currentBody, version;

    if (search.results.length === 0) {
      console.log("🆕 Creating page...");

      const createPayload = {
        spaceId: _spaceId,
        title: pageTitle,
        status: "current",
        body: {
          representation: "storage",
          value: createTableHTML(),
        },
      };

      if (_parentId) {
        createPayload.parentId = _parentId;
      }

      const created = await api("CREATE PAGE", v2, "post", "/pages", createPayload);

      pageId = created.id;
      version = 1;
      currentBody = createTableHTML();
    } else {
      console.log("📄 Page exists, fetching...");

      pageId = search.results[0].id;

      const full = await api(
        "GET PAGE",
        v2,
        "get",
        `/pages/${pageId}`,
        null,
        { "body-format": "storage" }
      );

      currentBody = full.body.storage.value;
      version = full.version.number;
    }

    // ─── NEW ROW ───────────────────────────────────────────────────
    const newRow = `
<tr>
<td>${sbValue}</td>
<td>${stageOnly}</td>
<td><a href="${jiraLink}">${jiraLink}</a></td>
<td>${pid}</td>
<td>${title}</td>
<td>${reporter}</td>
<td>${assignee}</td>
<td>${feedURL}</td>
<td>${stageDeploymentDate}</td>
</tr>
`;

    const updatedBody = currentBody.replace("</tbody>", `${newRow}</tbody>`);

    // ─── UPDATE PAGE ───────────────────────────────────────────────
    await api("UPDATE PAGE", v2, "put", `/pages/${pageId}`, {
      id: pageId,
      status: "current",
      title: pageTitle,
      version: { number: version + 1 },
      body: {
        representation: "storage",
        value: updatedBody,
      },
    });

    console.log("🎉 SUCCESS");
    res.send("Done");

  } catch (err) {
    console.error("❌ ERROR:", err.response?.data || err.message);
    res.status(500).send("Error");
  }
});

// ─── START ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});