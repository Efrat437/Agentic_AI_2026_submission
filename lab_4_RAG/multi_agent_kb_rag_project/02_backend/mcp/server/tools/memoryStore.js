import { remember } from '../../../agents/memoryTool.js';

export async function memoryStore(userId, content) {
  await remember({ userId, agent: 'mcp-memory', query: content, response: { stored: true } });
  return { ok: true };
}
