import express from "express";
import { pipeline } from "@xenova/transformers";

const app = express();
app.use(express.json({ limit: "1mb" }));

let extractor = null;
let currentModel = null;

async function getExtractor(modelName) {
  if (!extractor || currentModel !== modelName) {
    extractor = await pipeline("feature-extraction", modelName);
    currentModel = modelName;
  }
  return extractor;
}

app.get("/health", async (_, res) => {
  res.json({ status: "ok", model: currentModel || null });
});

app.post("/embed", async (req, res) => {
  try {
    const { text, model } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text is required" });
    }
    const modelName = model || "Xenova/all-MiniLM-L6-v2";
    const ext = await getExtractor(modelName);
    const out = await ext(text, { pooling: "mean", normalize: true });
    const embedding = Array.from(out.data);
    return res.json({ embedding, model: modelName, dim: embedding.length });
  } catch (e) {
    return res.status(500).json({ error: e.message || "embedding failure" });
  }
});

const port = process.env.PORT || 3005;
app.listen(port, () => {
  console.log(`embedding server running on ${port}`);
});
