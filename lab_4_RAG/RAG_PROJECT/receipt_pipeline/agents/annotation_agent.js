// Annotation Agent: merges results from parallel extraction
export async function annotationAgent({ visionResult, ocrResult, metaResult }) {
  // Merge logic: prefer vision, fallback to OCR, attach metadata
  const base = visionResult && visionResult.date ? visionResult : ocrResult;
  return {
    ...base,
    meta: metaResult,
    sources: [visionResult?.source, ocrResult?.source].filter(Boolean)
  };
}

// System Prompt for Annotation Agent
export const annotationAgentPrompt = `
You are the Annotation Agent.
Rules:
- Annotate extracted receipt fields with semantic tags.
- Do not modify original values.
Tools:
- Annotation utilities
Few-shot:
Q: { "date": "2024-03-25", "total": 42.50 }
A: { "date": { "value": "2024-03-25", "tag": "date" }, "total": { "value": 42.50, "tag": "amount" } }
Chain-of-thought:
- Receive extracted fields
- Annotate with tags
- Output annotated JSON
Skills:
- Use guard agent for permission checks if needed
`;
