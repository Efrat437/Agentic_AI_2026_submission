import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_ARTIFACT = path.resolve(process.cwd(), 'tmp', 'rag-scientific-report.json');

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

function evaluateRecord(record = {}) {
  const answer = String(record.answer || '');
  const groundTruth = String(record.ground_truth || '');
  const contexts = Array.isArray(record.contexts) ? record.contexts.map((item) => String(item || '')) : [];
  const referenceContexts = Array.isArray(record.reference_contexts) ? record.reference_contexts.map((item) => String(item || '')) : [];
  const overlap = tokenOverlapStats(answer, groundTruth);
  const contextRecall = referenceContexts.length > 0
    ? Number((referenceContexts
      .map((reference) => {
        const scored = contexts.map((context) => jaccardSimilarity(reference, context));
        return scored.length > 0 ? Math.max(...scored) : 0;
      })
      .reduce((sum, value) => sum + value, 0) / referenceContexts.length).toFixed(4))
    : null;
  const contextPrecision = contexts.length > 0
    ? Number((contexts.filter((context) => referenceContexts.some((reference) => jaccardSimilarity(reference, context) >= 0.2)).length / contexts.length).toFixed(4))
    : null;

  return {
    datasetEntryId: record.dataset_entry_id || null,
    answer: {
      jaccard: groundTruth ? jaccardSimilarity(answer, groundTruth) : null,
      tokenPrecision: groundTruth ? overlap.precision : null,
      tokenRecall: groundTruth ? overlap.recall : null,
      exactMatch: normalizeEvalText(answer) !== '' && normalizeEvalText(answer) === normalizeEvalText(groundTruth),
    },
    context: {
      retrievedCount: contexts.length,
      referenceCount: referenceContexts.length,
      precision: contextPrecision,
      recall: contextRecall,
    },
    efficiency: {
      latencyMs: Number(record.latency_ms || 0),
      llmCallsEstimated: Number(record.llm_calls_estimated || 0),
      totalTokens: Number(record.total_tokens || 0),
      estimatedCostUsd: Number(record.estimated_cost_usd || 0),
    },
  };
}

export async function runFrozenRagasRecordsEvaluation({ artifactPath = DEFAULT_ARTIFACT } = {}) {
  const resolvedPath = path.resolve(process.cwd(), artifactPath);
  const raw = await fs.readFile(resolvedPath, 'utf8');
  const artifact = JSON.parse(raw);
  const benchmark = artifact?.benchmarkHarness || {};
  const pathways = benchmark?.pathways && typeof benchmark.pathways === 'object' ? benchmark.pathways : {};

  const readyItems = Object.entries(pathways).filter(([, record]) => record && typeof record === 'object' && record.harness_ready);
  if (readyItems.length === 0) {
    throw new Error('No harness-ready benchmark records found in artifact.');
  }

  const evaluatedPathways = Object.fromEntries(
    readyItems.map(([name, record]) => [name, {
      pathway: name,
      record,
      report: evaluateRecord(record),
    }]),
  );

  return {
    artifact: resolvedPath,
    engine: 'grounded-local-ragas-lite-js-frozen-records',
    note: 'JavaScript frozen-record evaluator over the scientific artifact benchmark records. This remains distinct from the live grounded pathway reports attached during execution.',
    evaluatedPathways,
  };
}

async function main() {
  const artifactArgIndex = process.argv.indexOf('--artifact');
  const artifactPath = artifactArgIndex >= 0 ? process.argv[artifactArgIndex + 1] : DEFAULT_ARTIFACT;
  const report = await runFrozenRagasRecordsEvaluation({ artifactPath });
  console.log(JSON.stringify(report, null, 2));
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    console.error('[eval_frozen_ragas_records] failed:', err?.message || String(err));
    process.exitCode = 1;
  });
}