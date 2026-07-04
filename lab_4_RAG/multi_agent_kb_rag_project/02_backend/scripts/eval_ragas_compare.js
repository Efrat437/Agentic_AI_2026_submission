import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';

const DEFAULT_BASE_URL = process.env.EVAL_BASE_URL || 'http://127.0.0.1:3000';
const DEFAULT_DATASET_PATH = path.resolve(process.cwd(), '02_backend', 'eval', 'langgraph_eval_dataset.json');

function parseArgs(argv = []) {
  const out = {
    baseUrl: DEFAULT_BASE_URL,
    dataset: DEFAULT_DATASET_PATH,
    output: '',
    limit: 0,
    topK: Number(process.env.LANGGRAPH_TOP_K || 8),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '');
    if (arg === '--base-url') out.baseUrl = String(argv[++i] || out.baseUrl);
    else if (arg === '--dataset') out.dataset = path.resolve(process.cwd(), String(argv[++i] || out.dataset));
    else if (arg === '--output') out.output = path.resolve(process.cwd(), String(argv[++i] || ''));
    else if (arg === '--limit') out.limit = Math.max(0, Number(argv[++i] || 0) || 0);
    else if (arg === '--top-k') out.topK = Math.max(1, Number(argv[++i] || out.topK) || out.topK);
  }

  return out;
}

function toNumber(value, digits = 4) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(digits));
}

async function postJson(baseUrl, payload) {
  const response = await fetch(`${String(baseUrl || '').replace(/\/$/, '')}/api/eval/retrieval-compare`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.API_KEY || process.env.PUBLIC_API_KEY || 'dev-key',
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error || `HTTP ${response.status}`);
  }
  return body;
}

function normalizePathwaySummary(pathway = {}) {
  return {
    answer: {
      exactMatch: Boolean(pathway?.answer?.exactMatch),
      jaccard: toNumber(pathway?.answer?.jaccard),
      tokenPrecision: toNumber(pathway?.answer?.tokenPrecision),
      tokenRecall: toNumber(pathway?.answer?.tokenRecall),
    },
    context: {
      precision: toNumber(pathway?.context?.precision),
      recall: toNumber(pathway?.context?.recall),
      referenceCount: Number(pathway?.context?.referenceCount || 0),
      retrievedCount: Number(pathway?.context?.retrievedCount || 0),
    },
    efficiency: {
      latencyMs: Number(pathway?.efficiency?.latencyMs || 0),
      llmCalls: Number(pathway?.efficiency?.llmCalls || 0),
      totalTokens: Number(pathway?.efficiency?.totalTokens || 0),
      estimatedCostUsd: toNumber(pathway?.efficiency?.estimatedCostUsd, 6),
    },
  };
}

function buildExampleSummary(compareResponse = {}, item = {}) {
  const ragasReport = compareResponse?.ragasReport || {};
  return {
    id: item.id || null,
    category: item.category || 'uncategorized',
    query: item.query || '',
    datasetEntry: ragasReport?.datasetEntry || null,
    comparison: compareResponse?.comparison || {},
    baseline: normalizePathwaySummary(ragasReport?.baseline),
    langgraph: normalizePathwaySummary(ragasReport?.langgraph),
    conclusion: ragasReport?.conclusion || {},
  };
}

function average(items = [], selector = () => 0, digits = 4) {
  if (!items.length) return 0;
  const total = items.reduce((sum, item) => sum + Number(selector(item) || 0), 0);
  return Number((total / items.length).toFixed(digits));
}

function summarizeExamples(examples = []) {
  const summary = {
    count: examples.length,
    winners: {
      accuracy: {},
      efficiency: {},
      overall: {},
    },
    baseline: {
      exactMatchRate: 0,
      averageJaccard: 0,
      averageTokenPrecision: 0,
      averageTokenRecall: 0,
      averageContextPrecision: 0,
      averageContextRecall: 0,
      averageLatencyMs: 0,
      averageLlmCalls: 0,
      averageTokens: 0,
      averageCostUsd: 0,
    },
    langgraph: {
      exactMatchRate: 0,
      averageJaccard: 0,
      averageTokenPrecision: 0,
      averageTokenRecall: 0,
      averageContextPrecision: 0,
      averageContextRecall: 0,
      averageLatencyMs: 0,
      averageLlmCalls: 0,
      averageTokens: 0,
      averageCostUsd: 0,
    },
  };

  for (const example of examples) {
    const accuracyWinner = String(example?.conclusion?.accuracyWinner || 'unavailable');
    const efficiencyWinner = String(example?.conclusion?.efficiencyWinner || 'unavailable');
    const overallWinner = String(example?.conclusion?.overallWinner || 'unavailable');
    summary.winners.accuracy[accuracyWinner] = Number(summary.winners.accuracy[accuracyWinner] || 0) + 1;
    summary.winners.efficiency[efficiencyWinner] = Number(summary.winners.efficiency[efficiencyWinner] || 0) + 1;
    summary.winners.overall[overallWinner] = Number(summary.winners.overall[overallWinner] || 0) + 1;
  }

  summary.baseline.exactMatchRate = average(examples, (item) => item?.baseline?.answer?.exactMatch ? 1 : 0, 4);
  summary.baseline.averageJaccard = average(examples, (item) => item?.baseline?.answer?.jaccard);
  summary.baseline.averageTokenPrecision = average(examples, (item) => item?.baseline?.answer?.tokenPrecision);
  summary.baseline.averageTokenRecall = average(examples, (item) => item?.baseline?.answer?.tokenRecall);
  summary.baseline.averageContextPrecision = average(examples, (item) => item?.baseline?.context?.precision);
  summary.baseline.averageContextRecall = average(examples, (item) => item?.baseline?.context?.recall);
  summary.baseline.averageLatencyMs = average(examples, (item) => item?.baseline?.efficiency?.latencyMs, 2);
  summary.baseline.averageLlmCalls = average(examples, (item) => item?.baseline?.efficiency?.llmCalls, 2);
  summary.baseline.averageTokens = average(examples, (item) => item?.baseline?.efficiency?.totalTokens, 2);
  summary.baseline.averageCostUsd = average(examples, (item) => item?.baseline?.efficiency?.estimatedCostUsd, 6);

  summary.langgraph.exactMatchRate = average(examples, (item) => item?.langgraph?.answer?.exactMatch ? 1 : 0, 4);
  summary.langgraph.averageJaccard = average(examples, (item) => item?.langgraph?.answer?.jaccard);
  summary.langgraph.averageTokenPrecision = average(examples, (item) => item?.langgraph?.answer?.tokenPrecision);
  summary.langgraph.averageTokenRecall = average(examples, (item) => item?.langgraph?.answer?.tokenRecall);
  summary.langgraph.averageContextPrecision = average(examples, (item) => item?.langgraph?.context?.precision);
  summary.langgraph.averageContextRecall = average(examples, (item) => item?.langgraph?.context?.recall);
  summary.langgraph.averageLatencyMs = average(examples, (item) => item?.langgraph?.efficiency?.latencyMs, 2);
  summary.langgraph.averageLlmCalls = average(examples, (item) => item?.langgraph?.efficiency?.llmCalls, 2);
  summary.langgraph.averageTokens = average(examples, (item) => item?.langgraph?.efficiency?.totalTokens, 2);
  summary.langgraph.averageCostUsd = average(examples, (item) => item?.langgraph?.efficiency?.estimatedCostUsd, 6);

  return summary;
}

export async function runRagasCompareEvaluation({
  baseUrl = DEFAULT_BASE_URL,
  dataset = DEFAULT_DATASET_PATH,
  output = '',
  limit = 0,
  topK = Number(process.env.LANGGRAPH_TOP_K || 8),
} = {}) {
  const normalizedDataset = path.resolve(process.cwd(), String(dataset || DEFAULT_DATASET_PATH));
  const normalizedOutput = output ? path.resolve(process.cwd(), String(output)) : '';
  const rawDataset = await fs.readFile(normalizedDataset, 'utf8');
  const parsedDataset = JSON.parse(rawDataset);
  const items = Array.isArray(parsedDataset) ? parsedDataset : (Array.isArray(parsedDataset?.examples) ? parsedDataset.examples : []);
  const usableItems = items.filter((item) => item?.query && item?.ground_truth_answer);
  const selectedItems = limit > 0 ? usableItems.slice(0, limit) : usableItems;

  if (!selectedItems.length) {
    throw new Error(`Dataset contains no usable items with query and ground_truth_answer: ${normalizedDataset}`);
  }

  const examples = [];
  for (let index = 0; index < selectedItems.length; index += 1) {
    const item = selectedItems[index];
    console.log(`[ragas-js ${index + 1}/${selectedItems.length}] ${item.query}`);
    const compareResponse = await postJson(baseUrl, {
      query: item.query,
      userId: item.userId || 'eval-ragas-js',
      evalMode: true,
      sqlOptions: {
        topK,
        evalMode: true,
        disableMemory: true,
        disableWrites: true,
        sqlIngestLayerEnabled: false,
      },
    });
    examples.push(buildExampleSummary(compareResponse, item));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    engine: 'grounded-local-ragas-lite-js',
    baseUrl,
    dataset: normalizedDataset,
    summary: summarizeExamples(examples),
    examples,
    note: 'JavaScript evaluator that aggregates the live compare endpoint and its attached RAGAS-style report. The Python evaluator remains available for full Python RAGAS package runs.',
  };

  if (normalizedOutput) {
    await fs.mkdir(path.dirname(normalizedOutput), { recursive: true });
    await fs.writeFile(normalizedOutput, JSON.stringify(report, null, 2), 'utf8');
    console.log(`Saved report to ${normalizedOutput}`);
  }
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await runRagasCompareEvaluation(args);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[eval_ragas_compare] failed:', err?.message || String(err));
    process.exitCode = 1;
  });
}