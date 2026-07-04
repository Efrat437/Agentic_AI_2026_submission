import { runSemanticRAG } from './semantic_rag_agent.js';
import { appendBufferEntry } from './memoryBuffer.js';

export async function runRagTool({ query, topK = 5, useRerank = false, systemPrompt = '', userId = null, sqlOptions = {} } = {}) {
  const result = await runSemanticRAG({ query, topK, useRerank, systemPrompt, userId, sqlOptions });
  appendBufferEntry({
    agent: 'rag-tool',
    userId,
    type: 'tool-result',
    payload: {
      query,
      topK,
      hits: Array.isArray(result?.docs) ? result.docs.length : 0,
      sqlIngestLayerEnabled: sqlOptions?.sqlIngestLayerEnabled,
    },
  });
  return result;
}
