import { pipeline } from '@xenova/transformers';

let embedder;
export async function getEmbeddings(texts) {
  if (!embedder) embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  if (!Array.isArray(texts)) texts = [texts];
  const results = [];
  for (const text of texts) {
    const output = await embedder(text, { pooling: 'mean', normalize: true });
    results.push(Array.from(output.data));
  }
  return results;
}
