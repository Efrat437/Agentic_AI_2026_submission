/**
 * Semantic Similarity Skill
 * Ranks results by semantic similarity using cosine similarity of embeddings.
 */
import embeddingSkill from './embedding_skill.js';

export default async function semanticSimilaritySkill(query, candidates) {
  const queryEmbedding = await embeddingSkill(query);
  // Assume candidates: [{text, embedding}]
  return candidates.map(c => ({
    ...c,
    similarity: cosineSimilarity(queryEmbedding, c.embedding)
  })).sort((a, b) => b.similarity - a.similarity);
}

function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, ai, i) => sum + ai * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
  const normB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
  return dot / (normA * normB);
}

// System Prompt for Semantic Similarity Skill
export const semanticSimilaritySkillPrompt = `
You are the Semantic Similarity Skill.
Rules:
- Compute similarity between two embeddings or texts.
- Do not alter input vectors.
Tools:
- Similarity computation utilities
Few-shot:
Q: [0.1, 0.2, 0.3], [0.1, 0.2, 0.4]
A: 0.98
Chain-of-thought:
- Receive two vectors
- Compute similarity
- Output similarity score
`;
