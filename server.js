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

// ─── AUTH ────────────────────────────────────────
const authHeader =
  "Basic " + Buffer.from(`${EMAIL}:${API_TOKEN}`).toString("base64");

const headers = {
  Authorization: authHeader,
  Accept: "application/json",
  "Content-Type": "application/json",
  "User-Agent": "jira-confluence-bot/1.0",
};

function sanitizeHeaders(h = {}) {
  const copy = { ...h };
  if (copy.Authorization) {
    try {
      const v = String(copy.Authorization);
      copy.Authorization = v.startsWith('Basic ') ? 'Basic *****' : '*****';
    } catch (e) {
      copy.Authorization = '*****';
    }
  }
  return copy;
}

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
    if (config.params) console.log('➡️ PARAMS:', JSON.stringify(config.params));
    if (config.data) console.log('➡️ PAYLOAD KEYS:', Object.keys(config.data));
    if (config.headers) console.log('➡️ REQ HEADERS:', sanitizeHeaders(config.headers));
  } catch (e) {
    console.warn('api: failed to log extra request details');
  }

  try {
    const res = await axios(config);
    console.log("✅ STATUS:", res.status, "| ⏱️", Date.now() - start, "ms");
    return res.data;
  } catch (err) {
    console.error("❌ ERROR:", err.response?.status, "| message:", err.message);
    if (err.response && err.response.data) {
      console.error("❌ ERROR RESPONSE BODY:", JSON.stringify(err.response.data));
    }
    console.error(err.stack);
    throw err;
  }
}

// ─── TABLE TEMPLATE ──────────────────────────────
const createTable = () => `
<table>
<tbody>
<tr>
<th>SB/Acquia</th>
<th>Scope of deployment(Stage/prod)</th>
<th>CI Link</th>
<th>PID</th>
<th>Brief Business Description of CMS change requested</th>
<th>DEV Contact(Reporter)</th>
<th>CI Contact(Assignee)</th>
<th>Feed URL</th>
<th>Deployment Date[use Deployment Date field](Ready for stage deployment, Deployed to stage, Validated in stage)</th>
<th>CMS Release name</th>
<th>Stage & Prod Validation Status</th>
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

    // `res` is typically an array of remotelink objects. Log a short sample for debugging.
    try {
      console.log('REMOTELINKS RAW:', Array.isArray(res) ? `count=${res.length}` : JSON.stringify(res).slice(0,1000));
    } catch (e) {
      console.warn('Could not stringify remotelinks sample');
    }

    const links = Array.isArray(res) ? res : (res.values || []);

    try {
      console.log('REMOTELINKS FETCHED (count):', links.length);
      console.log('REMOTELINKS RAW SAMPLE:', JSON.stringify(links, null, 2).slice(0, 20000));
    } catch (e) {
      console.warn('getFeedUrls: failed to stringify raw remotelinks');
    }

    // Include all remotelinks except those with a title exactly 'Jira Align' (case-insensitive).
    const matched = links.filter((l) => {
      const title = String(l.object?.title || l.title || "").trim();
      if (/^jira\s+align$/i.test(title)) return false;
      return true;
    });

    const urls = matched.map((l) => l.object?.url || l.url).filter(Boolean);

    console.log('MATCHED REMOTELINKS (count):', matched.length);
    try {
      console.log('MATCHED REMOTELINKS DETAILS:', JSON.stringify(matched, null, 2).slice(0, 20000));
    } catch (e) {
      console.warn('getFeedUrls: failed to stringify matched remotelinks');
    }
    console.log('MATCHED REMOTELINK URLS:', urls);

    if (!urls.length) {
      console.log('getFeedUrls: no matching remotelinks found for', issueKey);
      return "N/A";
    }

    return urls.map((url) => `<a href="${url}">${url}</a>`).join("<br/>");

  } catch (err) {
    console.error("❌ FEED URL FETCH FAILED", err.message);
    if (err.response && err.response.data) console.error('FEED ERROR RESPONSE:', JSON.stringify(err.response.data));
    return "N/A";
  }
}

// ─── DIAGNOSTICS ─────────────────────────────────
async function runDiagnostics(issueKey, parentTitle) {
  const out = { jiraIssue: null, remotelinks: null, confluenceParent: null };

  try {
    if (issueKey) {
      try {
        out.jiraIssue = await api('DIAG - GET ISSUE', {
          method: 'get',
          baseURL: `${BASE}/rest/api/3`,
          url: `/issue/${issueKey}`,
          headers,
        });
      } catch (e) {
        out.jiraIssue = { error: e.message, body: e.response?.data };
      }

      try {
        out.remotelinks = await api('DIAG - GET REMOTELINKS', {
          method: 'get',
          baseURL: `${BASE}/rest/api/3`,
          url: `/issue/${issueKey}/remotelink`,
          headers,
        });
      } catch (e) {
        out.remotelinks = { error: e.message, body: e.response?.data };
      }
    } else {
      out.jiraIssue = { warning: 'no issueKey provided' };
      out.remotelinks = { warning: 'no issueKey provided' };
    }

    if (parentTitle) {
      try {
        out.confluenceParent = await api('DIAG - FIND PARENT', {
          method: 'get',
          baseURL: `${BASE}/wiki/rest/api`,
          url: '/content',
          headers,
          params: { spaceKey: SPACE_KEY, title: parentTitle, expand: 'version' },
        });
      } catch (e) {
        out.confluenceParent = { error: e.message, body: e.response?.data };
      }
    } else {
      out.confluenceParent = { warning: 'no parentTitle provided' };
    }

  } catch (err) {
    console.error('runDiagnostics unexpected error', err.message);
    out._error = err.message;
  }

  // Log a concise diagnostic summary (avoid dumping tokens)
  try {
    console.log('DIAG SUMMARY:', JSON.stringify({
      jiraIssue: out.jiraIssue && (out.jiraIssue.error ? 'ERROR' : 'OK'),
      remotelinks: out.remotelinks && (out.remotelinks.error ? 'ERROR' : (Array.isArray(out.remotelinks) ? `count=${out.remotelinks.length}` : 'OK')),
      confluenceParent: out.confluenceParent && (out.confluenceParent.error ? 'ERROR' : (out.confluenceParent.results ? `found=${out.confluenceParent.results.length}` : 'OK')),
    }));
  } catch (e) {
    console.warn('Failed to log DIAG SUMMARY');
  }

  return out;
}

// Optional: expose diagnostics endpoint for ad-hoc checks in the running environment
app.get('/diag', async (req, res) => {
  const issueKey = req.query.issueKey || '';
  const parentTitle = req.query.parentTitle || '';
  try {
    const d = await runDiagnostics(issueKey, parentTitle);
    res.json({ ok: true, diag: d });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── WEBHOOK ─────────────────────────────────────
app.post("/jira-webhook", async (req, res) => {
  console.log("\n🔥 WEBHOOK HIT");

  try {
    const data = req.body;

    // Verbose per-variable diagnostics (mask secrets)
    try {
      console.log('WEBHOOK - ENV VARS:');
      console.log(' - BASE:', BASE || '(missing)');
      console.log(' - SPACE_KEY:', SPACE_KEY || '(missing)');
      console.log(' - EMAIL:', EMAIL ? `${EMAIL}` : '(missing)');
      console.log(' - API_TOKEN present:', API_TOKEN ? 'YES' : 'NO');
    } catch (e) {
      console.warn('Failed to log env vars');
    }

    try {
      console.log('WEBHOOK - PAYLOAD FIELDS:');
      console.log(' - ticketId:', data.ticketId || '(missing)');
      console.log(' - LaunchDate:', data.LaunchDate || '(missing)');
      console.log(' - labels:', JSON.stringify(data.labels || data.stageOnly || []));
      console.log(' - jiraLink:', data.jiraLink || '(missing)');
      console.log(' - title:', data.title || '(missing)');
      console.log(' - portfolioEpic:', data.portfolioEpic || '(missing)');
      console.log(' - reporter:', data.reporter || '(missing)');
      console.log(' - assignee:', data.assignee || '(missing)');
      console.log(' - stageDeploymentDate:', data.stageDeploymentDate || '(missing)');
    } catch (e) {
      console.warn('Failed to log payload fields');
    }

    // Use LaunchDate (new field) for page title; warn if missing
    const launchRaw = (data.LaunchDate ?? "").toString().trim();
    if (!launchRaw) {
      console.warn('Webhook payload missing LaunchDate:', JSON.stringify(data));
      console.log('❌ PAGE CREATION CANCELED: missing LaunchDate');
      return res.status(400).send('Aborted: missing LaunchDate');
    }
    const launch = formatLaunchDate(launchRaw);

    // Derive scope label from incoming labels (exclude STAGE/PROD)
    let labelsArr = [];
    if (Array.isArray(data.labels)) labelsArr = data.labels.map((l) => String(l).trim()).filter(Boolean);
    else if (typeof data.stageOnly === 'string') labelsArr = data.stageOnly.split(',').map((s) => s.trim()).filter(Boolean);

    console.log('Webhook labels array:', JSON.stringify(labelsArr));

    const filtered = labelsArr.filter((l) => {
      const low = l.toLowerCase();
      return low !== 'stage' && low !== 'prod' && low !== 'production';
    });

    const scopeLabel = (filtered[0] || '').toString().trim();
    if (scopeLabel) console.log('Using scope label for title:', scopeLabel);

    const pageTitle = scopeLabel
      ? `${launch} - DirecTV ${scopeLabel} CMS Release`
      : `${launch} - CMS Release`;

    // If no scope label provided, abort the process (don't lookup/create/update pages)
    if (!scopeLabel) {
      console.warn('Webhook payload missing scope label (non-STAGE/PROD label):', JSON.stringify(data));
      console.log('❌ PAGE CREATION CANCELED: missing scope label');
      return res.status(400).send('Aborted: missing scope label');
    }
    
    // Determine environment label to display in Stage column (only STAGE or PROD)
    const envLabelRaw = labelsArr.find((l) => {
      const low = l.toLowerCase();
      return low === 'stage' || low === 'prod' || low === 'production';
    }) || '';
    const envDisplay = envLabelRaw
      ? (envLabelRaw.toLowerCase().startsWith('prod') ? 'PROD' : 'STAGE')
      : '';

    // SB extraction
    const sbMatch = data.title.match(/\[(.*?)\]/);
    const sb = sbMatch ? sbMatch[1] : "";

    // PID extraction 
    const pid = data.portfolioEpic
      ? data.portfolioEpic.split(":")[0].trim()
      : "";

    console.log('Webhook payload stageOnly:', JSON.stringify(data.stageOnly));
    if (!data.ticketId) console.warn('Webhook payload missing ticketId:', JSON.stringify(data));
    // Precompute parent title so diagnostics can check Confluence parent as well
    const parentTitleDynamic = `${scopeLabel} - CMS Release Scope`;
    console.log('Looking up parent page title (pre-diagnostic):', parentTitleDynamic);

    // Run diagnostics (Jira issue GET, remotelinks GET, Confluence parent search)
    try {
      const diag = await runDiagnostics(data.ticketId, parentTitleDynamic);
      console.log('DIAGNOSTICS RESULT:', JSON.stringify({
        jiraIssue: diag.jiraIssue && diag.jiraIssue.error ? `ERROR:${diag.jiraIssue.error}` : (diag.jiraIssue ? 'OK' : 'NONE'),
        remotelinks: Array.isArray(diag.remotelinks) ? `count=${diag.remotelinks.length}` : (diag.remotelinks?.error || 'NONE'),
        confluenceParent: diag.confluenceParent && diag.confluenceParent.error ? `ERROR:${diag.confluenceParent.error}` : (diag.confluenceParent && diag.confluenceParent.results ? `found=${diag.confluenceParent.results.length}` : 'NONE')
      }));
    } catch (e) {
      console.warn('Diagnostics run failed:', e.message);
    }

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
        title: parentTitleDynamic,
        expand: "version",
      },
    });

    const parent = parentSearch.results?.[0];
    const parentId = parent?.id;
    if (!parent) {
      console.warn('PARENT LOOKUP: no parent found for', parentTitleDynamic, '| parentSearch result count:', parentSearch.results?.length || 0);
    } else {
      console.log('PARENT LOOKUP: found parent id', parentId);
    }

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
      if (children.results?.length === 0) console.log('FETCH CHILD PAGES: parent has no children');
      else console.log('FETCH CHILD PAGES: fetched', children.results.length, 'children');
    }

    // Fallback: search across the space key if not found under parent
    if (!page) {
      console.log('PAGE NOT FOUND UNDER PARENT, performing space-wide search');
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
      console.log('FETCH PAGES: found', search.results.length, 'pages in space');
    }

    let pageId, version, body;

    if (!page) {
      console.log("🆕 CREATING PAGE", { title: pageTitle, space: SPACE_KEY });

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
      try {
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
        console.log('CREATE PAGE: created page id', pageId);
      } catch (err) {
        console.error('CREATE PAGE FAILED for title', pageTitle, 'error:', err.message);
        return res.status(500).send('Error creating page');
      }
    } else {
      pageId = page.id;
      version = page.version.number;
      body = page.body.storage.value;
      console.log('PAGE FOUND: using page id', pageId, 'version', version);
    }

    // ─── CHEERIO PARSE ──────────────────────────
    const $ = cheerio.load(body);

    const ciLinkHTML = `<a href="${data.jiraLink}">${data.jiraLink}</a>`;

    const deploymentRaw = (data.stageDeploymentDate ?? "").toString().trim();
    const deploymentText = deploymentRaw ? `Deployed to stage - ${formatLaunchDate(deploymentRaw)}` : "";

    const newRow = `
<tr>
<td>${sb}</td>
<td>${envDisplay}</td>
<td>${ciLinkHTML}</td>
<td>${pid}</td>
<td>${data.title}</td>
<td>${data.reporter}</td>
<td>${data.assignee}</td>
<td>${feedURL}</td>
<td>${deploymentText}</td>
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
    try {
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
      console.log('UPDATE PAGE: updated page id', pageId, 'to version', version + 1);
    } catch (err) {
      console.error('UPDATE PAGE FAILED for pageId', pageId, 'error:', err.message);
      return res.status(500).send('Error updating page');
    }

    console.log("🎉 SUCCESS");
    res.send("Done");

  } catch (err) {
    console.error("❌ WEBHOOK FAILED:", err.message);
    if (err.response && err.response.data) console.error('ERROR RESPONSE:', JSON.stringify(err.response.data));
    console.error(err.stack);
    res.status(500).send("Error");
  }
});

// ─── START ──────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});