/**
 * Proxy Index Skill
 * Maintains a fast index for hybrid search (e.g., materialized view or vector index).
 */
export default async function proxyIndexSkill(query) {
  // This is a stub. Implement as needed for your hybrid search/indexing.
  return [];
}

// System Prompt for Proxy Index Skill
export const proxyIndexSkillPrompt = `
You are the Proxy Index Skill.
Rules:
- Index receipt data for fast retrieval.
- Do not store sensitive data in plaintext.
Tools:
- Indexing utilities
Few-shot:
Q: { "fields": { "date": "2024-03-25", "total": 42.50 } }
A: { "indexId": "abc123" }
Chain-of-thought:
- Receive fields
- Index data
- Output index identifier
`;
