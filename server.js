import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// 🔐 CONFIG
const EMAIL = process.env.EMAIL;
const API_TOKEN = process.env.API_TOKEN;
const BASE_URL = "https://arayahajare.atlassian.net/wiki";
const SPACE_ID = "327691";

const confluence = axios.create({
  baseURL: BASE_URL,
  auth: {
    username: EMAIL,
    password: API_TOKEN
  },
  headers: {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "User-Agent": "curl/7.88.1"
  }
});

// 🧾 HTML ROW TEMPLATE
function buildRow(data) {
  return `
    <tr>
      <td>${data.ticketId}</td>
      <td>${data.title}</td>
      <td>${data.assignee}</td>
      <td><a href="${data.jiraLink}">Jira</a></td>
    </tr>
  `;
}

// 🧾 BASE TABLE (if new page)
function baseTable() {
  return `
    <table>
      <tr>
        <th>Ticket</th>
        <th>Title</th>
        <th>Assignee</th>
        <th>Link</th>
      </tr>
    </table>
  `;
}

// 🚀 MAIN WEBHOOK
app.post("/webhook", async (req, res) => {
  try {
    const data = req.body;

    const pageTitle = `${data.fixVersion} - CMS Release`;
    const newRow = buildRow(data);

    // 🔍 FETCH PAGES
    const response = await confluence.get("/rest/api/content", {
      params: {
        spaceId: SPACE_ID,
        limit: 100,
        expand: "version,body.storage"
      }
    });

    const pages = response.data.results;

    // 🔎 FIND PAGE
    const page = pages.find(p => p.title.trim() === pageTitle.trim());

    if (page) {
      console.log("✏️ Updating existing page");

      const updatedHTML =
        page.body.storage.value.replace("</table>", `${newRow}</table>`);

      await confluence.put(`/rest/api/content/${page.id}`, {
        version: {
          number: page.version.number + 1
        },
        title: page.title,
        type: "page",
        body: {
          storage: {
            value: updatedHTML,
            representation: "storage"
          }
        }
      });

    } else {
      console.log("📄 Creating new page");

      const html = baseTable().replace("</table>", `${newRow}</table>`);

      await confluence.post("/rest/api/content", {
        type: "page",
        title: pageTitle,
        space: { key: "REL" },
        body: {
          storage: {
            value: html,
            representation: "storage"
          }
        }
      });
    }

    res.send("✅ Success");

  } catch (err) {
    console.error("❌ ERROR:", err.response?.data || err.message);
    res.status(500).send("Failed");
  }
});

app.listen(3000, () => console.log("🚀 Server running"));