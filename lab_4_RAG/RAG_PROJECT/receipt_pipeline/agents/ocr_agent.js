// OCR Agent (stub)
// Replace with actual OCR logic (e.g., Tesseract.js)
import Tesseract from 'tesseract.js';
export async function ocrAgent(imagePath) {
  // Use Tesseract.js to extract text from the image
  const { data: { text } } = await Tesseract.recognize(imagePath, 'eng');
  // Log raw text for debugging
  console.log('[OCR Raw Text]', text);
  // Extract all monetary values
  const moneyMatches = Array.from(text.matchAll(/\$([\d,.]+)/g)).map(m => parseFloat(m[1].replace(/,/g, '')));
  // Heuristic: pick the largest value as total
  const total = moneyMatches.length > 0 ? Math.max(...moneyMatches) : null;
  // Try to extract currency
  const currencyMatch = text.match(/\$|USD|CAD|GBP/);
  // Try to extract date
  const dateMatch = text.match(/(\d{2}[\/\-]\d{2}[\/\-]\d{4})/);
  // Try to extract category
  const categoryMatch = text.match(/Category[:\s]*([\w ]+)/i);
  return {
    date: dateMatch ? dateMatch[1] : null,
    total,
    currency: currencyMatch ? (currencyMatch[0] === '$' ? 'USD' : currencyMatch[0]) : null,
    category: categoryMatch ? categoryMatch[1].trim() : null,
    items: [],
    source: 'ocr',
    raw_text: text
  };
}

// System Prompt for OCR Agent
export const ocrAgentPrompt = `
You are the OCR Agent.
Rules:
- Only extract raw text from receipt images.
- Do not interpret or summarize content.
Tools:
- OCR API
Few-shot:
Q: [receipt image]
A: "Walmart\nDate: 2024-03-25\nTotal: $42.50\nCategory: Food"
Chain-of-thought:
- Run OCR on image
- Output raw text
Skills:
- Use guard agent for permission checks if needed
`;
