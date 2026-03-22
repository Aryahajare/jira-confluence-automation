import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 5000;

// 🔐 CONFIG (we'll move to env later)
const EMAIL = process.env.EMAIL;
const API_TOKEN = process.env.API_TOKEN;
const BASE_URL = process.env.BASE_URL;
const SPACE_KEY = process.env.SPACE_KEY;

const auth = Buffer.from(`${EMAIL}:${API_TOKEN}`).toString("base64");

// 📌 TABLE TEMPLATE
const createTable = () => `
<table>
  <tbody>
    <tr>
      <th>Ticket ID</th>
      <th>Summary</th>
      <th>Assignee</th>
      <th>Reporter</th>
      <th>Stage Only</th>
      <th>Link</th>
    </tr>
  </tbody>
</table>
`;

app.post("/jira-webhook", async (req, res) => {
  try {
    const data = req.body;

    const labels = data.labels || "";
    const release = labels.split(",").find(l => l.includes("release-"));

    if (!release) return res.send("No release label");

    const releaseName = release.trim();
    const pageTitle = `${releaseName} - CMS Wiki`;

    // 🔍 Search page
    const searchRes = await axios.get(
      `${BASE_URL}/wiki/rest/api/content?title=${encodeURIComponent(pageTitle)}&spaceKey=${SPACE_KEY}`,
      { headers: { Authorization: `Basic ${auth}` } }
    );

    let pageId, content, version;

    if (searchRes.data.size === 0) {
      // CREATE PAGE
      const newPage = await axios.post(
        `${BASE_URL}/wiki/rest/api/content`,
        {
          type: "page",
          title: pageTitle,
          space: { key: SPACE_KEY },
          body: {
            storage: {
              value: createTable(),
              representation: "storage"
            }
          }
        },
        {
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/json"
          }
        }
      );

      pageId = newPage.data.id;
      content = newPage.data.body.storage.value;
      version = newPage.data.version.number;

    } else {
      const pageIdFound = searchRes.data.results[0].id;

      const fullPage = await axios.get(
        `${BASE_URL}/wiki/rest/api/content/${pageIdFound}?expand=body.storage,version`,
        { headers: { Authorization: `Basic ${auth}` } }
      );

      pageId = pageIdFound;
      content = fullPage.data.body.storage.value;
      version = fullPage.data.version.number;
    }

    // ADD ROW
    const row = `
<tr>
<td>${data.ticketId}</td>
<td>${data.summary}</td>
<td>${data.assignee}</td>
<td>${data.reporter}</td>
<td>${data.stageOnly}</td>
<td><a href="${data.link}">View</a></td>
</tr>`;

    content = content.replace("</tbody>", `${row}</tbody>`);

    // UPDATE PAGE
    await axios.put(
      `${BASE_URL}/wiki/rest/api/content/${pageId}`,
      {
        version: { number: version + 1 },
        type: "page",
        title: pageTitle,
        body: {
          storage: {
            value: content,
            representation: "storage"
          }
        }
      },
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.send("✅ Done");
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("Error");
  }
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));