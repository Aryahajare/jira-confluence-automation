import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 5000;

// 🔐 ENV CONFIG (Render)
const EMAIL = process.env.EMAIL;
const API_TOKEN = process.env.API_TOKEN;
const BASE_URL = process.env.BASE_URL;
const SPACE_KEY = process.env.SPACE_KEY;

// 🧪 STARTUP LOGS
console.log("🚀 Server starting...");
console.log("ENV CHECK:");
console.log("EMAIL:", EMAIL ? "✅ Loaded" : "❌ Missing");
console.log("API_TOKEN:", API_TOKEN ? "✅ Loaded" : "❌ Missing");
console.log("BASE_URL:", BASE_URL);
console.log("SPACE_KEY:", SPACE_KEY);

const auth = Buffer.from(`${EMAIL}:${API_TOKEN}`).toString("base64");

// 📌 HEALTH CHECK ROUTE (IMPORTANT FOR TEST)
app.get("/", (req, res) => {
  res.send("✅ Backend is running");
});

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

// 🚀 WEBHOOK
app.post("/jira-webhook", async (req, res) => {
  console.log("🔥 WEBHOOK HIT");
  console.log("📩 HEADERS:", req.headers);
  console.log("📦 BODY:", req.body);

  try {
    const data = req.body;

    // 🔍 Extract labels
    const labels = data.labels || "";
    console.log("🏷️ Labels:", labels);

    const release = labels.split(",").find(l => l.includes("release-"));

    if (!release) {
      console.log("❌ No release label found");
      return res.send("No release label");
    }

    const releaseName = release.trim();
    const pageTitle = `${releaseName} - CMS Wiki`;

    console.log("📄 Page Title:", pageTitle);

    // 🔍 SEARCH PAGE
    const searchRes = await axios.get(
      `${BASE_URL}/wiki/rest/api/content?title=${encodeURIComponent(pageTitle)}&spaceKey=${SPACE_KEY}`,
      {
        headers: { Authorization: `Basic ${auth}` }
      }
    );

    console.log("🔍 Search result:", searchRes.data.size);

    let pageId, content, version;

    if (searchRes.data.size === 0) {
      console.log("🆕 Creating new page...");

      const newPage = await axios.post(
        `${BASE_URL}/wiki/rest/api/content`,
        {
          type: "page",
          title: pageTitle,
          space: { id: 425988 },
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

      console.log("✅ Page created:", pageId);

    } else {
      console.log("📄 Page exists, updating...");

      const pageIdFound = searchRes.data.results[0].id;

      const fullPage = await axios.get(
        `${BASE_URL}/wiki/rest/api/content/${pageIdFound}?expand=body.storage,version`,
        {
          headers: { Authorization: `Basic ${auth}` }
        }
      );

      pageId = pageIdFound;
      content = fullPage.data.body.storage.value;
      version = fullPage.data.version.number;
    }

    // ➕ ADD ROW
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

    console.log("📝 Updating page...");

    // 🔄 UPDATE PAGE
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

    console.log("🎉 Confluence updated successfully");

    res.send("✅ Done");
  } catch (err) {
    console.error("❌ ERROR:", err.response?.data || err.message);
    res.status(500).send("Error");
  }
});

app.listen(PORT, () => {
  console.log(`🌍 Server running on port ${PORT}`);
});