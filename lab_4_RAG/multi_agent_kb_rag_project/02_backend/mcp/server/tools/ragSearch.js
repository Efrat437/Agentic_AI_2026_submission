import { runRagTool } from '../../../agents/ragTool.js';
import { sanitizeUserSystemPrompt } from '../../../security/input_guards.js';

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function ragSearch(query, userId = null, systemPrompt = '', sqlOptions = {}, topK = undefined, useRerank = undefined) {
  const timeoutMs = Number(process.env.MCP_RAG_TIMEOUT_MS || '20000');
  try {
    const promptDecision = sanitizeUserSystemPrompt(systemPrompt, { source: 'mcp:rag_search' });
    if (promptDecision.rejected) {
      throw new Error(`Rejected unsafe systemPrompt: ${promptDecision.reason}`);
    }

    const ragArgs = {
      query,
      userId,
      systemPrompt: promptDecision.value,
      sqlOptions,
    };
    if (topK !== undefined && topK !== null && Number.isFinite(Number(topK))) {
      ragArgs.topK = Math.max(1, Number(topK));
    }
    if (useRerank !== undefined && useRerank !== null) {
      ragArgs.useRerank = Boolean(useRerank);
    }

    return await withTimeout(runRagTool(ragArgs), timeoutMs, 'rag_search');
  } catch (err) {
    // Degrade gracefully so /ask can still complete even if semantic retrieval is slow.
    return {
      answer: 'Semantic retrieval is temporarily unavailable. Please try again or use a structured database query.',
      docs: [],
      degraded: true,
      error: err.message,
    };
  }
}
