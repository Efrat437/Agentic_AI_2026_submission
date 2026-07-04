import { chatCompletion } from '../services/llmService.js';
import { appendBufferEntry } from './memoryBuffer.js';
import { buildSchemaGrounding, formatSchemaGroundingForPrompt, getSchemaGraph } from './schemaGraph.js';
import { buildAgentSecurityPromptFramework } from './prompt_security_framework.js';

const MAX_PLANNER_STEPS = parseInt(process.env.MAX_PLANNER_STEPS || '6', 10);

function extractFirstJsonArray(text) {
  const s = String(text || '');
  const start = s.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (esc) {
        esc = false;
      } else if (ch === '\\') {
        esc = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[') depth++;
    if (ch === ']') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function isLikelyDbQuestion(text) {
  const q = String(text || '').toLowerCase();
  return /\b(table|tables|column|columns|row|rows|database|db|sql|count|how many|number of|node|nodes|relationship|relationships|attribute|attributes|district|city|program|plan|taba)\b/.test(q);
}

export async function plan({ userQuery, context = {}, userId = null } = {}) {
  // Ask LLM for a sequence of tool steps to execute.
  let schemaHint = null;
  try {
    const schema = await getSchemaGraph();
    const grounding = buildSchemaGrounding(userQuery, schema, { maxTables: 6, maxColumns: 30, maxForeignKeys: 15 });
    schemaHint = formatSchemaGroundingForPrompt(grounding);
  } catch (_e) {
    schemaHint = null;
  }

  const system = `You are a planner. Given a user query and context, return a JSON array of steps.
Each step must be an object with:
- type: 'sql'|'rag'|'web'|'request'|'action'|'memory'|'respond'
- tool: optional explicit MCP tool name: 'sql_query'|'sql_rag_query'|'rag_search'|'semantic_rag_query'|'hybrid_query'|'fetch_public_uri_json'|'fetch_public_uris_json'|'new_request_for_goverment'|'new_request_for_government'|'get_request_status'|'update_request_status'|'ingest_municipality_web_to_rag'|'ingest_sql_corpus_to_rag'|'sql_action'|'store_memory'
- description: string
- params: object

Internal agent/tool relevance map (must guide your planning):
- @sql_rag_agent.js: relation-aware SQL-RAG for graph/entity linkage questions.
- @semantic_rag_agent.js: semantic retrieval + synthesis over embedded corpora.
- @memoryTool.js: persistent memory operations via 'store_memory'.
- @query_builder_agent.js: structured query profile generation and SQL intent shaping.
- @ragTool.js: baseline RAG retrieval path for broad semantic lookup.
- @reactAgent.js: core tool-dispatch executor for step-by-step MCP calls.
- @reactExecutionAgent.js: compatibility/entry wrapper used by server/scripts to invoke @reactAgent.js.
- @reflectionAgent.js: post-execution quality check / refinement when answers conflict.
- @schemaGraph.js: schema grounding and FK-path hints for SQL planning.
- @sqlTool.js: direct SQL query execution path.

MCP layer relevance map (02_backend/mcp):
- @mcp/client.js: direct MCP REST client (callTool/callToolsBatch) used by executors.
- @mcp/server/toolRegistry.js: canonical name->handler registry and tool metadata.
- @mcp/server/httpServer.js: MCP HTTP endpoints (/mcp/tools, /mcp/call, /mcp/route-call, /mcp/decide).
- @mcp/server/tools/sqlQuery.js: wraps @sqlTool.js and serves sql_query/sql_rag_query.
- @mcp/server/tools/ragSearch.js: wraps @ragTool.js and serves rag_search/semantic_rag_query.
- @mcp/server/tools/sqlAction.js: mutation endpoint for explicit sql_action.
- @mcp/server/tools/memoryStore.js: wraps @memoryTool.js for store_memory.
- @mcp/server/tools/webPublicUris.js: approved public web fetch tools.
- @mcp/server/tools/governmentRequests.js: local-government request workflow handlers.
- @mcp/server/tools/localGovRag.js: municipality/sql corpus ingest and local RAG maintenance tools.
- @mcp/langchain/restMcpClient.js + @mcp/langchain/invokeLangchainMcpTool.js + @mcp/langchain/getMcpToolsAsLangChain.js: optional LangChain MCP tool invocation path.
- @mcp/toolServer.js: MCP server bootstrap.

Rules:
- Keep tool-calling at execution/orchestration layer (@reactExecutionAgent.js -> @reactAgent.js); do not embed new tool-calling orchestration inside leaf domain agents like @sql_rag_agent.js.
- Treat MCP HTTP server/transport (@mcp/server/httpServer.js) as transport + registry dispatch boundary, not a planner replacement.
- If executionMode indicates 'langgraph', produce steps that map cleanly to a LangGraph-style flow (route -> retrieve -> execute tools -> reflect), while remaining compatible with current executor.
- Use 'sql_query' (type 'sql') when a safe SELECT is enough and @sqlTool.js is sufficient.
- Use 'sql_rag_query' (type 'sql') when relationship traversal, entity-linking, or graph-aware SQL is needed (@sql_rag_agent.js + @schemaGraph.js).
- Use 'rag_search' (type 'rag') for baseline semantic lookup (@ragTool.js).
- Use 'semantic_rag_query' (type 'rag') when semantic reasoning/synthesis is required (@semantic_rag_agent.js).
- Use 'hybrid_query' when the user asks to combine structured DB facts and unstructured document context.
- Use 'action' only for explicit mutation requests and include params.sql + optional params.params array.
- Use 'web' for approved public website fetch requests and include params.url or params.urls.
- Use 'request' for local-government workflow actions (create/status/update).
- Use 'memory' to store notable user preferences or facts via @memoryTool.js.
- Prefer FK-aware SQL paths when the query asks about relationships between tables/entities.
- For multi-step orchestration, assume @reactExecutionAgent.js invokes @reactAgent.js, which calls MCP tools through @mcp/client.js.
- Add a final 'respond' step when combining prior outputs is needed; include reflection intent when sources conflict (@reflectionAgent.js).`;
  const systemWithSecurity = `${system}

${buildAgentSecurityPromptFramework({
  agentName: 'planner_agent',
  goal: 'Build a bounded, safe, tool-executable plan for the user query.',
  tools: [
    'MCP tools from toolRegistry: sql_query, sql_rag_query, rag_search, semantic_rag_query, hybrid_query, sql_action, store_memory, public web tools.',
    'Schema grounding + context inputs from supervisor and runtime.',
  ],
  outputContract: 'Return only a JSON array of step objects matching the required schema.',
})}`;
  const messages = [
    { role: 'system', content: systemWithSecurity },
    {
      role: 'user',
      content: `User query: ${userQuery}\n\nContext: ${JSON.stringify(context)}\n\nSchema grounding: ${schemaHint || 'unavailable'}`,
    }
  ];
  try {
    const out = await chatCompletion({ messages, max_tokens: 300 });
    // attempt to parse JSON out of response
    const jsonArrayText = extractFirstJsonArray(out);
    if (jsonArrayText) {
      const parsed = JSON.parse(jsonArrayText);
      const bounded = Array.isArray(parsed) ? parsed.slice(0, Math.max(1, MAX_PLANNER_STEPS)) : [];
      appendBufferEntry({
        agent: 'planner-agent',
        userId,
        type: 'plan',
        payload: {
          userQuery,
          stepCount: bounded.length,
          truncated: Array.isArray(parsed) && parsed.length > bounded.length,
          maxPlannerSteps: MAX_PLANNER_STEPS,
        },
      });
      return bounded.length > 0 ? bounded : [{ type: 'respond', description: 'Direct answer', params: {} }];
    }
    // fallback: DB-aware plan when parser cannot recover a valid JSON plan.
    const fallback = isLikelyDbQuestion(userQuery)
      ? [{ type: 'sql', tool: 'sql_rag_query', description: 'Fallback DB retrieval', params: {} }]
      : [{ type: 'rag', tool: 'rag_search', description: 'Fallback semantic retrieval', params: {} }];
    appendBufferEntry({ agent: 'planner-agent', userId, type: 'plan', payload: { userQuery, stepCount: 1, fallback: true } });
    return fallback;
  } catch (e) {
    const fallback = isLikelyDbQuestion(userQuery)
      ? [{ type: 'sql', tool: 'sql_rag_query', description: 'Fallback DB retrieval due planner error', params: {} }]
      : [{ type: 'rag', tool: 'rag_search', description: 'Fallback semantic retrieval due planner error', params: {} }];
    appendBufferEntry({ agent: 'planner-agent', userId, type: 'plan', payload: { userQuery, stepCount: 1, error: e.message } });
    return fallback;
  }
}
