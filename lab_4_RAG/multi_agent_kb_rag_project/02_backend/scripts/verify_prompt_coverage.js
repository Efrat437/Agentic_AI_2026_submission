import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

const checks = [
  {
    label: 'query builder prompt covers SQL ingest layer and exposes prompt profile',
    file: '02_backend/agents/query_builder_agent.js',
    includes: ['ingestSqlTablesToRag', 'sqlIngestLayerEnabled', 'systemPromptProfile'],
  },
  {
    label: 'semantic agent prompt references ingestSqlTablesToRag',
    file: '02_backend/agents/semantic_rag_agent.js',
    includes: ['ingestSqlTablesToRag', 'sqlIngestLayerEnabled'],
  },
  {
    label: 'sql agent prompt references ingestSqlTablesToRag',
    file: '02_backend/agents/sql_rag_agent.js',
    includes: ['ingestSqlTablesToRag', 'sqlIngestLayerEnabled'],
  },
  {
    label: 'MCP tool registry advertises ingest bootstrap for semantic and hybrid tools',
    file: '02_backend/mcp/server/toolRegistry.js',
    includes: ['ingestSqlTablesToRag', 'sqlOptions', 'semantic_rag_query', 'hybrid_query'],
  },
  {
    label: 'MCP tool registry exposes classifier and action lifecycle tools',
    file: '02_backend/mcp/server/toolRegistry.js',
    includes: ['classify_query', 'action_propose', 'action_get', 'action_execute', 'classifyQueryTool', 'actionPropose', 'actionExecute'],
  },
  {
    label: 'react agent forwards sqlOptions to semantic and hybrid execution paths',
    file: '02_backend/agents/reactAgent.js',
    includes: ['ragArgs.sqlOptions = { ...step.params.sqlOptions };', 'hybridArgs.sqlOptions = { ...step.params.sqlOptions };'],
  },
  {
    label: 'ask orchestrator preserves and returns request profile for sql ingest layer',
    file: '02_backend/server.js',
    includes: ['normalizeAskSqlOptions', 'applyLayeredSqlOptionsToPlan', 'requestProfile', 'context?.sqlOptions'],
  },
  {
    label: 'frontend exposes dedicated ask and query-builder SQL ingest toggles',
    file: '01_fronted/index.html',
    includes: ['askSqlIngestLayerEnabled', 'qbSqlIngestLayerEnabled', 'renderSystemPromptProfileSummary', 'renderRequestProfileSummary'],
  },
  {
    label: 'frontend wires classifier and action agent endpoints',
    file: '01_fronted/index.html',
    includes: ['/api/classify', '/api/actions/propose', '/api/actions/execute', '/api/actions/${actionId}', 'runClassifier', 'runActionAction'],
  },
  {
    label: 'classifier agent has system prompt with rules, few-shot, chain-of-thought, ingestSqlTablesToRag awareness, and hybrid class',
    file: '02_backend/agents/classifier_agent.js',
    includes: ['CLASSIFIER_SYSTEM_PROMPT', 'ingestSqlTablesToRag', 'HYBRID', 'parseLlmAnswer', 'heuristicClassify', 'Answer: SQL | SEMANTIC | HYBRID'],
  },
  {
    label: 'action agent has schema-aware system prompt, few-shot, chain-of-thought, JSON fence stripping, and no hardcoded paths',
    file: '02_backend/agents/action_agent.js',
    includes: ['PROPOSE_SYSTEM_PROMPT', 'Few-shot examples', 'reasoning', 'replace(/^```', 'path.resolve(__dirname'],
  },
  {
    label: 'supervisor delegates classification to classifier_agent and maps sql/semantic/hybrid to route vocabulary',
    file: '02_backend/agents/supervisor.js',
    includes: ['classifyQuery', 'routeFromKind', 'buildSchemaGrounding', 'sql_query', 'rag_query', 'multi_step'],
  },
  {
    label: 'classifier agent prompt includes all 5 retrieval mechanisms',
    file: '02_backend/agents/classifier_agent.js',
    includes: ['M1 Cosine embedding similarity', 'M2 Semantic similarity inference', 'M3 Proxy index', 'M4 SQL rewrite', 'M5 Multi-anchor'],
  },
  {
    label: 'action agent prompt includes mechanism-aware SQL patterns for graph traversal and recursive SQL',
    file: '02_backend/agents/action_agent.js',
    includes: ['M1 Cosine embedding similarity', 'M4 Graph traversal', 'M5 Recursive SQL expansion', 'embedding <=> $1::vector'],
  },
];

async function readFile(relativePath) {
  const filePath = path.join(projectRoot, relativePath);
  return fs.readFile(filePath, 'utf8');
}

async function main() {
  const results = [];

  for (const check of checks) {
    const content = await readFile(check.file);
    const missing = check.includes.filter((needle) => !content.includes(needle));
    results.push({
      label: check.label,
      file: check.file,
      ok: missing.length === 0,
      missing,
    });
  }

  const failed = results.filter((item) => !item.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, checks: results }, null, 2));

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});