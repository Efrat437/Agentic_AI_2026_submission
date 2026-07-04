import { chatCompletion } from '../services/llmService.js';
import { runSqlTool } from './sqlTool.js';
import { runRagTool } from './ragTool.js';
import { appendBufferEntry } from './memoryBuffer.js';
import { callTool } from '../mcp/client.js';
import { buildAgentSecurityPromptFramework } from './prompt_security_framework.js';

const DEFAULT_TOOL_BY_TYPE = {
  sql: 'sql_query',
  rag: 'rag_search',
  web: 'fetch_public_uri_json',
  request: 'new_request_for_government',
  action: 'sql_action',
  memory: 'store_memory',
};

async function toolCallingAgent({ step, userQuery, userId, results }) {
  const stepType = step?.type;
  const params = step?.params && typeof step.params === 'object' ? step.params : {};
  const stepQuery = params.query || userQuery;
  const toolName = step?.tool || DEFAULT_TOOL_BY_TYPE[stepType] || null;

  if (stepType === 'respond') {
    const system = `You are an agent that composes a final concise answer based on previous tool outputs.

${buildAgentSecurityPromptFramework({
  agentName: 'executor_respond',
  goal: 'Compose a final response from prior tool outputs without inventing evidence.',
  tools: [
    'Tool outputs produced by previous execution steps only.',
  ],
  outputContract: 'Return concise, grounded natural-language output only.',
})}`;
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: `User query: ${userQuery}\n\nTool outputs: ${JSON.stringify(results)}` }
    ];
    const answer = await chatCompletion({ messages, max_tokens: 300 });
    return {
      toolName: 'respond',
      result: { answer },
      payload: { stepType: 'respond', answerLength: String(answer || '').length }
    };
  }

  if (!toolName) return null;

  if (toolName === 'sql_query') {
    const result = await runSqlTool({ userQuery: stepQuery, systemPrompt: params.systemPrompt || '', userId });
    return { toolName, result, payload: { stepType: 'sql', query: stepQuery } };
  }

  if (toolName === 'rag_search') {
    const result = await runRagTool({ query: stepQuery, topK: params.topK || 5, useRerank: params.useRerank || false, systemPrompt: params.systemPrompt || '', userId });
    return { toolName, result, payload: { stepType: 'rag', query: stepQuery } };
  }

  if (toolName === 'sql_action') {
    const sql = params.sql;
    const sqlParams = Array.isArray(params.params) ? params.params : [];
    if (!sql || typeof sql !== 'string') {
      return { toolName, result: { error: 'sql_action requires params.sql' }, payload: { stepType: 'action', invalid: true } };
    }
    const result = await callTool('sql_action', { sql, params: sqlParams });
    return { toolName, result, payload: { stepType: 'action', sql } };
  }

  if (toolName === 'fetch_public_uri_json') {
    const url = params.url || stepQuery;
    const maxChars = Number(params.maxChars || 4000);
    const result = await callTool('fetch_public_uri_json', { url, maxChars });
    return { toolName, result, payload: { stepType: 'web', url } };
  }

  if (toolName === 'fetch_public_uris_json') {
    const urls = Array.isArray(params.urls) ? params.urls : [];
    const maxChars = Number(params.maxChars || 2500);
    const result = await callTool('fetch_public_uris_json', { urls, maxChars });
    return { toolName, result, payload: { stepType: 'web', urlCount: urls.length } };
  }

  const genericArgs = params && Object.keys(params).length > 0 ? params : { query: stepQuery };
  const result = await callTool(toolName, genericArgs);
  return { toolName, result, payload: { stepType: stepType || 'tool', tool: toolName } };
}

export async function executePlan({ plan = [], userQuery, userId = null } = {}) {
  const results = [];
  for (const step of plan) {
    const execution = await toolCallingAgent({ step, userQuery, userId, results });
    if (!execution) continue;
    results.push({ step, result: execution.result });
    appendBufferEntry({
      agent: 'tool-calling-agent',
      userId,
      type: 'step',
      payload: { ...execution.payload, tool: execution.toolName }
    });
  }
  appendBufferEntry({ agent: 'tool-calling-agent', userId, type: 'execution-finished', payload: { userQuery, stepCount: plan.length } });
  return results;
}
