import { callTool } from '../mcp/client.js';
import { appendBufferEntry } from './memoryBuffer.js';
import { createLangchainMcpInvoker } from '../mcp/langchain/invokeLangchainMcpTool.js';

const MAX_REACT_STEPS = parseInt(process.env.MAX_REACT_STEPS || '6', 10);
const USE_LANGCHAIN_MCP_TOOLS = String(process.env.USE_LANGCHAIN_MCP_TOOLS || 'false').toLowerCase() === 'true';
const AGENT_LOG_NAME = 'tool-calling-agent';

export async function reactAgent(plan = [], query = '', { userId = null } = {}) {
  const results = [];
  const boundedPlan = Array.isArray(plan) ? plan.slice(0, Math.max(1, MAX_REACT_STEPS)) : [];
  const lcInvoke = USE_LANGCHAIN_MCP_TOOLS ? await createLangchainMcpInvoker() : null;

  const invokeTool = async (name, args = {}) => {
    if (!lcInvoke) {
      return callTool(name, args);
    }
    return lcInvoke(name, args);
  };

  if (Array.isArray(plan) && plan.length > boundedPlan.length) {
    appendBufferEntry({
      agent: AGENT_LOG_NAME,
      userId,
      type: 'execution-boundary',
      payload: {
        originalSteps: plan.length,
        executedSteps: boundedPlan.length,
        maxReactSteps: MAX_REACT_STEPS,
      },
    });
  }

  for (const step of boundedPlan) {
    const toolName = step.tool || (
      step.type === 'sql'
        ? 'sql_query'
        : step.type === 'rag'
          ? 'rag_search'
          : step.type === 'web'
            ? 'fetch_public_uri_json'
            : step.type === 'request'
                ? 'new_request_for_government'
          : step.type === 'action'
            ? 'sql_action'
            : step.type === 'memory'
              ? 'store_memory'
              : null
    );
    if (!toolName) continue;

    const stepQuery = step?.params?.query || query;
    const securityContext = step?.params?.securityContext && typeof step.params.securityContext === 'object'
      ? { ...step.params.securityContext }
      : null;

    if (toolName === 'sql_query') {
      const sqlOptions = step?.params?.sqlOptions && typeof step.params.sqlOptions === 'object'
        ? { ...step.params.sqlOptions }
        : {};
      if (step?.params?.contextTable && !sqlOptions.contextTable) {
        sqlOptions.contextTable = step.params.contextTable;
      }
      const r = await invokeTool('sql_query', { query: stepQuery, userId, sqlOptions, securityContext });
      results.push(r);
      appendBufferEntry({ agent: AGENT_LOG_NAME, userId, type: 'tool-call', payload: { tool: toolName, query: stepQuery } });
    }

    if (toolName === 'sql_rag_query') {
      const sqlOptions = step?.params?.sqlOptions && typeof step.params.sqlOptions === 'object'
        ? { ...step.params.sqlOptions }
        : {};
      if (step?.params?.contextTable && !sqlOptions.contextTable) {
        sqlOptions.contextTable = step.params.contextTable;
      }
      const r = await invokeTool('sql_rag_query', { query: stepQuery, userId, sqlOptions, securityContext });
      results.push(r);
      appendBufferEntry({ agent: AGENT_LOG_NAME, userId, type: 'tool-call', payload: { tool: toolName, query: stepQuery } });
    }

    if (toolName === 'rag_search') {
      const ragArgs = { query: stepQuery, userId };
      if (step?.params?.contextTable) {
        ragArgs.contextTable = step.params.contextTable;
      }
      if (step?.params?.topK !== undefined && step?.params?.topK !== null && Number.isFinite(Number(step.params.topK))) {
        ragArgs.topK = Math.max(1, Number(step.params.topK));
      }
      if (step?.params?.useRerank !== undefined && step?.params?.useRerank !== null) {
        ragArgs.useRerank = Boolean(step.params.useRerank);
      }
      if (step?.params?.sqlOptions && typeof step.params.sqlOptions === 'object') {
        ragArgs.sqlOptions = { ...step.params.sqlOptions };
      }
      if (securityContext) {
        ragArgs.securityContext = { ...securityContext };
      }
      const r = await invokeTool('rag_search', ragArgs);
      results.push(r);
      appendBufferEntry({ agent: AGENT_LOG_NAME, userId, type: 'tool-call', payload: { tool: toolName, query: stepQuery } });
    }

    if (toolName === 'semantic_rag_query') {
      const ragArgs = { query: stepQuery, userId };
      if (step?.params?.contextTable) {
        ragArgs.contextTable = step.params.contextTable;
      }
      if (step?.params?.topK !== undefined && step?.params?.topK !== null && Number.isFinite(Number(step.params.topK))) {
        ragArgs.topK = Math.max(1, Number(step.params.topK));
      }
      if (step?.params?.useRerank !== undefined && step?.params?.useRerank !== null) {
        ragArgs.useRerank = Boolean(step.params.useRerank);
      }
      if (step?.params?.sqlOptions && typeof step.params.sqlOptions === 'object') {
        ragArgs.sqlOptions = { ...step.params.sqlOptions };
      }
      if (securityContext) {
        ragArgs.securityContext = { ...securityContext };
      }
      const r = await invokeTool('semantic_rag_query', ragArgs);
      results.push(r);
      appendBufferEntry({ agent: AGENT_LOG_NAME, userId, type: 'tool-call', payload: { tool: toolName, query: stepQuery } });
    }

    if (toolName === 'hybrid_query') {
      const hybridArgs = { query: stepQuery, userId };
      if (securityContext) {
        hybridArgs.securityContext = { ...securityContext };
      }
      if (step?.params?.contextTable) {
        hybridArgs.contextTable = step.params.contextTable;
      }
      if (step?.params?.sqlOptions && typeof step.params.sqlOptions === 'object') {
        hybridArgs.sqlOptions = { ...step.params.sqlOptions };
      }
      const r = await invokeTool('hybrid_query', hybridArgs);
      results.push(r);
      appendBufferEntry({ agent: AGENT_LOG_NAME, userId, type: 'tool-call', payload: { tool: toolName, query: stepQuery } });
    }

    if (toolName === 'langgraph_retrieval_query') {
      const langgraphArgs = { query: stepQuery, userId };
      if (step?.params?.sessionId != null) {
        langgraphArgs.sessionId = step.params.sessionId;
      }
      if (step?.params?.threadId != null) {
        langgraphArgs.threadId = step.params.threadId;
      }
      if (step?.params?.evalMode != null) {
        langgraphArgs.evalMode = Boolean(step.params.evalMode);
      }
      if (step?.params?.sqlOptions && typeof step.params.sqlOptions === 'object') {
        langgraphArgs.sqlOptions = { ...step.params.sqlOptions };
      }
      const r = await invokeTool('langgraph_retrieval_query', langgraphArgs);
      results.push(r);
      appendBufferEntry({ agent: AGENT_LOG_NAME, userId, type: 'tool-call', payload: { tool: toolName, query: stepQuery } });
    }

    if (toolName === 'retrieval_compare') {
      const compareArgs = { query: stepQuery, userId };
      if (step?.params?.evalMode != null) {
        compareArgs.evalMode = Boolean(step.params.evalMode);
      }
      if (step?.params?.sqlOptions && typeof step.params.sqlOptions === 'object') {
        compareArgs.sqlOptions = { ...step.params.sqlOptions };
      }
      const r = await invokeTool('retrieval_compare', compareArgs);
      results.push(r);
      appendBufferEntry({ agent: AGENT_LOG_NAME, userId, type: 'tool-call', payload: { tool: toolName, query: stepQuery } });
    }

    if (toolName === 'retrieval_compare_eval') {
      const evalArgs = step?.params && typeof step.params === 'object'
        ? { ...step.params }
        : {};
      const r = await invokeTool('retrieval_compare_eval', evalArgs);
      results.push(r);
      appendBufferEntry({ agent: AGENT_LOG_NAME, userId, type: 'tool-call', payload: { tool: toolName } });
    }

    if (toolName === 'auto') {
      const autoArgs = { query: stepQuery, userId };
      if (securityContext) {
        autoArgs.securityContext = { ...securityContext };
      }
      const r = await invokeTool('auto', autoArgs);
      results.push(r);
      appendBufferEntry({ agent: AGENT_LOG_NAME, userId, type: 'tool-call', payload: { tool: toolName, query: stepQuery } });
    }

    if (toolName === 'sql_action') {
      const sql = step?.params?.sql;
      const params = Array.isArray(step?.params?.params) ? step.params.params : [];
      if (!sql || typeof sql !== 'string') {
        results.push({ error: 'sql_action requires params.sql' });
      } else {
        const r = await invokeTool('sql_action', { sql, params });
        results.push(r);
        appendBufferEntry({ agent: AGENT_LOG_NAME, userId, type: 'tool-call', payload: { tool: toolName, sql } });
      }
    }

    if (toolName === 'store_memory') {
      const content = step?.params?.content || stepQuery || query;
      const r = await invokeTool('store_memory', { userId, content });
      results.push(r);
      appendBufferEntry({ agent: AGENT_LOG_NAME, userId, type: 'tool-call', payload: { tool: toolName, contentLength: String(content || '').length } });
    }

    if (toolName === 'fetch_public_uri_json') {
      const url = step?.params?.url || stepQuery;
      const maxChars = Number(step?.params?.maxChars || 4000);
      const r = await invokeTool('fetch_public_uri_json', { url, maxChars });
      results.push(r);
      appendBufferEntry({ agent: AGENT_LOG_NAME, userId, type: 'tool-call', payload: { tool: toolName, url } });
    }

    if (toolName === 'fetch_public_uris_json') {
      const urls = Array.isArray(step?.params?.urls) ? step.params.urls : [];
      const maxChars = Number(step?.params?.maxChars || 2500);
      const r = await invokeTool('fetch_public_uris_json', { urls, maxChars });
      results.push(r);
      appendBufferEntry({ agent: AGENT_LOG_NAME, userId, type: 'tool-call', payload: { tool: toolName, urlCount: urls.length } });
    }

    if (toolName === 'new_request_for_goverment' || toolName === 'new_request_for_government' || toolName === 'get_request_status' || toolName === 'update_request_status' || toolName === 'ingest_municipality_web_to_rag' || toolName === 'ingest_sql_corpus_to_rag') {
      const args = step?.params && typeof step.params === 'object' ? step.params : { query: stepQuery };
      if (securityContext && (!args || typeof args.securityContext !== 'object')) {
        args.securityContext = { ...securityContext };
      }
      const r = await invokeTool(toolName, args);
      results.push(r);
      appendBufferEntry({ agent: AGENT_LOG_NAME, userId, type: 'tool-call', payload: { tool: toolName } });
    }
  }

  return results;
}
