// Merging Agent: merges multiple scored/validated candidates
export async function mergingAgent(candidates) {
  // Sort by score descending, take the top candidate
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
  // Optionally, merge fields from top N if scores are close
  const top = candidates[0];
  return { ...top, merged: true };
}

// System Prompt for Merging Agent
export const mergingAgentPrompt = `
You are the Merging Agent.
Rules:
- Merge multiple validated/scored candidates into a single result.
- Prefer the candidate with the highest score.
- If scores are close, merge fields from top N.
Tools:
- Merging utilities
Few-shot:
Q: [candidates with scores]
A: { "date": "2024-03-25", "total": 42.50, "score": 0.95 }
Chain-of-thought:
- Sort candidates by score
- Merge fields if needed
- Output merged result
Skills:
- Use guard agent for permission checks if needed
`;
