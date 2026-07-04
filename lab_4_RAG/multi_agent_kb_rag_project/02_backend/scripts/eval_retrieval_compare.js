import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';

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

  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] || '');
    if (arg === '--base-url') out.baseUrl = String(argv[++i] || out.baseUrl);
    else if (arg === '--dataset') out.dataset = path.resolve(process.cwd(), String(argv[++i] || out.dataset));
    else if (arg === '--output') out.output = path.resolve(process.cwd(), String(argv[++i] || ''));
    else if (arg === '--limit') out.limit = Math.max(0, Number(argv[++i] || 0) || 0);
    else if (arg === '--top-k') out.topK = Math.max(1, Number(argv[++i] || out.topK) || out.topK);
  }
  return out;
}

function normalizeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value = '') {
  return normalizeText(value).split(' ').filter(Boolean);
}

function jaccardSimilarity(a = '', b = '') {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : Number((intersection / union).toFixed(4));
}

function buildExampleSummary(item = {}) {
  const comparison = item?.comparison || {};
  const baselineAnswer = String(item?.baseline?.result?.answer || '');
  const langgraphAnswer = String(item?.langgraph?.answer || '');
  const groundTruth = String(item?.groundTruthAnswer || '');
  return {
    id: item.id,
    category: item.category,
    query: item.query,
    baselineLatencyMs: Number(item?.baseline?.metrics?.totalLatencyMs || 0),
    langgraphLatencyMs: Number(item?.langgraph?.metrics?.totalLatencyMs || 0),
    baselineTokens: Number(item?.baseline?.llmMetrics?.summary?.totalTokens || 0),
    langgraphTokens: Number(item?.langgraph?.llmMetrics?.summary?.totalTokens || 0),
    baselineCostUsd: Number(item?.baseline?.llmMetrics?.summary?.estimatedCostUsd || 0),
    langgraphCostUsd: Number(item?.langgraph?.llmMetrics?.summary?.estimatedCostUsd || 0),
    baselineLlmCalls: Number(item?.baseline?.llmMetrics?.summary?.callCount || 0),
    langgraphLlmCalls: Number(item?.langgraph?.llmMetrics?.summary?.callCount || 0),
    langgraphBranches: item?.langgraph?.route?.branches || [],
    latencyDeltaMs: Number(comparison?.latencyDeltaMs || 0),
    tokenDelta: Number(comparison?.totalTokens?.langgraph || 0) - Number(comparison?.totalTokens?.baseline || 0),
    costDeltaUsd: Number(comparison?.estimatedCostUsd?.langgraph || 0) - Number(comparison?.estimatedCostUsd?.baseline || 0),
    baselineGroundTruthJaccard: groundTruth ? jaccardSimilarity(baselineAnswer, groundTruth) : null,
    langgraphGroundTruthJaccard: groundTruth ? jaccardSimilarity(langgraphAnswer, groundTruth) : null,
  };
}

function summarizeExamples(examples = []) {
  const summary = {
    count: examples.length,
    averageBaselineLatencyMs: 0,
    averageLanggraphLatencyMs: 0,
    averageBaselineTokens: 0,
    averageLanggraphTokens: 0,
    averageBaselineCostUsd: 0,
    averageLanggraphCostUsd: 0,
    averageBaselineLlmCalls: 0,
    averageLanggraphLlmCalls: 0,
    averageLatencyDeltaMs: 0,
    averageTokenDelta: 0,
    averageCostDeltaUsd: 0,
    averageBaselineGroundTruthJaccard: null,
    averageLanggraphGroundTruthJaccard: null,
  };
  if (examples.length === 0) return summary;

  const groundTruthExamples = examples.filter((item) => item.baselineGroundTruthJaccard != null && item.langgraphGroundTruthJaccard != null);
  for (const item of examples) {
    summary.averageBaselineLatencyMs += item.baselineLatencyMs;
    summary.averageLanggraphLatencyMs += item.langgraphLatencyMs;
    summary.averageBaselineTokens += item.baselineTokens;
    summary.averageLanggraphTokens += item.langgraphTokens;
    summary.averageBaselineCostUsd += item.baselineCostUsd;
    summary.averageLanggraphCostUsd += item.langgraphCostUsd;
    summary.averageBaselineLlmCalls += item.baselineLlmCalls;
    summary.averageLanggraphLlmCalls += item.langgraphLlmCalls;
    summary.averageLatencyDeltaMs += item.latencyDeltaMs;
    summary.averageTokenDelta += item.tokenDelta;
    summary.averageCostDeltaUsd += item.costDeltaUsd;
  }

  summary.averageBaselineLatencyMs = Number((summary.averageBaselineLatencyMs / examples.length).toFixed(2));
  summary.averageLanggraphLatencyMs = Number((summary.averageLanggraphLatencyMs / examples.length).toFixed(2));
  summary.averageBaselineTokens = Number((summary.averageBaselineTokens / examples.length).toFixed(2));
  summary.averageLanggraphTokens = Number((summary.averageLanggraphTokens / examples.length).toFixed(2));
  summary.averageBaselineCostUsd = Number((summary.averageBaselineCostUsd / examples.length).toFixed(6));
  summary.averageLanggraphCostUsd = Number((summary.averageLanggraphCostUsd / examples.length).toFixed(6));
  summary.averageBaselineLlmCalls = Number((summary.averageBaselineLlmCalls / examples.length).toFixed(2));
  summary.averageLanggraphLlmCalls = Number((summary.averageLanggraphLlmCalls / examples.length).toFixed(2));
  summary.averageLatencyDeltaMs = Number((summary.averageLatencyDeltaMs / examples.length).toFixed(2));
  summary.averageTokenDelta = Number((summary.averageTokenDelta / examples.length).toFixed(2));
  summary.averageCostDeltaUsd = Number((summary.averageCostDeltaUsd / examples.length).toFixed(6));

  if (groundTruthExamples.length > 0) {
    summary.averageBaselineGroundTruthJaccard = Number((groundTruthExamples.reduce((acc, item) => acc + item.baselineGroundTruthJaccard, 0) / groundTruthExamples.length).toFixed(4));
    summary.averageLanggraphGroundTruthJaccard = Number((groundTruthExamples.reduce((acc, item) => acc + item.langgraphGroundTruthJaccard, 0) / groundTruthExamples.length).toFixed(4));
  }

  return summary;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawDataset = await fs.readFile(args.dataset, 'utf8');
  const dataset = JSON.parse(rawDataset);
  const examples = Array.isArray(dataset) ? dataset : (Array.isArray(dataset?.examples) ? dataset.examples : []);
  const selected = args.limit > 0 ? examples.slice(0, args.limit) : examples;
  const results = [];

  for (let index = 0; index < selected.length; index++) {
    const item = selected[index] || {};
    const query = String(item.query || '').trim();
    if (!query) continue;

    console.log(`[eval ${index + 1}/${selected.length}] ${query}`);
    const response = await postJson(args.baseUrl, {
      query,
      userId: item.userId || 'eval-js-runner',
      sqlOptions: {
        topK: args.topK,
        answerGenerationEnabled: true,
      },
    });

    results.push(buildExampleSummary({
      ...response,
      id: item.id || index + 1,
      category: item.category || 'uncategorized',
      query,
      groundTruthAnswer: item.ground_truth_answer || item.groundTruthAnswer || '',
    }));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    dataset: args.dataset,
    summary: summarizeExamples(results),
    examples: results,
  };

  const formatted = JSON.stringify(report, null, 2);
  if (args.output) {
    await fs.mkdir(path.dirname(args.output), { recursive: true });
    await fs.writeFile(args.output, formatted, 'utf8');
    console.log(`Saved report to ${args.output}`);
  }
  console.log(formatted);
}

main().catch((err) => {
  console.error('[eval_retrieval_compare] failed:', err?.message || String(err));
  process.exitCode = 1;
});