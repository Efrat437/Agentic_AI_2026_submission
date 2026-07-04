import 'dotenv/config';
import { runSQLRAG } from '../agents/sql_rag_agent.js';
import { runSemanticRAG } from '../agents/semantic_rag_agent.js';
import { compareBaselineVsLangGraph, runLangGraphRetrieval } from '../agents/langgraph_retrieval_agent.js';

function buildScientificSqlOptions({ topK }) {
  return {
    topK,
    evalMode: true,
    disableMemory: true,
    disableWrites: true,
    includeRagasReport: true,
    useGraph: true,
    sqlRewriteWithGraphTraversal: true,
    multiAnchorEnabled: true,
    proxyIndexLayerEnabled: true,
    semanticSimilarityInferenceEnabled: true,
    sqlIngestLayerEnabled: true,
  };
}

function parseArgs(argv = []) {
  const parsed = {
    branch: 'sql',
    query: process.env.RAG_PIPELINE_QUERY || 'Explain the relationship between housing and population in Tel Aviv',
    topK: Math.max(1, Number(process.env.LANGGRAPH_TOP_K || 8) || 8),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '');
    if (arg === '--branch') parsed.branch = String(argv[index + 1] || parsed.branch).trim().toLowerCase(), index += 1;
    else if (arg === '--query') parsed.query = String(argv[index + 1] || parsed.query), index += 1;
    else if (arg === '--top-k') parsed.topK = Math.max(1, Number(argv[index + 1] || parsed.topK) || parsed.topK), index += 1;
  }

  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scientificSqlOptions = buildScientificSqlOptions({ topK: args.topK });
  const totalBudgetMs = Number(process.env.LANGGRAPH_TOTAL_BUDGET_MS || 25000);
  let result;

  if (args.branch === 'sql') {
    result = await runSQLRAG({
      userQuery: args.query,
      systemPrompt: '',
      userId: 'pipeline-rag-sql',
      sqlOptions: scientificSqlOptions,
    });
  } else if (args.branch === 'semantic') {
    result = await runSemanticRAG({
      query: args.query,
      topK: args.topK,
      useRerank: true,
      userId: 'pipeline-rag-semantic',
      sqlOptions: scientificSqlOptions,
    });
  } else if (args.branch === 'langgraph-hybrid') {
    result = await runLangGraphRetrieval({
      query: args.query,
      userId: 'pipeline-rag-langgraph',
      evalMode: true,
      sqlOptions: {
        ...scientificSqlOptions,
        totalBudgetMs,
      },
    });
  } else if (args.branch === 'langgraph-compare') {
    result = await compareBaselineVsLangGraph({
      query: args.query,
      userId: 'pipeline-rag-langgraph',
      evalMode: true,
      sqlOptions: {
        ...scientificSqlOptions,
        totalBudgetMs,
      },
    });
  } else {
    throw new Error(`Unsupported branch: ${args.branch}`);
  }

  console.log(JSON.stringify({ ok: true, branch: args.branch, result }));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});