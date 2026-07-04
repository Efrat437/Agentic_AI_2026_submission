import { compareBaselineVsLangGraph, runLangGraphRetrieval } from '../../../agents/langgraph_retrieval_agent.js';
import { runRagasCompareEvaluation } from '../../../scripts/eval_ragas_compare.js';

export async function langgraphRetrievalQuery({
  query,
  userId = null,
  sessionId = null,
  threadId = null,
  evalMode = false,
  sqlOptions = {},
} = {}) {
  return runLangGraphRetrieval({
    query,
    userId,
    sessionId,
    threadId,
    evalMode: Boolean(evalMode),
    sqlOptions: sqlOptions || {},
  });
}

export async function compareRetrievalPathways({
  query,
  userId = null,
  evalMode = true,
  sqlOptions = {},
} = {}) {
  return compareBaselineVsLangGraph({
    query,
    userId,
    evalMode: Boolean(evalMode),
    sqlOptions: sqlOptions || {},
  });
}

export async function runRetrievalCompareEvaluation({
  baseUrl = process.env.EVAL_BASE_URL || 'http://127.0.0.1:3000',
  dataset = null,
  output = '',
  limit = 0,
  topK = Number(process.env.LANGGRAPH_TOP_K || 8),
} = {}) {
  return runRagasCompareEvaluation({
    baseUrl,
    dataset: dataset || undefined,
    output,
    limit: Math.max(0, Number(limit || 0) || 0),
    topK: Math.max(1, Number(topK || 8) || 8),
  });
}