import 'dotenv/config';
import { appendBufferEntry, readBuffer } from './memoryBuffer.js';
import { getRecentMemories } from './dbTools.js';
import { remember } from './memoryTool.js';
import { runSQLRAG } from './sql_rag_agent.js';
import { runSemanticRAG } from './semantic_rag_agent.js';
import { runSqlTool } from './sqlTool.js';
import { runRagTool } from './ragTool.js';
import { callToolsBatch } from '../mcp/client.js';
import { buildAgentSecurityPromptFramework } from './prompt_security_framework.js';

const DEFAULT_MAX_CYCLES = parseInt(process.env.QUERY_BUILDER_MAX_CYCLES || '3', 10);
const MAX_SQL_CANDIDATES = parseInt(process.env.QUERY_BUILDER_MAX_SQL_CANDIDATES || '5', 10);
const MAX_SEMANTIC_CANDIDATES = parseInt(process.env.QUERY_BUILDER_MAX_SEMANTIC_CANDIDATES || '5', 10);
const EXECUTION_TIMEOUT_MS = parseInt(process.env.QUERY_BUILDER_EXEC_TIMEOUT_MS || '120000', 10);
const QUERY_BUILDER_USE_GRAPH = String(process.env.QUERY_BUILDER_USE_GRAPH || 'true').toLowerCase() === 'true';
const QUERY_BUILDER_REASONING_MODE = String(process.env.QUERY_BUILDER_REASONING_MODE || 'explicit').toLowerCase();
const QUERY_BUILDER_GRAPH_CACHE_TTL_MS = parseInt(process.env.QUERY_BUILDER_GRAPH_CACHE_TTL_MS || '180000', 10);
const QUERY_BUILDER_GRAPH_CACHE_MAX = parseInt(process.env.QUERY_BUILDER_GRAPH_CACHE_MAX || '100', 10);
const QUERY_BUILDER_PROMPT_VERSION = process.env.QUERY_BUILDER_PROMPT_VERSION || '2026-03-14.v1';

const graphRunCache = new Map();

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, Number(n) || min));
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function normalizeExecutionMode(mode) {
  const m = String(mode || '').toLowerCase();
  if (m === 'mcp') return 'mcp';
  if (m === 'langgraph' || m === 'lang-graph') return 'langgraph';
  if (m === 'local-tools') return 'local-tools';
  if (m === 'direct') return 'direct-agents';
  if (m === 'direct-agents') return 'direct-agents';
  return 'mcp';
}

function uniqueStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const v of values) {
    const s = String(v || '').trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map((x) => stableStringify(x)).join(',')}]`;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${pairs.join(',')}}`;
}

function nowMs() {
  return Date.now();
}

function pruneGraphCache() {
  const current = nowMs();
  for (const [key, value] of graphRunCache.entries()) {
    if (!value || !value.expiresAt || value.expiresAt <= current) {
      graphRunCache.delete(key);
    }
  }
  if (graphRunCache.size <= QUERY_BUILDER_GRAPH_CACHE_MAX) return;
  const keys = Array.from(graphRunCache.keys());
  const overflow = graphRunCache.size - QUERY_BUILDER_GRAPH_CACHE_MAX;
  for (let i = 0; i < overflow; i++) {
    graphRunCache.delete(keys[i]);
  }
}

function readGraphCache(key) {
  pruneGraphCache();
  const entry = graphRunCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= nowMs()) {
    graphRunCache.delete(key);
    return null;
  }
  return entry.value;
}

function writeGraphCache(key, value) {
  pruneGraphCache();
  graphRunCache.set(key, {
    createdAt: nowMs(),
    expiresAt: nowMs() + Math.max(1000, QUERY_BUILDER_GRAPH_CACHE_TTL_MS),
    value,
  });
}

function extractAnchors(query) {
  const text = String(query || '').trim();
  if (!text) return [];

  const normalized = text
    .replace(/\?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const collected = [];

  const aspectRegex = /\b(population|median age|age|rent|income|wage|employment|education|density|households|vehicles?|academic(?:\s+cert)?)\b/gi;
  let aspectMatch = aspectRegex.exec(normalized);
  while (aspectMatch) {
    collected.push(aspectMatch[1]);
    aspectMatch = aspectRegex.exec(normalized);
  }

  const clauseSplits = normalized
    .split(/\b(?:and|with|plus|along with|as well as|compared to)\b/gi)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);

  for (const c of clauseSplits) {
    const cleaned = c
      .replace(/^(what|which|find|show|give|tell me)\s+/i, '')
      .replace(/^(is|are|was|were|do|does|did|can|could|should|would)\s+/i, '')
      .replace(/\b(of|for|to|in|on|the|a|an)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length >= 3 && cleaned.length <= 50) {
      collected.push(cleaned);
    }
  }

  const base = uniqueStrings(collected)
    .map((a) => a.replace(/\b(tel aviv|statistical_\d+_\d+)\b/gi, '').trim())
    .filter((a) => a.length >= 3)
    .filter((a) => !/^(is|are|was|were|what|which)$/i.test(a));

  // Remove anchors that are supersets of shorter anchors (e.g., "median age tel aviv" vs "median age").
  const deduped = [];
  for (const a of base) {
    const lowerA = a.toLowerCase();
    const hasShorter = base.some((b) => b !== a && lowerA.includes(b.toLowerCase()) && b.length <= a.length);
    if (!hasShorter) deduped.push(a);
  }

  return uniqueStrings(deduped).slice(0, 6);
}

function buildQueryBuilderSystemPrompt({
  query,
  mode,
  executionMode,
  anchors = [],
  reasoningMode = QUERY_BUILDER_REASONING_MODE,
  sqlOptions = {},
  multiAnchorEnabled = true,
} = {}) {
  const anchorText = Array.isArray(anchors) && anchors.length > 0 ? anchors.join(', ') : 'none';
  const profile = [
    `mode=${mode || 'auto'}`,
    `executionMode=${executionMode || 'mcp'}`,
    `reasoningMode=${reasoningMode || QUERY_BUILDER_REASONING_MODE}`,
    `multiAnchorEnabled=${Boolean(multiAnchorEnabled)}`,
    `sqlRewriterEnabled=${Boolean(sqlOptions?.sqlRewriterEnabled)}`,
    `recursiveEnabled=${Boolean(sqlOptions?.recursiveEnabled)}`,
    `recursiveMaxDepth=${Math.max(0, Number(sqlOptions?.recursiveMaxDepth) || 0)}`,
    `proxyIndexLayerEnabled=${Boolean(sqlOptions?.proxyIndexLayerEnabled)}`,
    `semanticSimilarityInferenceEnabled=${Boolean(sqlOptions?.semanticSimilarityInferenceEnabled)}`,
    `sqlIngestLayerEnabled=${Boolean(sqlOptions?.sqlIngestLayerEnabled)}`,
  ].join(', ');

  const securityFramework = buildAgentSecurityPromptFramework({
    agentName: 'query_builder_agent',
    goal: 'Build mechanism-aware SQL and semantic query candidates with safe execution constraints.',
    tools: [
      'sql_rag_query and semantic_rag_query candidate generation.',
      'hybrid execution planning across local tools and MCP tools.',
    ],
    outputContract: 'Return concise query candidates, plan metadata, and bounded rationale fields only.',
  });

  return [
    `Query Builder System Prompt (${QUERY_BUILDER_PROMPT_VERSION})`,
    '',
    'Role and goal:',
    '- You are the Query/User Question Builder orchestrator for a hybrid SQL-RAG + Semantic-RAG system.',
    '- Build executable, mechanism-aware query candidates and retrieval plans aligned with backend tools and frontend controls.',
    '',
    'Permissions and boundaries:',
    '- Allowed outputs: query variants, tool-routing plan, and execution-ready constraints.',
    '- Allowed data scope: provided user question, schema grounding, memory hints, and tool outputs only.',
    '- Never fabricate database schema, rows, document content, or tool responses.',
    '- Never perform data mutation instructions in generated SQL intents (read-only behavior).',
    '',
    'Required mechanisms (must be considered in planning):',
    '- User-question embedding comparison against embedding columns from SQL tables and SQL files using cosine similarity.',
    '- Semantic similarity inference layer over proxy dimensions when explicit keys are missing.',
    '- Proxy index layer for mapping natural-language aspects to canonical attribute keys.',
    '- SQL rewrite with graph traversal over entity relationships when enabled.',
    '- Multi-anchor retrieval and recursive SQL expansion when enabled.',
    '- SQL ingest layer via ingestSqlTablesToRag for refreshing SQL-table-derived RAG context when enabled.',
    '',
    'Operational rules:',
    '- Prioritize user intent fidelity and determinism over creative rewrites.',
    '- Produce concise candidates that are executable by sql_rag_query and semantic_rag_query.',
    '- Keep SQL-oriented candidates structurally specific (joins/filters/ranking intent).',
    '- Keep semantic candidates grounded and citation-friendly.',
    '- If ambiguity remains, include a safe best-effort candidate plus a clarifying candidate.',
    '',
    'Few-shot examples:',
    '- Example A input: "Which statistical areas are similar in rent to statistical_5000_111?"',
    '- Example A SQL candidate: "Find areas similar to statistical_5000_111 in rent using numeric features with embedding cosine fallback over attributes/nodes/relationships."',
    '- Example A semantic candidate: "Explain semantic similarity context around statistical_5000_111 for rent with grounded evidence."',
    '- Example B input: "Population and median age of Tel Aviv"',
    '- Example B behavior: detect multi-anchor [population, median age], generate merged and per-anchor candidates, then rank merged output.',
    '',
    'Reasoning policy:',
    '- Think through tool routing and mechanism selection privately.',
    '- Do not expose chain-of-thought; output only final candidate queries, plans, and concise rationale fields.',
    '',
    'Current run context:',
    `- query=${String(query || '').trim()}`,
    `- anchors=${anchorText}`,
    `- profile=${profile}`,
    '',
    securityFramework,
  ].join('\n');
}

function augmentCandidatesWithAnchors(baseCandidates, query, anchors, kind) {
  if (!Array.isArray(anchors) || anchors.length === 0) return baseCandidates;
  const multiAnchor = anchors.length > 1;
  const anchorCandidates = [];

  if (multiAnchor) {
    const joined = anchors.join(' + ');
    if (kind === 'sql') {
      anchorCandidates.push(`${query} Use multi-anchor retrieval over: ${joined}. Build SQL-RAG constraints for all anchors, not one.`);
    } else {
      anchorCandidates.push(`${query} Semantic multi-anchor retrieval: jointly ground these anchors: ${joined}.`);
    }
  }

  for (const anchor of anchors) {
    if (kind === 'sql') {
      anchorCandidates.push(`${query} Focus anchor: ${anchor}.`);
    } else {
      anchorCandidates.push(`Explain ${query} with emphasis on anchor: ${anchor}.`);
    }
  }

  return uniqueStrings([...(baseCandidates || []), ...anchorCandidates]);
}

function summarizeExecutionForGraph(execution = []) {
  return (Array.isArray(execution) ? execution : []).map((item) => {
    const rows = Array.isArray(item?.result?.rows) ? item.result.rows.length : undefined;
    const docs = Array.isArray(item?.result?.docs) ? item.result.docs.length : undefined;
    return {
      mode: item?.mode || null,
      query: String(item?.query || '').slice(0, 220),
      selectedTool: item?.selectedTool || null,
      rows,
      docs,
      hasError: Boolean(item?.error),
    };
  });
}

function buildPromptContextFromExecution(query, execution = [], fallbackContext = null) {
  const context = {};
  for (const item of (Array.isArray(execution) ? execution : [])) {
    const rows = Array.isArray(item?.result?.rows) ? item.result.rows : [];
    if (rows && rows.length > 0) {
      const first = rows[0];
      const keys = Object.keys(first || {}).slice(0, 8);
      context[item.mode || 'result'] = {
        sampleRow: first,
        keys,
        rowCount: rows.length,
      };
      continue;
    }

    const docs = Array.isArray(item?.result?.docs) ? item.result.docs : [];
    if (docs && docs.length > 0) {
      const firstDoc = docs[0] || {};
      context[item.mode || 'result'] = {
        sampleDoc: {
          name: firstDoc?.name || firstDoc?.heading || null,
          score: firstDoc?.score ?? null,
          preview: String(firstDoc?.description || firstDoc?.text || firstDoc?.pageContent || '').slice(0, 220),
        },
        docCount: docs.length,
      };
    }
  }

  if (Object.keys(context).length === 0 && fallbackContext && typeof fallbackContext === 'object') {
    context.graph = {
      enabled: Boolean(fallbackContext.enabled),
      anchorCount: Number(fallbackContext.anchorCount || 0),
      anchors: Array.isArray(fallbackContext.anchors) ? fallbackContext.anchors : [],
      nodeCount: Number(fallbackContext.nodeCount || 0),
      edgeCount: Number(fallbackContext.edgeCount || 0),
      mode: fallbackContext.mode || 'auto',
      executionMode: fallbackContext.executionMode || 'mcp',
      topSqlQuery: String(fallbackContext.topSqlQuery || '').slice(0, 220),
      topSemanticQuery: String(fallbackContext.topSemanticQuery || '').slice(0, 220),
    };
  }

  const hasContext = Object.keys(context).length > 0;
  return {
    question: query,
    graphData: context,
    instruction: hasContext
      ? 'Use only the provided graph data to answer the question. If missing fields, state what is missing.'
      : 'No structured graph data is currently available from this run.',
    enabled: hasContext,
  };
}

function extractStatisticalTarget(text) {
  const raw = String(text || '').toLowerCase();
  const direct = raw.match(/statistical[_\s-]*(\d+)[_\s-]*(\d+(?:[_\s-]\d+)*)/i);
  if (direct && direct[1] && direct[2]) {
    const localityId = String(direct[1]).trim();
    const area = String(direct[2]).trim().replace(/[\s-]+/g, '_');
    return { localityId, statisticalId: `statistical_${localityId}_${area}` };
  }

  const subAreaPattern = raw.match(/(?:sub\s*area|area)\s*(\d+(?:[_\s-]\d+)*)\s*(?:within|in|of)\s*(?:locality\s*)?(\d+)/i);
  if (subAreaPattern && subAreaPattern[1] && subAreaPattern[2]) {
    const area = String(subAreaPattern[1]).trim().replace(/[\s-]+/g, '_');
    const localityId = String(subAreaPattern[2]).trim();
    return { localityId, statisticalId: `statistical_${localityId}_${area}` };
  }

  return { localityId: null, statisticalId: null };
}

function extractAspectText(text) {
  const raw = String(text || '').toLowerCase();
  const patterns = [
    /similar\s+in\s+(.+?)(?:\?|$)/i,
    /similar\s+by\s+(.+?)(?:\?|$)/i,
    /point\s+of\s+view\s*(?:of|for)?\s*(.+?)(?:\?|$)/i,
    /aspect\s+of\s+(.+?)(?:\?|$)/i,
  ];

  for (const rx of patterns) {
    const m = raw.match(rx);
    if (!m || !m[1]) continue;
    const cleaned = m[1]
      .replace(/\bto\s+statistical[_\s-]*\d+[_\s-]*\d+\b/gi, ' ')
      .replace(/\bto\s+sub\s*area\s*\d+\s*(?:within|in|of)\s*(?:locality\s*)?\d+\b/gi, ' ')
      .replace(/\b(similar|similarity|which|what|the|is|are|most|nearest|closest|point|view)\b/gi, ' ')
      .replace(/[^a-z0-9_\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length >= 2) return cleaned;
  }
  return '';
}

function detectIntent(query) {
  const q = String(query || '').toLowerCase();
  return {
    wantsSimilarity: /\b(similar|similarity|nearest|closest|most\s+similar)\b/.test(q),
    wantsPopulation: /\bpopulation\b/.test(q),
    wantsSemantic: /\b(explain|summary|summarize|semantic|context|document|meaning|insight)\b/.test(q),
    mentionsStatistical: /\bstatistical\b|\bsub\s*area\b/.test(q),
    mentionsEntities: /\b(variable|variables|node|nodes|relationship|relationships|attribute|attributes)\b/.test(q),
  };
}

function buildReasoningLayer(query, mode, executionMode) {
  const intent = detectIntent(query);
  const needsStructured = intent.wantsPopulation || intent.mentionsEntities || intent.mentionsStatistical;
  const needsSemantic = intent.wantsSemantic || (!needsStructured && !intent.wantsPopulation);
  const strategy = needsStructured && needsSemantic
    ? 'hybrid'
    : (needsStructured ? 'structured-first' : 'semantic-first');

  return {
    enabled: QUERY_BUILDER_REASONING_MODE !== 'model-only',
    modeType: QUERY_BUILDER_REASONING_MODE,
    note: QUERY_BUILDER_REASONING_MODE === 'model-only'
      ? 'Model-native reasoning only; explicit reasoning layer metadata minimized.'
      : 'Reasoning layer active; model reasoning is complemented by explicit orchestrator reasoning metadata.',
    strategy,
    mode,
    executionMode,
    intent,
  };
}

function buildSqlCandidates(query, memoryHints = []) {
  const intent = detectIntent(query);
  const { statisticalId, localityId } = extractStatisticalTarget(query);
  const aspect = extractAspectText(query);

  const candidates = [query];

  if (intent.wantsSimilarity && intent.mentionsStatistical && statisticalId) {
    if (intent.wantsPopulation) {
      candidates.push(`which statistical areas are similar in population number to ${statisticalId}${localityId ? ` within locality ${localityId}` : ''}?`);
    } else if (aspect) {
      candidates.push(`which statistical areas are similar in ${aspect} to ${statisticalId}?`);
      candidates.push(`find statistical areas similar to ${statisticalId} using ${aspect} numeric attributes and embedding cosine similarity over available entity vectors`);
    } else {
      candidates.push(`which statistical areas are similar to ${statisticalId} across all available numeric attributes and embedding similarity?`);
    }
  }

  if (intent.wantsSimilarity && intent.mentionsEntities && !intent.mentionsStatistical) {
    candidates.push(`${query} Use SQL-RAG over variables, nodes, relationships, and attributes with numeric feature distance and vector cosine fallback.`);
  }

  const memoryDerived = memoryHints
    .map((h) => h?.payload?.query || h?.query || '')
    .filter((s) => /similar|population|semantic|sql|rag/i.test(String(s || '')))
    .slice(0, 2)
    .map((s) => `${query} (related previous intent: ${String(s).slice(0, 120)})`);

  return uniqueStrings([...candidates, ...memoryDerived]).slice(0, MAX_SQL_CANDIDATES);
}

function buildSemanticCandidates(query, memoryHints = []) {
  const intent = detectIntent(query);
  const { statisticalId } = extractStatisticalTarget(query);
  const aspect = extractAspectText(query);

  const candidates = [query];

  if (intent.wantsSimilarity && intent.mentionsStatistical && statisticalId) {
    candidates.push(`Explain which statistical areas are semantically similar to ${statisticalId}${aspect ? ` for ${aspect}` : ''}, using retrieved context and similarities.`);
    candidates.push(`Semantic-RAG only: retrieve and compare contextual descriptions of ${statisticalId}${aspect ? ` and ${aspect}-related indicators` : ''}.`);
  }

  if (intent.wantsSimilarity && intent.mentionsEntities) {
    candidates.push(`Semantic-RAG only: compare variables, nodes, relationships, and attributes relevant to: ${query}`);
  }

  const memoryDerived = memoryHints
    .map((h) => h?.payload?.query || h?.query || '')
    .filter((s) => /semantic|rag|context|explain/i.test(String(s || '')))
    .slice(0, 2)
    .map((s) => `${query} (semantic context from prior intent: ${String(s).slice(0, 120)})`);

  return uniqueStrings([...candidates, ...memoryDerived]).slice(0, MAX_SEMANTIC_CANDIDATES);
}

function buildToolPlan({ mode, sqlCandidates = [], semanticCandidates = [] }) {
  if (mode === 'sql-rag-exclusive') {
    return [{ tool: 'sql_rag_query', params: { query: sqlCandidates[0] || '' } }];
  }
  if (mode === 'semantic-rag-exclusive') {
    return [{ tool: 'semantic_rag_query', params: { query: semanticCandidates[0] || '' } }];
  }
  return [
    { tool: 'sql_rag_query', params: { query: sqlCandidates[0] || '' } },
    { tool: 'semantic_rag_query', params: { query: semanticCandidates[0] || '' } },
  ];
}

function buildSpecializedQueries({
  query,
  sqlCandidates = [],
  semanticCandidates = [],
  anchors = [],
  mode = 'auto',
  executionMode = 'mcp',
  sqlOptions = {},
  multiAnchorEnabled = true,
} = {}) {
  const topSql = String(sqlCandidates[0] || query || '').trim();
  const topSemantic = String(semanticCandidates[0] || query || '').trim();
  const { statisticalId, localityId } = extractStatisticalTarget(query);
  const aspect = extractAspectText(query) || 'population, rent, income, infrastructure';
  const anchorText = Array.isArray(anchors) && anchors.length > 0 ? anchors.join(' + ') : 'primary intent';
  const recursiveDepth = Math.max(0, Number(sqlOptions?.recursiveMaxDepth) || 0);

  return {
    sqlRagSpecific: uniqueStrings([
      topSql,
      `${query} SQL-RAG only: return SQL-ready constraints, joins, and filters over nodes/relationships/attributes.`,
      statisticalId
        ? `Find areas similar to ${statisticalId}${localityId ? ` within locality ${localityId}` : ''} in ${aspect} using SQL-RAG numeric + vector fallback.`
        : `${query} Use SQL-RAG with structured joins and ranking.`,
    ]).slice(0, 5),
    semanticRagSpecific: uniqueStrings([
      topSemantic,
      `${query} Semantic-RAG only: retrieve narrative context, then summarize grounded evidence.`,
      statisticalId
        ? `Explain semantic similarity context around ${statisticalId}${aspect ? ` for ${aspect}` : ''}.`
        : `${query} Semantic-RAG contextual explanation with citations.`,
    ]).slice(0, 5),
    langGraphSpecific: uniqueStrings([
      `${query} LangGraph: plan -> retrieve -> compare -> synthesize with explicit state transitions.`,
      `${query} LangGraph state graph should include routing, candidate generation, tool execution, and reflection nodes.`,
      `${query} LangGraph orchestration mode=${mode}, executionMode=${executionMode}.`,
    ]).slice(0, 5),
    mcpSpecific: uniqueStrings([
      `MCP sql_rag_query: ${topSql}`,
      `MCP semantic_rag_query: ${topSemantic}`,
      `${query} Route through MCP boundary with strict tool isolation and timeout-aware retries.`,
    ]).slice(0, 5),
    semanticSimilarityInferenceLayer: uniqueStrings([
      `${query} Infer similarity aspects automatically when no explicit feature key is provided.`,
      statisticalId
        ? `Similarity inference for ${statisticalId}: evaluate all proxy dimensions and return nearest statistical areas.`
        : `${query} Run semantic similarity inference across proxy dimensions: socioeconomic, population, employment, education, housing, mobility.`,
      `${query} Use semanticSimilarityInferenceEnabled=${Boolean(sqlOptions?.semanticSimilarityInferenceEnabled)}.`,
    ]).slice(0, 5),
    sqlRewriteAndGraphTraversal: uniqueStrings([
      `${query} Rewrite into executable SQL with graph traversal over entity relationships.`,
      `${query} SQL rewrite should enforce join path through nodes -> relationships -> attributes where relevant.`,
      `${query} Use sqlRewriterEnabled=${Boolean(sqlOptions?.sqlRewriterEnabled)} with graph traversal constraints.`,
    ]).slice(0, 5),
    proxyIndexLayer: uniqueStrings([
      `${query} Use proxy index layer to map natural-language aspects to attribute keys before SQL generation.`,
      `${query} Proxy-index expansion for aspects: ${aspect}.`,
      `${query} Use proxyIndexLayerEnabled=${Boolean(sqlOptions?.proxyIndexLayerEnabled)}.`,
    ]).slice(0, 5),
    multiAnchor: uniqueStrings([
      `${query} Multi-anchor retrieval over: ${anchorText}.`,
      `${query} Resolve anchors independently, then merge and rank final candidates.`,
      `${query} Multi-anchor enabled=${Boolean(multiAnchorEnabled)} with ${anchors.length || 0} anchors.`,
    ]).slice(0, 5),
    recursiveSql: uniqueStrings([
      `${query} Use recursive SQL for transitive relationship discovery and multi-hop graph paths.`,
      `${query} Recursive SQL depth=${recursiveDepth}.`,
      `${query} recursiveSqlEnabled=${Boolean(sqlOptions?.recursiveEnabled)} for hierarchical expansion.`,
    ]).slice(0, 5),
    sqlIngestLayer: uniqueStrings([
      `${query} Use SQL ingest layer to index SQL table rows into RAG documents before semantic retrieval.`,
      `${query} Align semantic retrieval with ingestSqlTablesToRag over attributes, nodes, and relationships.`,
      `${query} sqlIngestLayerEnabled=${Boolean(sqlOptions?.sqlIngestLayerEnabled)}.`,
    ]).slice(0, 5),
  };
}

function scoreCandidateShape(text) {
  const s = String(text || '').toLowerCase();
  let score = 0;
  if (s.includes('similar')) score += 1;
  if (s.includes('statistical')) score += 1;
  if (s.includes('population')) score += 1;
  if (s.includes('embedding') || s.includes('cosine')) score += 1;
  if (s.includes('attributes')) score += 1;
  if (s.includes('multi-anchor')) score += 2;
  if (s.includes('related previous intent')) score -= 2;
  if (s.includes('semantic context from prior intent')) score -= 1;
  if (s.includes('top') && s.includes('relationships')) score -= 2;
  return score;
}

function refineCandidates(candidates = []) {
  return [...candidates]
    .sort((a, b) => scoreCandidateShape(b) - scoreCandidateShape(a))
    .slice(0, Math.max(MAX_SQL_CANDIDATES, MAX_SEMANTIC_CANDIDATES));
}

async function loadLongTermMemory(userId, limit = 6) {
  const rows = await getRecentMemories({ userId, agent: 'query-builder-agent', limit });
  return (rows || []).map((r) => ({ ts: r.created_at, query: r.query, response: r.response }));
}

async function executeMode({ mode, sqlCandidates, semanticCandidates, userId, systemPrompt = '', sqlOptions = {} }) {
  if (mode === 'sql-rag-exclusive') {
    const result = await runSQLRAG({ userQuery: sqlCandidates[0], systemPrompt, userId, sqlOptions });
    return [{ mode: 'sql-rag', query: sqlCandidates[0], result }];
  }
  if (mode === 'semantic-rag-exclusive') {
    const result = await runSemanticRAG({ query: semanticCandidates[0], systemPrompt, userId, useRerank: false, sqlOptions });
    return [{ mode: 'semantic-rag', query: semanticCandidates[0], result }];
  }

  const [sqlResult, semanticResult] = await Promise.all([
    runSQLRAG({ userQuery: sqlCandidates[0], systemPrompt, userId, sqlOptions }),
    runSemanticRAG({ query: semanticCandidates[0], systemPrompt, userId, useRerank: false, sqlOptions }),
  ]);

  return [
    { mode: 'sql-rag', query: sqlCandidates[0], result: sqlResult },
    { mode: 'semantic-rag', query: semanticCandidates[0], result: semanticResult },
  ];
}

async function executeModeViaLocalTools({ mode, sqlCandidates, semanticCandidates, userId, systemPrompt = '', sqlOptions = {} }) {
  if (mode === 'sql-rag-exclusive') {
    const result = await runSqlTool({ userQuery: sqlCandidates[0], systemPrompt, userId, sqlOptions });
    return [{ mode: 'sql-rag', query: sqlCandidates[0], result }];
  }
  if (mode === 'semantic-rag-exclusive') {
    const result = await runRagTool({ query: semanticCandidates[0], userId, systemPrompt, useRerank: false, sqlOptions });
    return [{ mode: 'semantic-rag', query: semanticCandidates[0], result }];
  }

  const [sqlResult, semanticResult] = await Promise.all([
    runSqlTool({ userQuery: sqlCandidates[0], systemPrompt, userId, sqlOptions }),
    runRagTool({ query: semanticCandidates[0], userId, systemPrompt, useRerank: false, sqlOptions }),
  ]);

  return [
    { mode: 'sql-rag', query: sqlCandidates[0], result: sqlResult },
    { mode: 'semantic-rag', query: semanticCandidates[0], result: semanticResult },
  ];
}

function buildMcpCallsForMode({ mode, sqlCandidates = [], semanticCandidates = [], userId = null, sqlOptions = {}, systemPrompt = '' }) {
  if (mode === 'sql-rag-exclusive') {
    return [{ name: 'sql_rag_query', args: { query: sqlCandidates[0] || '', userId, sqlOptions, systemPrompt } }];
  }
  if (mode === 'semantic-rag-exclusive') {
    return [{ name: 'semantic_rag_query', args: { query: semanticCandidates[0] || '', userId, systemPrompt, sqlOptions } }];
  }
  return [
    { name: 'sql_rag_query', args: { query: sqlCandidates[0] || '', userId, sqlOptions, systemPrompt } },
    { name: 'semantic_rag_query', args: { query: semanticCandidates[0] || '', userId, systemPrompt, sqlOptions } },
  ];
}

function mapBatchResultsToExecution({ mode, sqlCandidates = [], semanticCandidates = [], results = [] }) {
  const ordered = Array.isArray(results) ? [...results].sort((a, b) => (a.index || 0) - (b.index || 0)) : [];

  if (mode === 'sql-rag-exclusive') {
    const r = ordered[0] || {};
    return [{ mode: 'sql-rag', query: sqlCandidates[0], result: r.result, error: r.error, selectedTool: r.selectedTool }];
  }
  if (mode === 'semantic-rag-exclusive') {
    const r = ordered[0] || {};
    return [{ mode: 'semantic-rag', query: semanticCandidates[0], result: r.result, error: r.error, selectedTool: r.selectedTool }];
  }

  const sql = ordered[0] || {};
  const semantic = ordered[1] || {};
  return [
    { mode: 'sql-rag', query: sqlCandidates[0], result: sql.result, error: sql.error, selectedTool: sql.selectedTool },
    { mode: 'semantic-rag', query: semanticCandidates[0], result: semantic.result, error: semantic.error, selectedTool: semantic.selectedTool },
  ];
}

async function executeModeViaMcp({ mode, sqlCandidates, semanticCandidates, userId, sqlOptions = {}, systemPrompt = '' }) {
  const calls = buildMcpCallsForMode({ mode, sqlCandidates, semanticCandidates, userId, sqlOptions, systemPrompt });
  const batch = await callToolsBatch(calls);
  return mapBatchResultsToExecution({ mode, sqlCandidates, semanticCandidates, results: batch });
}

export async function runQueryBuilderAgent({
  query,
  userId = null,
  mode = 'auto',
  execute = false,
  executionMode = 'mcp',
  useGraph = QUERY_BUILDER_USE_GRAPH,
  reasoningMode = QUERY_BUILDER_REASONING_MODE,
  multiAnchorEnabled = true,
  sqlRewriterEnabled = true,
  recursiveSqlEnabled = true,
  recursiveSqlMaxDepth = 2,
  proxyIndexLayerEnabled = true,
  semanticSimilarityInferenceEnabled = true,
  sqlIngestLayerEnabled = true,
  maxCycles = DEFAULT_MAX_CYCLES,
  systemPrompt = '',
} = {}) {
  if (!query || typeof query !== 'string') {
    throw new Error('query is required');
  }

  const normalizedMode = ['auto', 'sql-rag-exclusive', 'semantic-rag-exclusive'].includes(mode)
    ? mode
    : 'auto';
  const normalizedExecutionMode = normalizeExecutionMode(executionMode);
  const boundedCycles = clamp(maxCycles, 1, 8);

  const graphEnabled = Boolean(useGraph);
  const graphNodes = [];
  const graphEdges = [];
  const anchors = extractAnchors(query);
  const multiAnchor = anchors.length > 1;
  const reasoningLayer = buildReasoningLayer(query, normalizedMode, normalizedExecutionMode);
  reasoningLayer.modeType = String(reasoningMode || QUERY_BUILDER_REASONING_MODE || 'explicit').toLowerCase();
  reasoningLayer.enabled = reasoningLayer.modeType !== 'model-only';

  const sqlOptions = {
    recursiveEnabled: Boolean(recursiveSqlEnabled),
    recursiveMaxDepth: Math.max(0, Number(recursiveSqlMaxDepth) || 0),
    sqlRewriterEnabled: Boolean(sqlRewriterEnabled),
    proxyIndexLayerEnabled: Boolean(proxyIndexLayerEnabled),
    semanticSimilarityInferenceEnabled: Boolean(semanticSimilarityInferenceEnabled),
    sqlIngestLayerEnabled: Boolean(sqlIngestLayerEnabled),
  };

  const generatedSystemPrompt = buildQueryBuilderSystemPrompt({
    query,
    mode: normalizedMode,
    executionMode: normalizedExecutionMode,
    anchors,
    reasoningMode,
    sqlOptions,
    multiAnchorEnabled,
  });
  const effectiveSystemPrompt = [generatedSystemPrompt, String(systemPrompt || '').trim()]
    .filter(Boolean)
    .join('\n\n');

  const graphCacheKey = stableStringify({
    query,
    userId,
    mode: normalizedMode,
    executionMode: normalizedExecutionMode,
    execute: Boolean(execute),
    maxCycles: boundedCycles,
  });

  if (graphEnabled) {
    const cached = readGraphCache(graphCacheKey);
    if (cached) {
      return {
        ...cached,
        graph: {
          ...(cached.graph || {}),
          cacheHit: true,
        },
      };
    }
  }

  const shortTerm = readBuffer({ agent: 'query-builder-agent', userId, limit: 6 });
  const longTerm = await loadLongTermMemory(userId, 6);
  const memoryHints = [...shortTerm, ...longTerm];

  if (reasoningLayer.enabled) {
    graphNodes.push({
      id: 'reasoning_layer',
      context: {
        ...reasoningLayer,
        memoryHintCount: memoryHints.length,
      },
    });

    graphEdges.push({
      from: 'reasoning_layer',
      to: 'anchor_detection',
      data: {
        strategy: reasoningLayer.strategy,
      },
    });
  }

  graphNodes.push({
    id: 'anchor_detection',
    context: {
      query,
      anchors,
      multiAnchor,
      memoryHintCount: memoryHints.length,
    },
  });

  let sqlCandidates = buildSqlCandidates(query, memoryHints);
  let semanticCandidates = buildSemanticCandidates(query, memoryHints);

  if (graphEnabled && anchors.length > 0 && Boolean(multiAnchorEnabled)) {
    sqlCandidates = augmentCandidatesWithAnchors(sqlCandidates, query, anchors, 'sql');
    semanticCandidates = augmentCandidatesWithAnchors(semanticCandidates, query, anchors, 'semantic');
  }

  graphEdges.push({
    from: 'anchor_detection',
    to: 'candidate_generation',
    data: { anchorCount: anchors.length, multiAnchor },
  });

  graphNodes.push({
    id: 'candidate_generation',
    context: {
      sqlCandidatesPreview: sqlCandidates.slice(0, 3),
      semanticCandidatesPreview: semanticCandidates.slice(0, 3),
    },
  });

  const cycleTrace = [];

  for (let i = 1; i <= boundedCycles; i++) {
    sqlCandidates = refineCandidates(sqlCandidates).slice(0, MAX_SQL_CANDIDATES);
    semanticCandidates = refineCandidates(semanticCandidates).slice(0, MAX_SEMANTIC_CANDIDATES);

    cycleTrace.push({
      cycle: i,
      sqlTop: sqlCandidates[0] || '',
      semanticTop: semanticCandidates[0] || '',
      sqlCount: sqlCandidates.length,
      semanticCount: semanticCandidates.length,
    });

    appendBufferEntry({
      agent: 'query-builder-agent',
      userId,
      type: 'cycle',
      payload: cycleTrace[cycleTrace.length - 1],
    });

    if (i >= 2) {
      // Stop early if top candidates stabilized.
      const prev = cycleTrace[cycleTrace.length - 2];
      const curr = cycleTrace[cycleTrace.length - 1];
      if (prev.sqlTop === curr.sqlTop && prev.semanticTop === curr.semanticTop) {
        break;
      }
    }
  }

  graphEdges.push({
    from: 'candidate_generation',
    to: 'cycle_refinement',
    data: { cyclesUsed: cycleTrace.length },
  });

  graphNodes.push({
    id: 'cycle_refinement',
    context: {
      cyclesUsed: cycleTrace.length,
      topSql: sqlCandidates[0] || '',
      topSemantic: semanticCandidates[0] || '',
    },
  });

  const plan = buildToolPlan({ mode: normalizedMode, sqlCandidates, semanticCandidates });
  const specializedQueries = buildSpecializedQueries({
    query,
    sqlCandidates,
    semanticCandidates,
    anchors,
    mode: normalizedMode,
    executionMode: normalizedExecutionMode,
    sqlOptions,
    multiAnchorEnabled,
  });
  graphEdges.push({
    from: 'cycle_refinement',
    to: 'plan_build',
    data: { planSteps: plan.length },
  });

  graphNodes.push({
    id: 'plan_build',
    context: {
      mode: normalizedMode,
      plan,
    },
  });

  let execution = [];
  let executionTransport = 'none';
  if (execute) {
    if (normalizedExecutionMode === 'mcp' || normalizedExecutionMode === 'langgraph') {
      try {
        execution = await withTimeout(
          executeModeViaMcp({ mode: normalizedMode, sqlCandidates, semanticCandidates, userId, sqlOptions, systemPrompt: effectiveSystemPrompt }),
          EXECUTION_TIMEOUT_MS,
          'query-builder-mcp-execution',
        );
        executionTransport = normalizedExecutionMode === 'langgraph' ? 'langgraph-mcp' : 'mcp';
      } catch (_mcpErr) {
        try {
          execution = await withTimeout(
            executeModeViaLocalTools({ mode: normalizedMode, sqlCandidates, semanticCandidates, userId, systemPrompt: effectiveSystemPrompt, sqlOptions }),
            EXECUTION_TIMEOUT_MS,
            'query-builder-local-tools-fallback',
          );
          executionTransport = normalizedExecutionMode === 'langgraph' ? 'langgraph-local-tools-fallback' : 'local-tools-fallback';
        } catch (_localErr) {
          execution = await withTimeout(
            executeMode({ mode: normalizedMode, sqlCandidates, semanticCandidates, userId, systemPrompt: effectiveSystemPrompt, sqlOptions }),
            EXECUTION_TIMEOUT_MS,
            'query-builder-direct-fallback',
          );
          executionTransport = normalizedExecutionMode === 'langgraph' ? 'langgraph-direct-fallback' : 'direct-agents-fallback';
        }
      }
    } else if (normalizedExecutionMode === 'local-tools') {
      execution = await withTimeout(
        executeModeViaLocalTools({ mode: normalizedMode, sqlCandidates, semanticCandidates, userId, systemPrompt: effectiveSystemPrompt, sqlOptions }),
        EXECUTION_TIMEOUT_MS,
        'query-builder-local-tools-execution',
      );
      executionTransport = 'local-tools';
    } else {
      execution = await withTimeout(
        executeMode({ mode: normalizedMode, sqlCandidates, semanticCandidates, userId, systemPrompt: effectiveSystemPrompt, sqlOptions }),
        EXECUTION_TIMEOUT_MS,
        'query-builder-direct-agents-execution',
      );
      executionTransport = 'direct-agents';
    }
  }

  graphEdges.push({
    from: 'plan_build',
    to: 'execution',
    data: { execute: Boolean(execute), executionTransport },
  });

  graphNodes.push({
    id: 'execution',
    context: {
      executionTransport,
      summary: summarizeExecutionForGraph(execution),
    },
  });

  const promptContext = buildPromptContextFromExecution(query, execution, {
    enabled: graphEnabled,
    anchorCount: anchors.length,
    anchors,
    nodeCount: graphNodes.length,
    edgeCount: graphEdges.length,
    mode: normalizedMode,
    executionMode: normalizedExecutionMode,
    topSqlQuery: sqlCandidates[0] || '',
    topSemanticQuery: semanticCandidates[0] || '',
  });

  const response = {
    mode: normalizedMode,
    executionMode: normalizedExecutionMode,
    workflow: {
      orchestration: normalizedExecutionMode === 'langgraph' ? 'langgraph-inspired' : 'planner-react-executor',
      nodes: ['route', 'candidate_generation', 'cycle_refinement', 'plan_build', 'execution', 'reflection'],
    },
    options: {
      useGraph: graphEnabled,
      reasoningMode: reasoningLayer.modeType,
      multiAnchorEnabled: Boolean(multiAnchorEnabled),
      sqlOptions,
    },
    maxCycles: boundedCycles,
    cyclesUsed: cycleTrace.length,
    memory: {
      shortTermCount: shortTerm.length,
      longTermCount: longTerm.length,
    },
    sqlRagQueries: sqlCandidates,
    semanticRagQueries: semanticCandidates,
    specializedQueries,
    plan,
    executionTransport,
    execution,
    reasoning: reasoningLayer,
    systemPromptProfile: {
      version: QUERY_BUILDER_PROMPT_VERSION,
      generatedSystemPrompt,
      hasExternalSystemPrompt: Boolean(String(systemPrompt || '').trim()),
    },
    graph: {
      enabled: graphEnabled,
      runtime: normalizedExecutionMode === 'langgraph' ? 'langgraph-inspired-state-graph' : 'state-graph',
      dedicatedLangGraphRuntime: false,
      cacheHit: false,
      multiAnchor,
      anchors,
      nodes: graphNodes,
      edges: graphEdges,
    },
    llmContext: promptContext,
  };

  await remember({
    userId,
    agent: 'query-builder-agent',
    query,
    response,
  });

  if (graphEnabled) {
    writeGraphCache(graphCacheKey, response);
  }

  return response;
}
