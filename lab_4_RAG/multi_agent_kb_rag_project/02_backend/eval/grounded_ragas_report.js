import fs from 'fs';
import path from 'path';

const GROUNDED_EVAL_DATASET_PATH = path.resolve(process.cwd(), '02_backend', 'eval', 'langgraph_eval_dataset.json');

let groundedEvalDatasetCache = {
  mtimeMs: 0,
  items: [],
};

function normalizeEvalText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeEvalText(value = '') {
  return normalizeEvalText(value).split(' ').filter(Boolean);
}

function jaccardSimilarity(left = '', right = '') {
  const a = new Set(tokenizeEvalText(left));
  const b = new Set(tokenizeEvalText(right));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : Number((intersection / union).toFixed(4));
}

function tokenOverlapStats(answer = '', groundTruth = '') {
  const answerSet = new Set(tokenizeEvalText(answer));
  const truthSet = new Set(tokenizeEvalText(groundTruth));
  if (answerSet.size === 0 || truthSet.size === 0) {
    return { precision: 0, recall: 0 };
  }
  let overlap = 0;
  for (const token of answerSet) {
    if (truthSet.has(token)) overlap += 1;
  }
  return {
    precision: Number((overlap / answerSet.size).toFixed(4)),
    recall: Number((overlap / truthSet.size).toFixed(4)),
  };
}

function collectContextStrings(payload = {}) {
  const out = [];
  for (const row of payload?.rows || []) {
    out.push(JSON.stringify(row));
  }
  for (const doc of payload?.docs || []) {
    out.push(JSON.stringify(doc));
  }
  return out.slice(0, 20);
}

function loadGroundedEvalDataset() {
  try {
    const stat = fs.statSync(GROUNDED_EVAL_DATASET_PATH);
    if (groundedEvalDatasetCache.items.length > 0 && groundedEvalDatasetCache.mtimeMs === stat.mtimeMs) {
      return groundedEvalDatasetCache.items;
    }
    const parsed = JSON.parse(fs.readFileSync(GROUNDED_EVAL_DATASET_PATH, 'utf8'));
    groundedEvalDatasetCache = {
      mtimeMs: stat.mtimeMs,
      items: Array.isArray(parsed) ? parsed : [],
    };
    return groundedEvalDatasetCache.items;
  } catch (_err) {
    return [];
  }
}

function findGroundTruthEntry(query = '') {
  const normalizedQuery = normalizeEvalText(query);
  if (!normalizedQuery) return null;
  return loadGroundedEvalDataset().find((item) => normalizeEvalText(item?.query || '') === normalizedQuery) || null;
}

export function buildFrozenHarnessPathwayRecord({
  query,
  pathway,
  answer = '',
  rows = [],
  docs = [],
  llmMetrics = {},
  latencyMs = 0,
} = {}) {
  const groundTruthEntry = findGroundTruthEntry(query);
  const contexts = collectContextStrings({ rows, docs });
  return {
    pathway: String(pathway || 'unknown'),
    question: String(query || ''),
    answer: String(answer || ''),
    contexts,
    ground_truth: String(groundTruthEntry?.ground_truth_answer || ''),
    reference_contexts: Array.isArray(groundTruthEntry?.ground_truth_context)
      ? groundTruthEntry.ground_truth_context.map((item) => String(item || ''))
      : [],
    latency_ms: Number(latencyMs || 0),
    llm_calls_estimated: Number(llmMetrics?.summary?.callCount || 0),
    total_tokens: Number(llmMetrics?.summary?.totalTokens || 0),
    estimated_cost_usd: Number(llmMetrics?.summary?.estimatedCostUsd || 0),
    dataset_entry_id: groundTruthEntry?.id || null,
    ground_truth_available: Boolean(groundTruthEntry?.ground_truth_answer),
    harness_ready: Boolean(groundTruthEntry?.ground_truth_answer),
  };
}

function buildGroundedPathwayReport({ pathway, answer = '', contexts = [], llmMetrics = {}, latencyMs = 0, groundTruthEntry = null } = {}) {
  const groundTruthAnswer = String(groundTruthEntry?.ground_truth_answer || '');
  const referenceContexts = Array.isArray(groundTruthEntry?.ground_truth_context)
    ? groundTruthEntry.ground_truth_context.map((item) => String(item || ''))
    : [];
  const normalizedAnswer = normalizeEvalText(answer);
  const normalizedGroundTruth = normalizeEvalText(groundTruthAnswer);
  const overlap = tokenOverlapStats(answer, groundTruthAnswer);
  const exactMatch = normalizedAnswer && normalizedGroundTruth ? normalizedAnswer === normalizedGroundTruth : false;
  const contextMatches = referenceContexts.map((reference) => {
    const scored = contexts.map((context) => jaccardSimilarity(reference, context));
    return scored.length > 0 ? Math.max(...scored) : 0;
  });
  const contextRecall = contextMatches.length > 0
    ? Number((contextMatches.reduce((sum, value) => sum + value, 0) / contextMatches.length).toFixed(4))
    : null;
  const contextPrecision = contexts.length > 0
    ? Number((contexts.filter((context) => referenceContexts.some((reference) => jaccardSimilarity(reference, context) >= 0.2)).length / contexts.length).toFixed(4))
    : null;

  return {
    pathway,
    groundTruthAvailable: Boolean(groundTruthEntry && groundTruthAnswer),
    answer: {
      exactMatch,
      jaccard: groundTruthAnswer ? jaccardSimilarity(answer, groundTruthAnswer) : null,
      tokenPrecision: groundTruthAnswer ? overlap.precision : null,
      tokenRecall: groundTruthAnswer ? overlap.recall : null,
    },
    context: {
      referenceCount: referenceContexts.length,
      retrievedCount: contexts.length,
      precision: contextPrecision,
      recall: contextRecall,
    },
    efficiency: {
      latencyMs: Number(latencyMs || 0),
      llmCalls: Number(llmMetrics?.summary?.callCount || 0),
      totalTokens: Number(llmMetrics?.summary?.totalTokens || 0),
      estimatedCostUsd: Number(llmMetrics?.summary?.estimatedCostUsd || 0),
    },
  };
}

export function buildSinglePathwayRagasReport({
  query,
  pathway,
  answer = '',
  rows = [],
  docs = [],
  llmMetrics = {},
  latencyMs = 0,
} = {}) {
  const groundTruthEntry = findGroundTruthEntry(query);
  const report = buildGroundedPathwayReport({
    pathway,
    answer,
    contexts: collectContextStrings({ rows, docs }),
    llmMetrics,
    latencyMs,
    groundTruthEntry,
  });

  return {
    engine: 'grounded-local-ragas-lite',
    liveRequest: true,
    pathway,
    datasetEntry: groundTruthEntry
      ? {
          id: groundTruthEntry.id || null,
          category: groundTruthEntry.category || null,
          groundTruthAnswer: groundTruthEntry.ground_truth_answer || '',
          groundTruthContext: groundTruthEntry.ground_truth_context || [],
        }
      : null,
    report,
    note: groundTruthEntry
      ? 'Grounded live-report using the local evaluation dataset and RAGAS-style overlap metrics.'
      : 'No grounded dataset item matched this query, so only efficiency metrics are authoritative for this live report.',
  };
}