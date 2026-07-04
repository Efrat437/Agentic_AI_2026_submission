import { runSQLRAG, safeExecuteSelect, generateSelectSQL } from './sql_rag_agent.js';
import { appendBufferEntry } from './memoryBuffer.js';

export async function runSqlTool({ userQuery, systemPrompt = '', userId = null, sqlOptions = {} } = {}) {
  const result = await runSQLRAG({ userQuery, systemPrompt, userId, sqlOptions });
  appendBufferEntry({
    agent: 'sql-tool',
    userId,
    type: 'tool-result',
    payload: { userQuery, sql: result?.sql },
  });
  return result;
}

export { safeExecuteSelect, generateSelectSQL };
