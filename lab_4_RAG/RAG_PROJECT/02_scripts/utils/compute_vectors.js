import { embedTexts } from "./utils/compute_vectors.js";

const EMBEDDING_PROVIDER = (process.env.EMBEDDING_PROVIDER || "local").toLowerCase();

export async function computeVectorsForTexts(texts) {
  if (!texts) return [];
  const inputs = Array.isArray(texts) ? texts : [texts];

  if (EMBEDDING_PROVIDER === "local") {
    const vecs = await embedTexts(inputs);
    return vecs.map((v) => Array.from(v)); // plain number[] for vectorstores
  }

  throw new Error(
    `Unsupported EMBEDDING_PROVIDER="${EMBEDDING_PROVIDER}". Set EMBEDDING_PROVIDER=local or implement another branch.`
  );
}

export default computeVectorsForTexts;