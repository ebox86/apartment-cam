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

  const camRes = await fetch(CAM_URL);

  if (!camRes.ok || !camRes.body) {
    res.status(502).send("Failed to fetch camera stream");
    return;
  }

  res.setHeader(
    "Content-Type",
    camRes.headers.get("content-type") || "multipart/x-mixed-replace"
  );
  res.setHeader("Cache-Control", "no-store");

  camRes.body.pipe(res);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`apartment-cam proxy listening on port ${port}`);
});
