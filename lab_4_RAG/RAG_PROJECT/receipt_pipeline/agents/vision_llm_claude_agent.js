import { callVisionLLMAPI } from './vision_llm_api.js';
export async function visionLLMClaudeAgent(imagePath) {
  const apiKey = process.env.CLAUDE_API_KEY || '';
  const endpoint = process.env.CLAUDE_VISION_ENDPOINT || '';
  if (!apiKey || !endpoint) return null;
  return await callVisionLLMAPI(imagePath, apiKey, endpoint, 'claude');
}
