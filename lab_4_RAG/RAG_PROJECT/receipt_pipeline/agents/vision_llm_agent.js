import { callVisionLLMAPI } from './vision_llm_api.js';
export async function visionLLMAgent(imagePath) {
  // Use transformer-based Vision LLM as primary
  const apiKey = process.env.VISION_LLM_API_KEY || process.env.OPENAI_API_KEY || '';
  const endpoint = process.env.VISION_LLM_API_ENDPOINT || process.env.OPENAI_VISION_ENDPOINT || '';
  if (apiKey && endpoint) {
    const response = await callVisionLLMAPI(imagePath, apiKey, endpoint, 'vision_llm');
    if (response && response.total) {
      response.source = 'vision_llm';
      return response;
    }
  }
  // Fallback to OCR (Tesseract) only if Vision LLM fails
  const Tesseract = (await import('tesseract.js')).default;
  const { data: { text } } = await Tesseract.recognize(imagePath, 'eng');
  // Log raw text for debugging
  console.log('[VisionLLM OCR Raw Text]', text);
  // Enhanced extraction: prefer value on line with 'total', 'amount', 'credit', else largest value
  const lines = text.split(/\r?\n/);
  let keywordAmounts = [];
  let allAmounts = [];
  const keywordRegex = /total|amount|credit|balance|paid|sum/i;
  for (const line of lines) {
    // $-prefixed amounts
    const matches = Array.from(line.matchAll(/\$([\d,.]+)/g));
    for (const m of matches) {
      const value = parseFloat(m[1].replace(/,/g, ''));
      // Post-processing: if line contains 'price' or 'gallon' and value > $10, ignore as likely OCR error
      if (/price|gallon|per\s*gal|per\s*gallon/i.test(line) && value > 10) {
        continue;
      }
      allAmounts.push(value);
      if (keywordRegex.test(line)) {
        keywordAmounts.push(value);
      }
    }
    // Keyword-adjacent numbers (even if not $-prefixed)
    if (keywordRegex.test(line)) {
      // Find numbers like 60.07, 69.07, etc.
      const numMatches = Array.from(line.matchAll(/([\d]+[.][\d]+)/g));
      for (const n of numMatches) {
        const value = parseFloat(n[1].replace(/,/g, ''));
        keywordAmounts.push(value);
      }
    }
  }
  let bestTotal = null;
  if (keywordAmounts.length > 0) {
    bestTotal = Math.max(...keywordAmounts);
  } else if (allAmounts.length > 0) {
    bestTotal = Math.max(...allAmounts);
  }
  const currencyMatch = text.match(/\$|USD|CAD|GBP/);
  const dateMatch = text.match(/(\d{2}[\/\-]\d{2}[\/\-]\d{4})/);
  const categoryMatch = text.match(/Category[:\s]*([\w ]+)/i);
  return {
    date: dateMatch ? dateMatch[1] : null,
    total: bestTotal,
    currency: currencyMatch ? (currencyMatch[0] === '$' ? 'USD' : currencyMatch[0]) : null,
    category: categoryMatch ? categoryMatch[1].trim() : null,
    items: [],
    source: 'vision_llm_ocr_fallback',
    raw_text: text
  };
}

// System Prompt for Vision LLM Agent
export const visionLLMAgentPrompt = `
You are the Vision LLM Agent.
Rules:
- Only extract structured data from receipt images.
- Never hallucinate values.
Tools:
- Vision LLM API
Few-shot:
Q: [receipt image with date, total, category]
A: { "date": "2024-03-25", "total": 42.50, "category": "food" }
Chain-of-thought:
- Analyze image
- Extract fields
- Output JSON
Skills:
- Use annotation and scoring skills for post-processing
- Use guard agent for permission checks if needed
`;
