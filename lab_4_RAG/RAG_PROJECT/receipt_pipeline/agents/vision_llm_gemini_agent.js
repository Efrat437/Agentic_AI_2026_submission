import { callVisionLLMAPI } from './vision_llm_api.js';
export async function visionLLMGeminiAgent(imagePath) {
  const apiKey = process.env.GEMINI_API_KEY || '';
  const endpoint = process.env.GEMINI_VISION_ENDPOINT || '';
  if (!apiKey || !endpoint) return null;
  return await callVisionLLMAPI(imagePath, apiKey, endpoint, 'gemini');
}
