import express from "express";
import fetch from "node-fetch";

const app = express();
const CAM_URL = process.env.CAM_URL;

app.get("/", (_req, res) => {
  res.send("apartment-cam proxy is running");
});

app.get("/stream", async (_req, res) => {
  if (!CAM_URL) {
    res.status(500).send("CAM_URL not set");
    return;
  }

  try {
    console.log("Requesting camera stream from:", CAM_URL);
    const camRes = await fetch(CAM_URL);

    console.log("Camera response status:", camRes.status, camRes.statusText);

    if (!camRes.ok || !camRes.body) {
      res
        .status(502)
        .send(`Failed to fetch camera stream (status ${camRes.status})`);
      return;
    }

    // camRes.body is already a Node.js readable (PassThrough), so just pipe it
    res.setHeader(
      "Content-Type",
      camRes.headers.get("content-type") || "multipart/x-mixed-replace"
    );
    res.setHeader("Cache-Control", "no-store");

    camRes.body.pipe(res);
  } catch (err) {
    console.error("Error proxying stream:", err);
    if (!res.headersSent) {
      res.status(500).send("Error proxying stream");
    }
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`apartment-cam proxy listening on port ${port}`);
});
