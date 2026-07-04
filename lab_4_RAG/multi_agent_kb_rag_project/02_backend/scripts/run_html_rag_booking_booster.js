import 'dotenv/config';

import { ingestLocalGovernmentWebToRag, getLocalGovernmentRagStats } from '../making_operations/local_government/operations.js';
import { runSemanticRAG } from '../agents/semantic_rag_agent.js';
import { isDirectStructuredLookupQuery, runSQLRAG } from '../agents/sql_rag_agent.js';
import { compareBaselineVsLangGraph, runLangGraphRetrieval } from '../agents/langgraph_retrieval_agent.js';

function parseArgValue(flag, fallback = '') {
  const args = process.argv.slice(2);
  const idx = args.lastIndexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return String(args[idx + 1] || '').trim();
  return fallback;
}

function hasFlag(flag) {
  return process.argv.slice(2).includes(flag);
}

function parseUrls() {
  const fromSingle = parseArgValue('--url', '');
  const fromList = parseArgValue('--urls', '');
  const joined = [fromSingle, fromList]
    .filter(Boolean)
    .join(',');

  const parsed = joined
    .split(/[\n,;]/)
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  const defaults = [
    'https://www.ganeytikva.org.il/appointments/?id=15',
    'https://www.ganeytikva.org.il/appointments/?id=144&select-date=1',
  ];

  return Array.from(new Set(parsed.length ? parsed : defaults));
}

function normalizeTopDocs(docs = [], topK = 5) {
  return (Array.isArray(docs) ? docs : [])
    .slice(0, Math.max(1, Number(topK) || 5))
    .map((doc, index) => ({
      rank: index + 1,
      source: doc?.metadata?.source || doc?.metadata?.url || null,
      score: Number(doc?.combinedScore || doc?.rerankedScore || doc?.semanticScore || doc?.bm25Score || 0),
      textPreview: String(doc?.pageContent || doc?.description || '').replace(/\s+/g, ' ').trim().slice(0, 220),
    }));
}

function countStageEvidence(stageResult = {}) {
  const docs = Array.isArray(stageResult?.docs) ? stageResult.docs.length : 0;
  const rows = Array.isArray(stageResult?.rows) ? stageResult.rows.length : 0;
  const answer = String(stageResult?.answer || '').trim();
  const answerScore = answer ? 1 : 0;
  return {
    docs,
    rows,
    answer: Boolean(answer),
    coverageScore: Number((docs + (rows * 1.2) + answerScore).toFixed(2)),
  };
}

function pickWinningStage(stages = []) {
  const ranked = (Array.isArray(stages) ? stages : [])
    .filter((s) => s && s.executed)
    .sort((a, b) => Number(b?.evidence?.coverageScore || 0) - Number(a?.evidence?.coverageScore || 0));
  const winner = ranked[0] || null;
  return {
    winner: winner ? {
      stage: winner.stage,
      coverageScore: winner.evidence.coverageScore,
      docs: winner.evidence.docs,
      rows: winner.evidence.rows,
      answerPresent: winner.evidence.answer,
    } : null,
    ranking: ranked.map((item) => ({
      stage: item.stage,
      coverageScore: item.evidence.coverageScore,
      docs: item.evidence.docs,
      rows: item.evidence.rows,
      answerPresent: item.evidence.answer,
    })),
  };
}

function isHybridLikeQuery(query = '') {
  return /\b(relationship|related|between|compare|comparison|vs|versus|impact|linked|connected|similar|similarity|path|graph|anchor)\b/i
    .test(String(query || ''));
}

async function main() {
  const startedAt = Date.now();
  const urls = parseUrls();
  const query = parseArgValue('--query', 'Ganey Tikva appointment booking flow and required steps');
  const topK = Math.max(1, Number(parseArgValue('--top-k', parseArgValue('--topK', '8'))) || 8);
  const replaceExisting = hasFlag('--replace-existing');
  const enableSqlStage = hasFlag('--enable-sql-stage') || hasFlag('--with-sql');
  const forceSqlStage = hasFlag('--force-sql-stage');
  const enableLangGraphStage = hasFlag('--enable-langgraph-stage') || hasFlag('--with-langgraph');
  const forceLangGraphStage = hasFlag('--force-langgraph-stage');
  const enableQualityGate = hasFlag('--quality-gate') || hasFlag('--with-quality-gate');

  const beforeStats = await getLocalGovernmentRagStats();

  const ingestResult = await ingestLocalGovernmentWebToRag({
    urls,
    replaceExisting,
    chunkSize: Math.max(450, Number(parseArgValue('--chunk-size', '900')) || 900),
    chunkOverlap: Math.max(50, Number(parseArgValue('--chunk-overlap', '120')) || 120),
    maxChunksPerUrl: Math.max(5, Number(parseArgValue('--max-chunks-per-url', '45')) || 45),
    minRelevanceScore: Math.max(0, Number(parseArgValue('--min-relevance-score', '1')) || 1),
    fetchTimeoutMs: Math.max(6000, Number(parseArgValue('--fetch-timeout-ms', '20000')) || 20000),
  });

  const afterStats = await getLocalGovernmentRagStats();

  const retrieval = await runSemanticRAG({
    query,
    topK,
    useRerank: false,
    userId: 'pipeline-html-rag-booking-booster',
    sqlOptions: {
      evalMode: true,
      disableMemory: true,
      disableWrites: true,
      includeRagasReport: false,
      answerGenerationEnabled: false,
      sqlIngestLayerEnabled: true,
      semanticSimilarityInferenceEnabled: true,
      proxyIndexLayerEnabled: true,
      recursiveSqlEnabled: true,
      recursiveSqlMaxDepth: 2,
      useGraph: true,
      sqlRewriterEnabled: true,
      multiAnchorEnabled: true,
    },
  });

  const stageA = {
    stage: 'semantic_rag',
    executed: true,
    reason: 'default booster stage',
    evidence: countStageEvidence(retrieval),
    output: {
      answer: String(retrieval?.answer || ''),
      warnings: Array.isArray(retrieval?.warnings) ? retrieval.warnings : [],
      topDocs: normalizeTopDocs(retrieval?.docs, Math.min(8, topK)),
      metrics: retrieval?.metrics || {},
      advancedLayers: {
        semanticSimilarityInference: retrieval?.advancedLayers?.semanticSimilarityInference || {},
        proxyIndex: retrieval?.advancedLayers?.proxyIndex || retrieval?.proxyIndex || {},
        recursion: retrieval?.advancedLayers?.recursion || retrieval?.recursion || {},
      },
    },
  };

  const directStructuredIntent = isDirectStructuredLookupQuery(query);
  let sqlStage = {
    stage: 'sql_rag',
    executed: false,
    reason: 'not requested',
    evidence: { docs: 0, rows: 0, answer: false, coverageScore: 0 },
    output: null,
  };

  if (enableSqlStage && (forceSqlStage || directStructuredIntent)) {
    const sqlResult = await runSQLRAG({
      userQuery: query,
      userId: 'pipeline-html-rag-booking-booster',
      sqlOptions: {
        evalMode: true,
        disableMemory: true,
        disableWrites: true,
        includeRagasReport: false,
        answerGenerationEnabled: true,
        sqlIngestLayerEnabled: true,
        recursiveSqlEnabled: true,
        recursiveSqlMaxDepth: 2,
        proxyIndexLayerEnabled: true,
        semanticSimilarityInferenceEnabled: true,
        multiAnchorEnabled: true,
      },
    });

    sqlStage = {
      stage: 'sql_rag',
      executed: true,
      reason: forceSqlStage ? 'forced by flag' : 'direct structured intent detected',
      evidence: countStageEvidence(sqlResult),
      output: {
        answer: String(sqlResult?.answer || ''),
        sql: String(sqlResult?.sql || ''),
        rows: Array.isArray(sqlResult?.rows) ? sqlResult.rows.slice(0, 15) : [],
        metrics: sqlResult?.metrics || {},
        mechanism: sqlResult?.mechanism || null,
      },
    };
  } else if (enableSqlStage) {
    sqlStage.reason = 'query did not match direct structured intent';
  }

  const hybridIntent = isHybridLikeQuery(query);
  let langgraphStage = {
    stage: 'langgraph_retrieval',
    executed: false,
    reason: 'not requested',
    evidence: { docs: 0, rows: 0, answer: false, coverageScore: 0 },
    output: null,
  };

  if (enableLangGraphStage && (forceLangGraphStage || hybridIntent)) {
    const langgraph = await runLangGraphRetrieval({
      query,
      userId: 'pipeline-html-rag-booking-booster',
      evalMode: true,
      sqlOptions: {
        topK,
        totalBudgetMs: Math.max(20000, Number(parseArgValue('--langgraph-total-budget-ms', '25000')) || 25000),
        sqlIngestLayerEnabled: true,
      },
    });

    langgraphStage = {
      stage: 'langgraph_retrieval',
      executed: true,
      reason: forceLangGraphStage ? 'forced by flag' : 'hybrid/relationship intent detected',
      evidence: countStageEvidence({
        docs: langgraph?.mergedContext?.docs,
        rows: langgraph?.mergedContext?.rows,
        answer: langgraph?.answer,
      }),
      output: {
        answer: String(langgraph?.answer || ''),
        route: langgraph?.route || {},
        routeReason: langgraph?.routeReason || '',
        mechanism: langgraph?.mechanism || null,
        docs: normalizeTopDocs(langgraph?.mergedContext?.docs, Math.min(8, topK)),
        rows: Array.isArray(langgraph?.mergedContext?.rows) ? langgraph.mergedContext.rows.slice(0, 15) : [],
        metrics: langgraph?.metrics || {},
      },
    };
  } else if (enableLangGraphStage) {
    langgraphStage.reason = 'query did not match hybrid/relationship intent';
  }

  let qualityGate = {
    enabled: enableQualityGate,
    executed: false,
    reason: enableQualityGate ? 'awaiting branch execution' : 'disabled',
    comparison: null,
  };

  if (enableQualityGate) {
    const compareResult = await compareBaselineVsLangGraph({
      query,
      userId: 'pipeline-html-rag-booking-booster',
      evalMode: true,
      sqlOptions: {
        topK,
        totalBudgetMs: Math.max(20000, Number(parseArgValue('--langgraph-total-budget-ms', '25000')) || 25000),
        sqlIngestLayerEnabled: true,
      },
    });

    qualityGate = {
      enabled: true,
      executed: true,
      reason: 'computed baseline vs langgraph comparison',
      comparison: {
        ragasReport: compareResult?.ragasReport || null,
        comparison: compareResult?.comparison || null,
        baseline: {
          classification: compareResult?.baseline?.classification || null,
          latencyMs: Number(compareResult?.baseline?.metrics?.totalLatencyMs || 0),
          llmCallsEstimated: Number(compareResult?.baseline?.metrics?.llmCallsEstimated || 0),
        },
        langgraph: {
          route: compareResult?.langgraph?.route || null,
          latencyMs: Number(compareResult?.langgraph?.metrics?.totalLatencyMs || 0),
          llmCallsEstimated: Number(compareResult?.langgraph?.metrics?.llmCallsEstimated || 0),
        },
      },
    };
  }

  const winner = pickWinningStage([stageA, sqlStage, langgraphStage]);

  const docs = Array.isArray(retrieval?.docs) ? retrieval.docs : [];
  const totalDurationMs = Math.max(1, Date.now() - startedAt);
  const inserted = Number(ingestResult?.inserted || 0);

  const output = {
    ok: Boolean(ingestResult?.ok),
    mode: 'html-rag-booking-booster',
    query,
    urls,
    ingest: {
      ok: Boolean(ingestResult?.ok),
      inserted,
      deletedExisting: Number(ingestResult?.deletedExisting || 0),
      selectedUrlCount: Number(ingestResult?.observability?.selectedUrlCount || urls.length),
      pageFailures: Number(ingestResult?.observability?.failures?.pageFailures || 0),
      insertFailures: Number(ingestResult?.observability?.failures?.insertFailures || 0),
      durationMs: Number(ingestResult?.observability?.durationMs || 0),
      pages: Array.isArray(ingestResult?.pages) ? ingestResult.pages : [],
    },
    retrieval: {
      docsRetrieved: docs.length,
      warnings: Array.isArray(retrieval?.warnings) ? retrieval.warnings : [],
      topDocs: normalizeTopDocs(docs, Math.min(8, topK)),
      semanticSimilarityMatches: Array.isArray(retrieval?.advancedLayers?.semanticSimilarityInference?.embeddingMatches)
        ? retrieval.advancedLayers.semanticSimilarityInference.embeddingMatches.slice(0, 6)
        : [],
      metrics: retrieval?.metrics || {},
      stages: {
        semantic: stageA,
        sql: sqlStage,
        langgraph: langgraphStage,
      },
      winner,
      qualityGate,
    },
    ragStats: {
      before: beforeStats,
      after: afterStats,
      deltaDocs: Number(afterStats?.totalDocs || 0) - Number(beforeStats?.totalDocs || 0),
      deltaSources: Number(afterStats?.distinctSources || 0) - Number(beforeStats?.distinctSources || 0),
    },
    efficiency: {
      totalDurationMs,
      insertedDocsPerSecond: Number((inserted / (totalDurationMs / 1000)).toFixed(2)),
      retrievalDocsPerSecond: Number((docs.length / (totalDurationMs / 1000)).toFixed(2)),
    },
    recommendation: 'Use this booster before autonomous booking runs when site structure changes. It refreshes cleaned HTML evidence and retrieval priors; SQL/LangGraph stages can be enabled for structured and hybrid queries.',
  };

  process.stdout.write(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  process.stderr.write(String(error?.stack || error?.message || error));
  process.exitCode = 1;
});
