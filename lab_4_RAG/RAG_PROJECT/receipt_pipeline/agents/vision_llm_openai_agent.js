import { callVisionLLMAPI } from './vision_llm_api.js';
export async function visionLLMOpenAIAgent(imagePath) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  const endpoint = process.env.OPENAI_VISION_ENDPOINT || '';
  if (!apiKey || !endpoint) return null;
  return await callVisionLLMAPI(imagePath, apiKey, endpoint, 'openai');
}
