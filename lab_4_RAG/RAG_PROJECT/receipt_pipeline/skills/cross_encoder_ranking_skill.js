// Cross-Encoder Ranking Skill
// This skill ranks extraction results using a cross-encoder model (stub for demo)
// Replace with actual cross-encoder API/model as needed

/**
 * Ranks a list of extraction results by semantic relevance/confidence.
 * @param {Array} candidates - Array of {fields, score, source}
 * @param {string} query - The user query or context
 * @returns {Array} - Ranked list with cross-encoder scores
 */
export default async function crossEncoderRankingSkill(candidates, query) {
  // TODO: Integrate with real cross-encoder model
  // For demo, sort by existing score descending and add a mock cross-encoder score
  return candidates
    .map((c, i) => ({ ...c, crossEncoderScore: c.score + 0.1 * (c.source === 'vision_llm' ? 1 : 0) }))
    .sort((a, b) => b.crossEncoderScore - a.crossEncoderScore);
}

// System Prompt for Cross-Encoder Ranking Skill
export const crossEncoderRankingSkillPrompt = `
You are the Cross-Encoder Ranking Skill.
Rules:
- Rank extraction results by semantic relevance and confidence.
- Use a cross-encoder model for scoring.
Tools:
- Cross-encoder API/model
Few-shot:
Q: [ {fields, score, source}, ... ], query
A: [ {fields, score, source, crossEncoderScore}, ... ]
Chain-of-thought:
- Receive candidates and query
- Compute cross-encoder scores
- Output ranked list
`;
