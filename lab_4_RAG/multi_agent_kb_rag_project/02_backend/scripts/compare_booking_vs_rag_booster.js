import 'dotenv/config';

import { performance } from 'node:perf_hooks';
import { ingestLocalGovernmentWebToRag } from '../making_operations/local_government/operations.js';
import { debugMatchAndRank, runSemanticRAG } from '../agents/semantic_rag_agent.js';
import { runTelAvivFullyAutomatedBooking } from '../making_operations/local_government/browser_appointment_agent.js';

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
  const raw = [parseArgValue('--url', ''), parseArgValue('--urls', '')].filter(Boolean).join(',');
  const urls = raw
    .split(/[\n,;]/)
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return Array.from(new Set(urls.length > 0 ? urls : [
    'https://www.ganeytikva.org.il/appointments/?id=15',
    'https://www.ganeytikva.org.il/appointments/?id=144&select-date=1',
  ]));
}

function timeIt(label, work) {
  const started = performance.now();
  return Promise.resolve()
    .then(work)
    .then((result) => ({
      label,
      ok: true,
      elapsedMs: Math.round(performance.now() - started),
      result,
      error: null,
    }))
    .catch((error) => ({
      label,
      ok: false,
      elapsedMs: Math.round(performance.now() - started),
      result: null,
      error: error?.message || String(error),
    }));
}

function summarizeDocs(docs = [], topK = 3) {
  return (Array.isArray(docs) ? docs : [])
    .slice(0, Math.max(1, Number(topK) || 3))
    .map((doc, index) => ({
      rank: index + 1,
      source: doc?.metadata?.source || doc?.metadata?.url || null,
      score: Number(doc?.score || doc?.combinedScore || doc?.rerankedScore || doc?.semanticScore || 0),
      preview: String(doc?.pageContent || doc?.description || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    }));
}

async function runStandaloneBookingProbe({ bookingUrl, query }) {
  const applicant = {
    firstName: String(process.env.APPT_FIRST_NAME || 'Efrat'),
    lastName: String(process.env.APPT_LAST_NAME || 'Hochma'),
    phone: String(process.env.APPT_PHONE || '0504245406'),
    email: String(process.env.APPT_EMAIL || 'hochmaefrat@gmail.com'),
    address: String(process.env.APPT_ADDRESS || 'Mivza Nahshon 41/5 Beer-sheva'),
    notes: query,
    preferredDate: '',
    preferredTime: '',
    preferredTimes: '',
    preferredTimeWindow: '',
    slotSelectionPolicy: 'score',
  };

  const result = await runTelAvivFullyAutomatedBooking({
    applicant,
    bookingUrl,
    intentText: query,
    dryRun: true,
    confirmedSubmit: false,
    headless: true,
    maxRuntimeMs: Math.max(45000, Number(process.env.BOOKING_PROBE_MAX_RUNTIME_MS || 90000) || 90000),
    pollIntervalMs: Math.max(1000, Number(process.env.BOOKING_PROBE_POLL_MS || 2500) || 2500),
    keepSessionOnFailure: false,
    allowHumanIntervention: false,
    humanInterventionTimeoutMs: Math.max(30000, Number(process.env.BOOKING_PROBE_HITL_TIMEOUT_MS || 60000) || 60000),
    requireFinalHumanApproval: false,
    autoApproveValidatedSubmit: false,
  });

  return {
    state: result?.session?.state || null,
    submitted: Boolean(result?.submitted),
    requiresHuman: Boolean(result?.requiresHuman),
    elapsedMs: Number(result?.elapsedMs || 0),
    selectedAppointmentOptions: Array.isArray(result?.session?.selectedAppointmentOptions) ? result.session.selectedAppointmentOptions : [],
    appointmentCandidatePreview: Array.isArray(result?.session?.appointmentCandidatePreview) ? result.session.appointmentCandidatePreview : [],
    finalValidation: result?.session?.finalValidation || null,
    confirmation: result?.session?.confirmation || null,
    session: result?.session || null,
  };
}

async function runStandaloneRag({ query, topK }) {
  const result = await runSemanticRAG({
    query,
    topK,
    useRerank: false,
    userId: 'benchmark-standalone-rag',
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

  return {
    docsRetrieved: Array.isArray(result?.docs) ? result.docs.length : 0,
    warnings: Array.isArray(result?.warnings) ? result.warnings : [],
    topDocs: summarizeDocs(result?.docs || [], 3),
    metrics: result?.metrics || {},
    advancedLayers: result?.advancedLayers || {},
  };
}

async function runStandaloneRagFast({ query, topK }) {
  const result = await debugMatchAndRank({ query, topK });

  return {
    docsRetrieved: Math.max(Array.isArray(result?.semantic) ? result.semantic.length : 0, Array.isArray(result?.bm25) ? result.bm25.length : 0),
    warnings: Array.isArray(result?.warnings) ? result.warnings : [],
    topDocs: [
      ...summarizeDocs(result?.semantic || [], 2),
      ...summarizeDocs(result?.bm25 || [], 1),
    ],
    metrics: result?.metrics || {},
    advancedLayers: {
      semanticCount: Array.isArray(result?.semantic) ? result.semantic.length : 0,
      bm25Count: Array.isArray(result?.bm25) ? result.bm25.length : 0,
    },
  };
}

async function runBooster({ urls, query, topK, replaceExisting, fastMode }) {
  const before = Date.now();
  const ingest = await ingestLocalGovernmentWebToRag({
    urls,
    replaceExisting,
    chunkSize: Math.max(450, Number(parseArgValue('--chunk-size', '900')) || 900),
    chunkOverlap: Math.max(50, Number(parseArgValue('--chunk-overlap', '120')) || 120),
    maxChunksPerUrl: Math.max(5, Number(parseArgValue('--max-chunks-per-url', '45')) || 45),
    minRelevanceScore: Math.max(0, Number(parseArgValue('--min-relevance-score', '1')) || 1),
    fetchTimeoutMs: Math.max(6000, Number(parseArgValue('--fetch-timeout-ms', '20000')) || 20000),
  });

  const rag = fastMode ? await runStandaloneRagFast({ query, topK }) : await runStandaloneRag({ query, topK });
  return {
    ingest,
    rag,
    elapsedMs: Date.now() - before,
  };
}

async function main() {
  const query = parseArgValue('--query', 'Ganey Tikva appointment booking flow and required steps');
  const topK = Math.max(1, Number(parseArgValue('--top-k', '8')) || 8);
  const urls = parseUrls();
  const bookingUrl = parseArgValue('--booking-url', urls[0] || 'https://www.ganeytikva.org.il/appointments/?id=144&select-date=1');
  const replaceExisting = !hasFlag('--no-replace');
  const fastMode = hasFlag('--fast');

  const standaloneBooking = await timeIt('standalone-booking', () => runStandaloneBookingProbe({ bookingUrl, query }));
  const standaloneRag = await timeIt(fastMode ? 'standalone-rag-fast' : 'standalone-rag', () => (
    fastMode ? runStandaloneRagFast({ query, topK }) : runStandaloneRag({ query, topK })
  ));
  const booster = await timeIt('html-rag-booking-booster', () => runBooster({ urls, query, topK, replaceExisting, fastMode }));

  const result = {
    ok: true,
    query,
    bookingUrl,
    urls,
    comparison: {
      standaloneBooking,
      standaloneRag,
      booster,
    },
    verdict: {
      bookingFastest: standaloneBooking.elapsedMs <= booster.elapsedMs && standaloneBooking.elapsedMs <= standaloneRag.elapsedMs,
      ragMostRetrievedDocs: (standaloneRag.result?.docsRetrieved || 0) >= (booster.result?.rag?.docsRetrieved || 0),
      boosterAddedFreshHtmlEvidence: Boolean(booster.result?.ingest?.inserted > 0 || booster.result?.ingest?.pageFailures > 0),
      note: 'Compare elapsedMs for pure speed; compare booster.rag.docsRetrieved and booster.ingest.inserted for quality/freshness gains.',
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
