import { getRecentMemories, saveMemory } from './dbTools.js';
import { appendBufferEntry, readBuffer, getBufferSnapshot, clearBuffer } from './memoryBuffer.js';

export async function remember({ userId = null, agent = 'agent', query = '', response = {} } = {}) {
  await saveMemory({ userId, agent, query, response });
  appendBufferEntry({
    agent,
    userId,
    type: 'memory-write',
    payload: { query, response },
  });
}

export function memoryTool({ agent, userId = null, limit = 5 } = {}) {
  return {
    recent: readBuffer({ agent, userId, limit }),
    snapshot: getBufferSnapshot({ userId }),
  };
}

export async function getConversationContext({ userId = null, limit = 6 } = {}) {
  const bounded = Math.max(1, Math.min(20, Number(limit) || 6));

  const shortTerm = readBuffer({ agent: 'orchestrator-ask', userId, limit: bounded }).map((entry) => ({
    source: 'short-term',
    ts: entry?.ts,
    query: entry?.payload?.query || '',
    decision: entry?.payload?.response?.decision || null,
    result: entry?.payload?.response?.result || [],
  }));

  const longTermRows = await getRecentMemories({ userId, agent: 'orchestrator-ask', limit: bounded });
  const longTerm = (longTermRows || []).map((row) => ({
    source: 'long-term',
    ts: row?.created_at,
    query: row?.query || '',
    decision: row?.response?.decision || null,
    result: row?.response?.result || [],
  }));

  const merged = [...shortTerm, ...longTerm]
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
    .slice(0, bounded)
    .map((item) => ({
      source: item.source,
      ts: item.ts,
      query: String(item.query || '').slice(0, 220),
      decision: item.decision,
      resultPreview: Array.isArray(item.result) ? item.result.slice(0, 2) : [],
    }));

  return merged;
}

export function resetConversationState({ userId = null, agent = null } = {}) {
  clearBuffer({ userId, agent });
  return { ok: true, userId, agent: agent || null };
}
