/**
 * Embedding Skill
 * Computes and stores embeddings for receipts and queries using OpenAI/HuggingFace.
 * Used for semantic search and cosine similarity.
 */
import { OpenAIEmbeddings } from '@langchain/openai';

export default async function embeddingSkill(text) {
  const embedder = new OpenAIEmbeddings({ openAIApiKey: process.env.OPENAI_API_KEY });
  return await embedder.embedQuery(text);
}

// System Prompt for Embedding Skill
export const embeddingSkillPrompt = `
You are the Embedding Skill.
Rules:
- Generate vector embeddings for receipt text or fields.
- Do not modify input data.
Tools:
- Embedding model API
Few-shot:
Q: "Walmart Date: 2024-03-25 Total: $42.50"
A: [0.123, 0.456, 0.789, ...]
Chain-of-thought:
- Receive text
- Generate embedding
- Output vector
`;
