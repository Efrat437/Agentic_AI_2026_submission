import OpenAI from 'openai';
import dotenv from 'dotenv';
import { buildAgentSecurityPromptFramework } from '../agents/prompt_security_framework.js';

dotenv.config();

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const client = openai;

export async function askLLM(prompt) {
  if (!client) {
    return '';
  }
  const response = await client.chat.completions.create({
    model: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You are an AI reasoning agent.\n\n${buildAgentSecurityPromptFramework({
          agentName: 'llm_service_default',
          goal: 'Provide safe, policy-aligned reasoning assistance for backend agent workflows.',
          tools: ['User prompt input and explicit runtime context only.'],
          outputContract: 'Return concise useful output aligned to the caller request.',
        })}`,
      },
      { role: 'user', content: prompt }
    ],
    max_tokens: 1500
  });

  const text = response.choices?.[0]?.message?.content;
  return text || '';
}

export async function chatCompletion({ model = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini', messages = [], max_tokens = 500, temperature = 0 }) {
  if (!openai) {
    // Deterministic fallback so routing/planning can still run in local tests.
    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
    if (String(lastUserMessage).toLowerCase().includes('return strict json')) {
      return '{"route":"multi_step","reason":"fallback-without-openai"}';
    }
    return '[{"type":"rag","description":"Fallback semantic retrieval","params":{}},{"type":"respond","description":"Fallback compose","params":{}}]';
  }
  const resp = await openai.chat.completions.create({ model, messages, max_tokens, temperature });
  return resp.choices?.[0]?.message?.content?.trim();
}

export async function createEmbedding(text, model = 'text-embedding-3-small') {
  if (!openai) return null;
  const resp = await openai.embeddings.create({ model, input: text });
  return resp.data?.[0]?.embedding || null;
}
