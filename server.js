import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 5000;

// 🔐 ENV CONFIG (Render)
const EMAIL = process.env.EMAIL;
const API_TOKEN = process.env.API_TOKEN;
const BASE_URL = process.env.BASE_URL;

// 🧪 STARTUP LOGS
console.log("🚀 Server starting...");
console.log("EMAIL:", EMAIL ? "✅" : "❌");
console.log("API_TOKEN:", API_TOKEN ? "✅" : "❌");
console.log("BASE_URL:", BASE_URL);

const auth = Buffer.from(`${EMAIL}:${API_TOKEN}`).toString("base64");

// ✅ Health check
app.get("/", (req, res) => {
  res.send("✅ Backend running");
});

// 📌 RELEASE → PAGE MAPPING (FINAL)
const releasePageMap = {
  "release-1.0": "131111"
};

// 🚀 WEBHOOK
app.post("/jira-webhook", async (req, res) => {
  console.log("🔥 WEBHOOK HIT");
  console.log("📦 BODY:", req.body);

  try {
    const data = req.body;

    // ✅ LABEL HANDLING
    const labels = data.labels || [];
    const release = Array.isArray(labels)
      ? labels.find(l => l.includes("release-"))
      : labels.split(",").find(l => l.includes("release-"));

    if (!release) {
      console.log("❌ No release label");
      return res.send("No release label");
    }

    const releaseName = release.trim();

    // ✅ GET PAGE ID FROM MAP
    const pageId = releasePageMap[releaseName];

    if (!pageId) {
      console.log("❌ No page mapped for this release");
      return res.send("No page mapped");
    }

    console.log("📄 Using Page ID:", pageId);

    // 🔍 GET PAGE CONTENT
    const fullPage = await axios.get(
      `${BASE_URL}/wiki/rest/api/content/${pageId}?expand=body.storage,version`,
      {
        headers: { Authorization: `Basic ${auth}` }
      }
    );

    let content = fullPage.data.body.storage.value;
    const version = fullPage.data.version.number;
    const title = fullPage.data.title;

    // ➕ ADD ROW
    const row = `
<tr>
<td>${data.ticketId || ""}</td>
<td>${data.summary || ""}</td>
<td>${data.assignee || "Unassigned"}</td>
<td>${data.reporter || ""}</td>
<td>${data.stageOnly || "false"}</td>
<td><a href="${data.link || "#"}">View</a></td>
</tr>`;

    content = content.replace("</tbody>", `${row}</tbody>`);

    console.log("📝 Updating page...");

    // 🔄 UPDATE PAGE
    await axios.put(
      `${BASE_URL}/wiki/rest/api/content/${pageId}`,
      {
        version: { number: version + 1 },
        type: "page",
        title: title,
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

    console.log("🎉 SUCCESS: Page updated");

    res.send("✅ Done");

  } catch (err) {
    console.error("❌ ERROR:", err.response?.data || err.message);
    res.status(500).send("Error");
  }
});

app.listen(PORT, () => {
  console.log(`🌍 Server running on port ${PORT}`);
});