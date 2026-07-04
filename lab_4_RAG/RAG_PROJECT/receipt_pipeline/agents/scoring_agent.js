// Scoring Agent: assigns confidence score
export async function scoringAgent(annotated) {
  // Simple scoring: +0.5 if vision, +0.3 if OCR, +0.2 if meta
  let score = 0;
  if (annotated.sources?.includes('vision_llm')) score += 0.5;
  if (annotated.sources?.includes('ocr')) score += 0.3;
  if (annotated.meta) score += 0.2;
  return { ...annotated, score };
}

// System Prompt for Scoring Agent
export const scoringAgentPrompt = `
You are the Scoring Agent.
Rules:
- Score the quality and completeness of extracted receipt data.
- Do not alter the data.
Tools:
- Scoring algorithms
Few-shot:
Q: { "date": "2024-03-25", "total": 42.50 }
A: { "score": 0.95, "missing_fields": [] }
Chain-of-thought:
- Evaluate extracted fields
- Assign score
- Output score and missing fields
Skills:
- Use guard agent for permission checks if needed
`;
