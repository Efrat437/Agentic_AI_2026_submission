import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { spawnSync } from 'child_process';
import { buildFrozenHarnessPathwayRecord } from '../eval/grounded_ragas_report.js';

const DEFAULT_QUERY = process.env.RAG_PIPELINE_QUERY || 'Explain the relationship between housing and population in Tel Aviv';
const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'tmp', 'rag-bootstrap-report.json');
const DEFAULT_DIRECT_BRANCH_TIMEOUT_MS = Math.max(10000, Number(process.env.RAG_PIPELINE_DIRECT_TIMEOUT_MS || 90000) || 90000);
const DEFAULT_LANGGRAPH_TIMEOUT_MS = Math.max(15000, Number(process.env.RAG_PIPELINE_LANGGRAPH_TIMEOUT_MS || 120000) || 120000);
const ISOLATED_BRANCH_SCRIPT = path.resolve(process.cwd(), '02_backend', 'scripts', 'run_rag_branch_isolated.js');

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

function summarizeScientificConfig({ topK }) {
  return {
    fairness: {
      evalMode: true,
      disableMemory: true,
      disableWrites: true,
      includeRagasReport: true,
    },
    retrievalLayers: {
      embeddingsAndCosineSimilarity: true,
      semanticSimilarityInferenceLayer: true,
      sqlRewriteWithGraphTraversal: true,
      multiAnchorRecursiveSql: true,
      proxyIndexLayer: true,
      ingestSqlTablesToRag: true,
      langgraphRetrievalLayer: true,
    },
    topK,
  };
}

function parseArgs(argv = []) {
  const parsed = {
    skipBootstrap: false,
    query: DEFAULT_QUERY,
    output: DEFAULT_OUTPUT,
    mode: 'all',
    topK: Math.max(1, Number(process.env.LANGGRAPH_TOP_K || 8) || 8),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '');
    if (arg === '--skip-bootstrap') parsed.skipBootstrap = true;
    else if (arg === '--query') parsed.query = String(argv[index + 1] || parsed.query), index += 1;
    else if (arg === '--output') parsed.output = path.resolve(process.cwd(), String(argv[index + 1] || parsed.output)), index += 1;
    else if (arg === '--mode') parsed.mode = String(argv[index + 1] || parsed.mode).trim().toLowerCase(), index += 1;
    else if (arg === '--top-k') parsed.topK = Math.max(1, Number(argv[index + 1] || parsed.topK) || parsed.topK), index += 1;
  }

  if (!['all', 'direct', 'sql', 'semantic', 'langgraph'].includes(parsed.mode)) {
    parsed.mode = 'all';
  }

  return parsed;
}

function runNpmScript(scriptName, maxAttempts = 3, timeoutMs = 600000) {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = spawnSync(npmCmd, ['run', scriptName], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status === 0) {
      return {
        script: scriptName,
        ok: true,
        stdout: String(result.stdout || '').trim(),
      };
    }
    lastError = new Error(`npm run ${scriptName} failed (attempt ${attempt}): ${result.stderr || result.stdout || `exit ${result.status}`}`.trim());
    if (attempt < maxAttempts) {
      console.warn(`[runNpmScript] Attempt ${attempt} failed for ${scriptName}, retrying...`);
    }
  }
  throw lastError;
}

function summarizeDirectReport(result = {}) {
  const report = result?.ragasReport?.report || null;
  return {
    ok: true,
    answer: result?.answer || null,
    metrics: result?.metrics || null,
    liveGroundedReport: report,
    reportProvenance: {
      mode: 'live-grounded-single-pathway',
      engine: result?.ragasReport?.engine || null,
      externalFrozenHarnessExecuted: false,
    },
  };
}

function summarizeHybridReport(result = {}) {
  return {
    ok: true,
    route: result?.route || null,
    routeReason: result?.routeReason || null,
    answer: result?.answer || null,
    metrics: result?.metrics || null,
    evalIsolation: result?.evalIsolation || null,
    mergedContext: result?.mergedContext || null,
  };
}

function summarizeCompareReport(result = {}) {
  return {
    ok: true,
    comparison: result?.comparison || null,
    ragasReport: result?.ragasReport || null,
    evalIsolation: result?.evalIsolation || null,
    baseline: result?.baseline || null,
    langgraph: result?.langgraph || null,
  };
}

function runIsolatedBranch(label, branchName, query, topK, timeoutMs) {
  const startedAt = Date.now();
  try {
    const child = spawnSync(process.execPath, [ISOLATED_BRANCH_SCRIPT, '--branch', branchName, '--query', query, '--top-k', String(topK)], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (child.error) {
      throw child.error;
    }

    if (child.status !== 0) {
      throw new Error((child.stderr || child.stdout || `${label} exited with code ${child.status}`).trim());
    }

    const parsed = JSON.parse(String(child.stdout || '{}'));
    const result = parsed?.result ?? null;
    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      result,
      error: null,
      branch: branchName,
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      result: null,
      error: error?.message || String(error),
      branch: branchName,
    };
  }
}

function buildBenchmarkArtifacts({ query, sql, semantic, langgraphHybrid, langgraphCompare }) {
  const baselineResult = langgraphCompare?.baseline?.result || {};
  const langgraphResult = langgraphCompare?.langgraph || {};
  return {
    engine: 'external-frozen-harness-ready-records',
    externalHarnessExecuted: false,
    note: 'These records are decoupled from the live grounded reports and are structured for frozen external benchmark harnesses such as Python RAGAS runs.',
    pathways: {
      sql: sql
        ? buildFrozenHarnessPathwayRecord({
            query,
            pathway: 'sql',
            answer: sql.answer,
            rows: sql.rows,
            llmMetrics: sql.llmMetrics,
            latencyMs: sql.metrics?.totalLatencyMs,
          })
        : null,
      semantic: semantic
        ? buildFrozenHarnessPathwayRecord({
            query,
            pathway: 'semantic',
            answer: semantic.answer,
            docs: semantic.docs,
            llmMetrics: semantic.llmMetrics,
            latencyMs: semantic.metrics?.totalLatencyMs,
          })
        : null,
      langgraphHybrid: langgraphHybrid
        ? buildFrozenHarnessPathwayRecord({
            query,
            pathway: 'langgraph-hybrid',
            answer: langgraphHybrid.answer,
            rows: langgraphHybrid.mergedContext?.rows,
            docs: langgraphHybrid.mergedContext?.docs,
            llmMetrics: langgraphHybrid.llmMetrics,
            latencyMs: langgraphHybrid.metrics?.totalLatencyMs,
          })
        : null,
      baselineCompare: baselineResult
        ? buildFrozenHarnessPathwayRecord({
            query,
            pathway: 'baseline-compare',
            answer: baselineResult.answer,
            rows: baselineResult.rows || baselineResult.mergedContext?.rows,
            docs: baselineResult.docs || baselineResult.mergedContext?.docs,
            llmMetrics: langgraphCompare?.baseline?.llmMetrics,
            latencyMs: langgraphCompare?.baseline?.metrics?.totalLatencyMs,
          })
        : null,
      langgraphCompare: langgraphResult
        ? buildFrozenHarnessPathwayRecord({
            query,
            pathway: 'langgraph-compare',
            answer: langgraphResult.answer,
            rows: langgraphResult.mergedContext?.rows,
            docs: langgraphResult.mergedContext?.docs,
            llmMetrics: langgraphResult.llmMetrics,
            latencyMs: langgraphResult.metrics?.totalLatencyMs,
          })
        : null,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  // --- PATCH: Recommend direct shell run if subprocess fails ---
  let bootstrap;
  if (args.skipBootstrap) {
    bootstrap = { skipped: true };
  } else {
    try {
      bootstrap = runNpmScript('pipeline:bootstrap', 3, 900000);
    } catch (err) {
      console.error('[PATCHED run_rag_bootstrap_and_report] pipeline:bootstrap failed as subprocess.');
      console.error('To avoid this error, always run "npm run pipeline:bootstrap" directly in your shell before running this script.');
      process.exitCode = 2;
      return;
    }
  }
  // --- PATCH: Recommend direct shell run if subprocess fails ---

  const runSql = ['all', 'direct', 'sql'].includes(args.mode);
  const runSemantic = ['all', 'direct', 'semantic'].includes(args.mode);
  const runLanggraph = ['all', 'langgraph'].includes(args.mode);

  const sqlBranch = runSql
    ? runIsolatedBranch('sql-rag', 'sql', args.query, args.topK, DEFAULT_DIRECT_BRANCH_TIMEOUT_MS)
    : { ok: false, skipped: true, result: null, error: null, elapsedMs: 0 };

  const semanticBranch = runSemantic
    ? runIsolatedBranch('semantic-rag', 'semantic', args.query, args.topK, DEFAULT_DIRECT_BRANCH_TIMEOUT_MS)
    : { ok: false, skipped: true, result: null, error: null, elapsedMs: 0 };

  const langgraphHybridBranch = runLanggraph
    ? runIsolatedBranch('langgraph-hybrid', 'langgraph-hybrid', args.query, args.topK, DEFAULT_LANGGRAPH_TIMEOUT_MS)
    : { ok: false, skipped: true, result: null, error: null, elapsedMs: 0 };

  const langgraphCompareBranch = runLanggraph
    ? runIsolatedBranch('langgraph-compare', 'langgraph-compare', args.query, args.topK, DEFAULT_LANGGRAPH_TIMEOUT_MS)
    : { ok: false, skipped: true, result: null, error: null, elapsedMs: 0 };

  const sql = sqlBranch.result;
  const semantic = semanticBranch.result;
  const langgraphHybrid = langgraphHybridBranch.result;
  const langgraphCompare = langgraphCompareBranch.result;

  const report = {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    mode: args.mode,
    query: args.query,
    bootstrap,
    scientificConfig: summarizeScientificConfig({ topK: args.topK }),
    branchStatus: {
      sql: { ok: Boolean(sqlBranch.ok), error: sqlBranch.error, elapsedMs: sqlBranch.elapsedMs },
      semantic: { ok: Boolean(semanticBranch.ok), error: semanticBranch.error, elapsedMs: semanticBranch.elapsedMs },
      langgraphHybrid: { ok: Boolean(langgraphHybridBranch.ok), error: langgraphHybridBranch.error, elapsedMs: langgraphHybridBranch.elapsedMs },
      langgraphCompare: { ok: Boolean(langgraphCompareBranch.ok), error: langgraphCompareBranch.error, elapsedMs: langgraphCompareBranch.elapsedMs },
    },
    direct: {
      sql: sql ? summarizeDirectReport(sql) : null,
      semantic: semantic ? summarizeDirectReport(semantic) : null,
    },
    hybrid: {
      langgraph: langgraphHybrid ? summarizeHybridReport(langgraphHybrid) : null,
    },
    comparison: {
      langgraphVsBaseline: langgraphCompare ? summarizeCompareReport(langgraphCompare) : null,
    },
    benchmarkHarness: buildBenchmarkArtifacts({ query: args.query, sql, semantic, langgraphHybrid, langgraphCompare }),
    note: 'Dedicated scientific RAG pipeline: pipeline bootstrap + isolated direct SQL-RAG + isolated direct Semantic-RAG + pure LangGraph hybrid retrieval + LangGraph-vs-baseline compare, with fair evaluation isolation and advanced retrieval layers enabled by default.',
  };

  await fs.mkdir(path.dirname(args.output), { recursive: true });
  await fs.writeFile(args.output, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, output: args.output, generatedAt: report.generatedAt, elapsedMs: report.elapsedMs }, null, 2));
}

main().catch((err) => {
  console.error('[run_rag_bootstrap_and_report] failed:', err?.stack || err?.message || String(err));
  process.exitCode = 1;
});