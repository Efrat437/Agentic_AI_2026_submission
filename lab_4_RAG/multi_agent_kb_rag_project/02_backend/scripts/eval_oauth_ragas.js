/**
 * eval_oauth_ragas.js
 * Runs 8 OAuth PDF gold queries through the hybrid PDF retriever and
 * scores them with the same grounded-local-ragas-lite engine used by
 * the multi-agent compare pipeline.
 *
 * Run from multi_agent_kb_rag_project root:
 *   node ./02_backend/scripts/eval_oauth_ragas.js
 * or via npm:
 *   npm run eval:oauth:ragas
 */

import dotenv from 'dotenv';
dotenv.config();

// Stay fully in-memory — no DB needed for PDF retrieval
process.env.SKIP_SEMANTIC_HANDOFF = 'true';

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Import PDF RAG from sibling project (relative across packages; each resolves
// its own node_modules because both are ESM with their own package.json)
const RAG_SCRIPTS = pathToFileURL(
  path.resolve(__dirname, '../../../RAG_PROJECT/02_scripts/rag_process_enhanced.js')
).href;
const { buildStreamingRAG, queryRAG } = await import(RAG_SCRIPTS);

// Import the formal ragas engine from this project
import { buildSinglePathwayRagasReport } from '../eval/grounded_ragas_report.js';

// ----------------------------------------------------------------
// Gold query set — queries must match langgraph_eval_dataset.json
// entries exactly (after normalization).
// ----------------------------------------------------------------
const GOLD_QUERIES = [
  'What is PKCE and why is it important for OAuth?',
  'How do refresh tokens work in OAuth 2.0?',
  'Explain the authorization code flow in OAuth',
  'What are OAuth scopes and how are they used?',
  'How does OAuth prevent CSRF attacks using the state parameter?',
  'What is the client credentials grant in OAuth?',
  'What is a bearer token and how is it used?',
  'How does the OAuth implicit flow work?',
];

const PDF_PATH = path.resolve(__dirname, '../../../RAG_PROJECT/03_data/the-modern-guide-to-oauth.pdf');
const TOP_K = parseInt(process.env.TOP_K || '8', 10);

// ----------------------------------------------------------------
// Build in-memory RAG once, then query per entry
// ----------------------------------------------------------------
console.log(`\n${'═'.repeat(64)}`);
console.log(' OAuth PDF – Formal grounded-local-ragas-lite Evaluation');
console.log(`${'═'.repeat(64)}`);
console.log(`PDF : ${PDF_PATH}`);
console.log(`TOP_K: ${TOP_K}\n`);

const t0Ingest = Date.now();
const ragData = await buildStreamingRAG(PDF_PATH);
console.log(`\n[Eval] RAG ready in ${Date.now() - t0Ingest}ms\n`);

// ----------------------------------------------------------------
// Per-query evaluation
// ----------------------------------------------------------------
const summaryRows = [];

for (const query of GOLD_QUERIES) {
  const t0 = Date.now();
  const docs = await queryRAG(ragData, query);
  const latencyMs = Date.now() - t0;

  // Use retrieved chunk text as the "answer" (the PDF pipeline has no LLM generation step;
  // we use the best-scored chunk as a proxy answer for token metrics).
  const bestDoc = docs[0];
  const answer = bestDoc ? String(bestDoc.pageContent || '').slice(0, 800) : '';

  // Build the formal ragas report (looks up ground truth from langgraph_eval_dataset.json).
  // Strip metadata so JSON.stringify produces plain {"pageContent":"..."} — reducing
  // JSON-boilerplate dilution in the Jaccard similarity computation.
  const docsForRagas = docs.map((d) => ({ pageContent: String(d.pageContent || '').slice(0, 500) }));

  const report = buildSinglePathwayRagasReport({
    query,
    pathway: 'oauth-pdf-hybrid',
    answer,
    rows: [],
    docs: docsForRagas,
    llmMetrics: { summary: { callCount: 0, totalTokens: 0, estimatedCostUsd: 0 } },
    latencyMs,
  });

  const r = report?.report || {};
  const ctx = r?.context || {};
  const ans = r?.answer || {};
  const eff = r?.efficiency || {};

  const hit = ctx.recall !== null ? ctx.recall > 0 : null;

  console.log(`─ ${query.slice(0, 60)}`);
  console.log(`  groundTruthAvailable : ${r.groundTruthAvailable}`);
  console.log(`  context.recall       : ${ctx.recall !== null && ctx.recall !== undefined ? ctx.recall.toFixed(4) : 'N/A'}`);
  console.log(`  context.precision    : ${ctx.precision !== null && ctx.precision !== undefined ? ctx.precision.toFixed(4) : 'N/A'}`);
  console.log(`  answer.tokenRecall   : ${ans.tokenRecall !== null && ans.tokenRecall !== undefined ? ans.tokenRecall.toFixed(4) : 'N/A'}`);
  console.log(`  answer.tokenPrecision: ${ans.tokenPrecision !== null && ans.tokenPrecision !== undefined ? ans.tokenPrecision.toFixed(4) : 'N/A'}`);
  console.log(`  answer.jaccard       : ${ans.jaccard !== null && ans.jaccard !== undefined ? ans.jaccard.toFixed(4) : 'N/A'}`);
  console.log(`  answer.exactMatch    : ${ans.exactMatch}`);
  console.log(`  latencyMs            : ${eff.latencyMs}`);
  if (bestDoc) {
    const m = bestDoc.metadata || {};
    const prov = [m.page && `page ${m.page}`, m.chunkIndex !== undefined && `chunk ${m.chunkIndex}`].filter(Boolean).join(' | ');
    console.log(`  top chunk            : [${prov}] "${String(bestDoc.pageContent || '').slice(0, 90).replace(/\s+/g, ' ')}..."`);
  }
  console.log();

  summaryRows.push({
    query: query.slice(0, 45),
    groundTruth: r.groundTruthAvailable,
    ctxRecall: ctx.recall,
    ctxPrec: ctx.precision,
    tokRecall: ans.tokenRecall,
    tokPrec: ans.tokenPrecision,
    jaccard: ans.jaccard,
    latencyMs: eff.latencyMs,
  });
}

// ----------------------------------------------------------------
// Aggregate summary
// ----------------------------------------------------------------
const withGT = summaryRows.filter((r) => r.groundTruth);
const n = withGT.length;

function avg(rows, key) {
  const vals = rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

console.log(`${'═'.repeat(64)}`);
console.log(` Summary  (${n}/${summaryRows.length} queries had ground truth, TOP_K=${TOP_K})`);
console.log(`${'═'.repeat(64)}`);
console.log(`  Avg context recall    : ${avg(withGT, 'ctxRecall') !== null ? avg(withGT, 'ctxRecall').toFixed(4) : 'N/A'}`);
console.log(`  Avg context precision : ${avg(withGT, 'ctxPrec') !== null ? avg(withGT, 'ctxPrec').toFixed(4) : 'N/A'}`);
console.log(`  Avg token recall      : ${avg(withGT, 'tokRecall') !== null ? avg(withGT, 'tokRecall').toFixed(4) : 'N/A'}`);
console.log(`  Avg token precision   : ${avg(withGT, 'tokPrec') !== null ? avg(withGT, 'tokPrec').toFixed(4) : 'N/A'}`);
console.log(`  Avg answer jaccard    : ${avg(withGT, 'jaccard') !== null ? avg(withGT, 'jaccard').toFixed(4) : 'N/A'}`);
console.log(`  Avg latency           : ${avg(summaryRows, 'latencyMs') !== null ? avg(summaryRows, 'latencyMs').toFixed(0) : 'N/A'}ms`);
console.log(`${'═'.repeat(64)}\n`);

const ctxR = avg(withGT, 'ctxRecall');
const grade = ctxR === null ? 'N/A' : ctxR >= 0.4 ? 'Good' : ctxR >= 0.2 ? 'Fair' : 'Low (expected: Jaccard against keyword-rich refs)';
console.log(` Context recall grade: ${grade}`);
console.log(` Note: Jaccard-based context recall compares JSON-stringified chunks`);
console.log(` against keyword reference strings — values < 0.5 are normal for`);
console.log(` this metric; MRR/NDCG (from eval:enhanced) are the primary quality signal.\n`);
