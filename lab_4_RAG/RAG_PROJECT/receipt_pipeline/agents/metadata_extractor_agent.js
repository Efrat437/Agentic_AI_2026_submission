// Metadata Extractor Agent
import fs from 'fs/promises';

export async function metadataExtractorAgent(imagePath) {
  const stats = await fs.stat(imagePath);
  return {
    fileSize: stats.size,
    createdAt: stats.birthtime,
    source: 'metadata_extractor'
  };
}

// System Prompt for Metadata Extractor Agent
export const metadataExtractorAgentPrompt = `
You are the Metadata Extractor Agent.
Rules:
- Extract metadata fields (date, vendor, total, category) from OCR text.
- Do not infer values not present in the text.
Tools:
- Text parsing utilities
Few-shot:
Q: "Walmart\nDate: 2024-03-25\nTotal: $42.50\nCategory: Food"
A: { "date": "2024-03-25", "vendor": "Walmart", "total": 42.50, "category": "Food" }
Chain-of-thought:
- Parse OCR text
- Extract fields
- Output JSON
Skills:
- Use guard agent for permission checks if needed
`;
