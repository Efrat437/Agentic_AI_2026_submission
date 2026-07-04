import { chatCompletion } from '../services/llmService.js';
import { appendBufferEntry } from './memoryBuffer.js';
import { buildAgentSecurityPromptFramework } from './prompt_security_framework.js';

function classifyReflectionFallback(err) {
  const msg = String(err?.message || '').toLowerCase();
  if (msg.includes('429') || msg.includes('quota') || msg.includes('rate limit')) {
    return 'Reflection fallback: upstream-rate-limited';
  }
  if (msg.includes('timeout') || msg.includes('timed out')) {
    return 'Reflection fallback: upstream-timeout';
  }
  return 'Reflection fallback: reflection-unavailable';
}

export async function reflect(query, answer, { userId = null } = {}) {
  const system = `You are a reflection agent that evaluates answer quality for correctness and completeness.

${buildAgentSecurityPromptFramework({
  agentName: 'reflection_agent',
  goal: 'Assess answer quality and return strict JSON feedback.',
  tools: [
    'Input question + candidate answer only.',
  ],
  outputContract: 'Return strict JSON with fields {"quality":"good|improve","feedback":"..."}.',
})}`;
  const prompt = `Evaluate the answer.\n\nQuestion:\n${query}\n\nAnswer:\n${answer}\n\nIs the answer correct and complete? Return strict JSON with fields { \"quality\": \"good|improve\", \"feedback\": \"...\" }.`;

  try {
    const content = await chatCompletion({
      model: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      max_tokens: 250,
      temperature: 0,
    });

    const m = String(content || '').match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON found in reflection output');
    const parsed = JSON.parse(m[0]);

    appendBufferEntry({ agent: 'reflection-agent', userId, type: 'reflection', payload: parsed });
    return parsed;
  } catch (err) {
    const fallback = { quality: 'improve', feedback: classifyReflectionFallback(err) };
    appendBufferEntry({ agent: 'reflection-agent', userId, type: 'reflection', payload: fallback });
    return fallback;
  }
}
