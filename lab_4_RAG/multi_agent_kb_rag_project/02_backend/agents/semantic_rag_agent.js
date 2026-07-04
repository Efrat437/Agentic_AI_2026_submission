import 'dotenv/config';
import OpenAI from 'openai';
import { createClient, ensureSqlTablesIngestedToRag } from './dbTools.js';
import fs from 'fs';
import path from 'path';
import { pipeline } from '@xenova/transformers';
import { remember, memoryTool } from './memoryTool.js';
import { appendBufferEntry } from './memoryBuffer.js';
import { buildSchemaGrounding, getSchemaGraph } from './schemaGraph.js';
import { buildAgentSecurityPromptFramework } from './prompt_security_framework.js';
import { buildLlmMetrics, combineLlmMetrics, emptyLlmMetrics, metricFromChatCompletionResponse } from '../services/llmMetrics.js';
import { buildSinglePathwayRagasReport } from '../eval/grounded_ragas_report.js';

// Local embeddings using Xenova (same as rag_process_enhanced)
class LocalEmbeddings {
  constructor() {
    this.extractor = null;
    this.dimensions = 384;
  }

  async init() {
    if (!this.extractor) {
      try {
        this.extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      } catch (e) {
        console.warn('Failed to load Xenova embeddings:', e.message);
        this.extractor = null;
      }
    }
  }

  async embedDocuments(texts) {
    await this.init();
    const vectors = [];
    for (const text of texts) {
      const output = await this.extractor(text, { pooling: 'mean', normalize: true });
      vectors.push(Array.from(output.data));
    }
    return vectors;
  }

  async embedQuery(text) {
    await this.init();
    const output = await this.extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  }
}

const localEmbeddings = new LocalEmbeddings();
const TOP_K = parseInt(process.env.TOP_K || '15');
const SEMANTIC_RAG_RECURSIVE_ENABLED = String(process.env.SEMANTIC_RAG_RECURSIVE_ENABLED || 'true').toLowerCase() === 'true';
const SEMANTIC_RAG_RECURSIVE_MAX_DEPTH = parseInt(process.env.SEMANTIC_RAG_RECURSIVE_MAX_DEPTH || '2', 10);
const SEMANTIC_PROXY_INDEX_ENABLED = String(process.env.SEMANTIC_PROXY_INDEX_ENABLED || 'true').toLowerCase() === 'true';
const SEMANTIC_SQL_REWRITE_WITH_GRAPH = String(process.env.SEMANTIC_SQL_REWRITE_WITH_GRAPH || 'true').toLowerCase() === 'true';
const SEMANTIC_USE_GRAPH = String(process.env.SEMANTIC_USE_GRAPH || 'true').toLowerCase() === 'true';
const SEMANTIC_MULTI_ANCHOR_ENABLED = String(process.env.SEMANTIC_MULTI_ANCHOR_ENABLED || 'true').toLowerCase() === 'true';
const SEMANTIC_SIMILARITY_INFERENCE_ENABLED = String(process.env.SEMANTIC_SIMILARITY_INFERENCE_ENABLED || 'true').toLowerCase() === 'true';
const SEMANTIC_PROXY_INDEX_TTL_MS = Math.max(10000, parseInt(process.env.SEMANTIC_PROXY_INDEX_TTL_MS || '300000', 10));
const SEMANTIC_RETRIEVAL_QUERY_LIMIT = Math.max(2, Math.min(4, parseInt(process.env.SEMANTIC_RETRIEVAL_QUERY_LIMIT || '4', 10)));
const SEMANTIC_RECURSIVE_MAX_EXPANSIONS = Math.max(1, Math.min(2, parseInt(process.env.SEMANTIC_RECURSIVE_MAX_EXPANSIONS || '2', 10)));
const SEMANTIC_SQL_INGEST_LAYER_ENABLED = String(process.env.SEMANTIC_SQL_INGEST_LAYER_ENABLED || 'true').toLowerCase() === 'true';
const SEMANTIC_SQL_INGEST_BOOTSTRAP_TIMEOUT_MS = Math.max(2000, parseInt(process.env.SEMANTIC_SQL_INGEST_BOOTSTRAP_TIMEOUT_MS || '12000', 10));
const SEMANTIC_EMBED_TIMEOUT_MS = Math.max(2000, parseInt(process.env.SEMANTIC_EMBED_TIMEOUT_MS || '6000', 10));
const SEMANTIC_EMBED_SEARCH_TIMEOUT_MS = Math.max(2000, parseInt(process.env.SEMANTIC_EMBED_SEARCH_TIMEOUT_MS || '8000', 10));
const SEMANTIC_VECTOR_INIT_TIMEOUT_MS = Math.max(2000, parseInt(process.env.SEMANTIC_VECTOR_INIT_TIMEOUT_MS || '8000', 10));
const SEMANTIC_BM25_DOC_LOAD_TIMEOUT_MS = Math.max(2000, parseInt(process.env.SEMANTIC_BM25_DOC_LOAD_TIMEOUT_MS || '8000', 10));
const SEMANTIC_RETRIEVER_TIMEOUT_MS = Math.max(1000, parseInt(process.env.SEMANTIC_RETRIEVER_TIMEOUT_MS || '4000', 10));
const SEMANTIC_MEMORY_WRITE_TIMEOUT_MS = Math.max(500, parseInt(process.env.SEMANTIC_MEMORY_WRITE_TIMEOUT_MS || '1500', 10));
const SEMANTIC_WARN_MISSING_RETRIEVER_SCORES = String(process.env.SEMANTIC_WARN_MISSING_RETRIEVER_SCORES || 'false').toLowerCase() === 'true';
const SEMANTIC_PROXY_INDEX_CACHE_FILE = process.env.SEMANTIC_PROXY_INDEX_CACHE_FILE || path.resolve(process.cwd(), 'tmp', 'semantic-proxy-index-cache.json');
const SEMANTIC_SQL_FILE_EMBEDDING_INDEX_PATH = process.env.SEMANTIC_SQL_FILE_EMBEDDING_INDEX_PATH || path.resolve(process.cwd(), 'tmp', 'sql-file-embedding-index.json');
const SEMANTIC_RERANK_STRATEGY = String(process.env.SEMANTIC_RERANK_STRATEGY || 'local').trim().toLowerCase();
const SEMANTIC_SQL_INGEST_TABLES = String(process.env.SEMANTIC_SQL_INGEST_TABLES || 'attributes,nodes,relationships')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const PROXY_CATEGORY_PATTERNS = {
  socioeconomic: /(socio|social|economic|cluster|index|deprivation|status)/i,
  population: /(population|pop|household|residents|density|people_per|per_km|per_sqkm)/i,
  employment: /(employment|employees|wage|salary|income|job|unemployment|labor|labour)/i,
  education: /(education|academic|cert|school|degree|study)/i,
  housing: /(rent|housing|apartment|ownership|tenure|dwelling|realestate|real_estate)/i,
  mobility: /(vehicle|transport|bus|car|commute|mobility|road|traffic)/i,
};

const CITY_ALIAS_PATTERNS = [
  { canonical: 'tel aviv', nodeId: 'e_5000', regex: /\b(tel\s*-?\s*aviv|tel\s*aviv\s*-?\s*yafo|yafo)\b/i },
  { canonical: 'jerusalem', nodeId: '', regex: /\bjerusalem\b/i },
  { canonical: 'haifa', nodeId: '', regex: /\bhaifa\b/i },
  { canonical: 'beer sheva', nodeId: '', regex: /\b(be\s*['`]?\s*er|beer|beers?)\s*[-_\s]?\s*sheva\b/i },
];

let semanticProxyIndexCache = {
  expiresAt: 0,
  value: null,
};

let semanticProxyIndexFileCache = {
  filePath: '',
  mtimeMs: 0,
  value: null,
};

let semanticSqlFileEmbeddingIndexCache = {
  filePath: '',
  mtimeMs: 0,
  value: null,
};

function clampInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function readJsonFileCached(filePath, cacheState) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (cacheState.filePath === filePath && cacheState.mtimeMs === stat.mtimeMs && cacheState.value != null) {
      return cacheState.value;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    cacheState.filePath = filePath;
    cacheState.mtimeMs = stat.mtimeMs;
    cacheState.value = parsed;
    return parsed;
  } catch (_e) {
    return null;
  }
}

function loadPersistedProxyIndex(cacheFilePath, ttlMs) {
  const parsed = readJsonFileCached(cacheFilePath, semanticProxyIndexFileCache);
  if (!parsed || typeof parsed !== 'object') return null;
  const generatedAtMs = Date.parse(parsed.generatedAt || '');
  if (!Number.isFinite(generatedAtMs)) return null;
  if ((Date.now() - generatedAtMs) > ttlMs) return null;
  return parsed;
}

function persistProxyIndex(cacheFilePath, proxyIndex) {
  try {
    fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
    fs.writeFileSync(cacheFilePath, JSON.stringify(proxyIndex, null, 2), 'utf8');
    semanticProxyIndexFileCache = {
      filePath: cacheFilePath,
      mtimeMs: fs.statSync(cacheFilePath).mtimeMs,
      value: proxyIndex,
    };
  } catch (_e) {
  }
}

function buildProxyIndexFromRows(rows = [], { source = 'live-aggregation' } = {}) {
  const categories = {
    socioeconomic: [],
    population: [],
    employment: [],
    education: [],
    housing: [],
    mobility: [],
  };

  for (const row of rows) {
    const key = String(row?.key || '').trim().toLowerCase();
    const cnt = Number(row?.cnt || 0);
    if (!key) continue;
    for (const [cat, rx] of Object.entries(PROXY_CATEGORY_PATTERNS)) {
      if (rx.test(key)) categories[cat].push({ key, cnt });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    totalKeys: rows.length,
    topKeys: rows.slice(0, 30).map((r) => ({ key: String(r.key), cnt: Number(r.cnt || 0) })),
    categories,
    source,
  };
}

function inferProxyCategoriesFromQuery(query = '') {
  const q = String(query || '').toLowerCase();
  const out = [];
  if (/(socio|social|economic|socioeconomic|socio-economic|cluster|index)/.test(q)) out.push('socioeconomic');
  if (/(population|residents|household|density)/.test(q)) out.push('population');
  if (/(wage|salary|income|employment|job|unemployment|employees)/.test(q)) out.push('employment');
  if (/(education|academic|academy|cert|school|degree)/.test(q)) out.push('education');
  if (/(rent|housing|apartment|ownership|dwelling)/.test(q)) out.push('housing');
  if (/(vehicle|transport|mobility|traffic|commute|car)/.test(q)) out.push('mobility');
  return Array.from(new Set(out));
}

function chooseProxyKeys(proxyIndex, categories = [], maxKeys = 16) {
  const byCategory = proxyIndex?.categories || {};
  const chosen = [];
  for (const c of categories) {
    const keys = Array.isArray(byCategory[c]) ? byCategory[c] : [];
    for (const item of keys) {
      if (!item?.key || chosen.includes(item.key)) continue;
      chosen.push(item.key);
      if (chosen.length >= maxKeys) return chosen;
    }
  }
  if (chosen.length === 0) {
    const fallback = Array.isArray(proxyIndex?.topKeys) ? proxyIndex.topKeys : [];
    for (const item of fallback) {
      if (!item?.key || chosen.includes(item.key)) continue;
      chosen.push(item.key);
      if (chosen.length >= Math.min(maxKeys, 10)) break;
    }
  }
  return chosen;
}

async function getProxyIndexLayer(pool, { forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && semanticProxyIndexCache.value && semanticProxyIndexCache.expiresAt > now) {
    return semanticProxyIndexCache.value;
  }

  if (!forceRefresh) {
    const persisted = loadPersistedProxyIndex(SEMANTIC_PROXY_INDEX_CACHE_FILE, SEMANTIC_PROXY_INDEX_TTL_MS);
    if (persisted) {
      semanticProxyIndexCache = {
        value: persisted,
        expiresAt: now + SEMANTIC_PROXY_INDEX_TTL_MS,
      };
      return persisted;
    }
  }

  const q = await pool.query(`
    SELECT lower(key) AS key, COUNT(*)::int AS cnt
    FROM attributes
    WHERE key IS NOT NULL AND btrim(key) <> ''
    GROUP BY lower(key)
    ORDER BY cnt DESC, lower(key)
    LIMIT 400
  `);

  const rows = Array.isArray(q?.rows) ? q.rows : [];
  const proxyIndex = buildProxyIndexFromRows(rows);

  semanticProxyIndexCache = {
    value: proxyIndex,
    expiresAt: now + SEMANTIC_PROXY_INDEX_TTL_MS,
  };
  persistProxyIndex(SEMANTIC_PROXY_INDEX_CACHE_FILE, proxyIndex);

  return proxyIndex;
}

function extractAnchors(query = '') {
  const text = String(query || '');
  const anchors = [];
  for (const city of CITY_ALIAS_PATTERNS) {
    if (city.regex.test(text)) {
      anchors.push(city.canonical);
    }
  }
  const aspectRe = /\b(population|rent|income|wage|employment|education|density|infrastructure|building\s+programs?)\b/gi;
  let m = aspectRe.exec(text);
  while (m) {
    anchors.push(m[1]);
    m = aspectRe.exec(text);
  }
  return Array.from(new Set(anchors.map((a) => String(a || '').trim()).filter(Boolean)));
}

function deriveCityHintsFromText(text = '') {
  const cityNames = new Set();
  const cityNodeIds = new Set();
  const normalized = String(text || '').trim();
  if (!normalized) {
    return { cityNames: [], cityNodeIds: [] };
  }
  for (const city of CITY_ALIAS_PATTERNS) {
    if (city.regex.test(normalized)) {
      cityNames.add(city.canonical);
      if (city.nodeId) cityNodeIds.add(city.nodeId);
    }
  }
  return {
    cityNames: Array.from(cityNames),
    cityNodeIds: Array.from(cityNodeIds),
  };
}

async function computeQueryEmbedding(text) {
  try {
    const emb = await withTimeout(
      localEmbeddings.embedQuery(String(text || '')),
      SEMANTIC_EMBED_TIMEOUT_MS,
      'semantic-rag embed query',
    );
    return Array.isArray(emb) && emb.length > 0 ? emb.map((x) => Number(x) || 0) : null;
  } catch (_e) {
    return null;
  }
}

async function semanticSearchEmbeddingsInDB(pool, query, topK = 5) {
  const emb = await computeQueryEmbedding(query);
  if (!emb) return null;

  const tablesRes = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND (data_type ILIKE 'vector' OR column_name ILIKE 'embedding')`
  );
  if (!tablesRes.rows || tablesRes.rows.length === 0) return null;

  const results = [];
  for (const row of tablesRes.rows) {
    const table = row.table_name;
    const col = row.column_name;
    const idColsRes = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position LIMIT 5`,
      [table]
    );
    const idCols = idColsRes.rows.map((r) => r.column_name).filter(Boolean);
    const selectCols = idCols.length > 0 ? idCols.join(', ') : '*';

    try {
      const q = `SELECT ${selectCols}, ${col} <-> $1::vector AS distance FROM ${table} WHERE ${col} IS NOT NULL ORDER BY distance ASC LIMIT $2`;
      const r = await pool.query(q, [emb, topK]);
      for (const rrow of r.rows) {
        const d = Number(rrow.distance);
        const similarity = Number.isFinite(d) ? (1 / (1 + d)) : 0;
        results.push({ table, column: col, distance: d, similarity, row: rrow, metric: 'distance' });
      }
    } catch (_e) {
      try {
        const q2 = `SELECT ${selectCols}, (1 - (${col} <#> $1::vector)) AS score FROM ${table} WHERE ${col} IS NOT NULL ORDER BY score DESC LIMIT $2`;
        const r2 = await pool.query(q2, [emb, topK]);
        for (const rrow of r2.rows) {
          const s = Number(rrow.score);
          results.push({ table, column: col, distance: null, similarity: Number.isFinite(s) ? s : 0, row: rrow, metric: 'score' });
        }
      } catch (_e2) {
      }
    }
  }
  results.sort((a, b) => Number(b.similarity || 0) - Number(a.similarity || 0));
  return results.slice(0, Math.max(1, topK));
}

function loadSqlFileEmbeddingIndex(indexPath = SEMANTIC_SQL_FILE_EMBEDDING_INDEX_PATH) {
  const parsed = readJsonFileCached(indexPath, semanticSqlFileEmbeddingIndexCache);
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.entries)) return parsed.entries;
  if (Array.isArray(parsed?.files)) return parsed.files;
  return [];
}

export function rankSqlFileEmbeddingEntries(queryEmbedding = [], entries = [], topK = 5) {
  if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0 || !Array.isArray(entries)) return [];
  const matches = [];
  for (const entry of entries) {
    const vector = Array.isArray(entry?.embedding) ? entry.embedding : (Array.isArray(entry?.vector) ? entry.vector : null);
    if (!Array.isArray(vector) || vector.length !== queryEmbedding.length || vector.length === 0) continue;
    const dot = vector.reduce((sum, value, index) => sum + ((Number(value) || 0) * (Number(queryEmbedding[index]) || 0)), 0);
    const normA = Math.sqrt(vector.reduce((sum, value) => sum + ((Number(value) || 0) ** 2), 0));
    const normB = Math.sqrt(queryEmbedding.reduce((sum, value) => sum + ((Number(value) || 0) ** 2), 0));
    const similarity = normA > 0 && normB > 0 ? (dot / (normA * normB)) : 0;
    matches.push({
      file: String(entry?.file || entry?.path || '').trim(),
      similarity,
      snippet: String(entry?.snippet || entry?.content || '').slice(0, 240),
    });
  }
  matches.sort((a, b) => Number(b.similarity || 0) - Number(a.similarity || 0));
  return matches.slice(0, Math.max(1, topK));
}

async function semanticSearchEmbeddingsInSqlFiles(query, topK = 5, { indexPath = SEMANTIC_SQL_FILE_EMBEDDING_INDEX_PATH } = {}) {
  try {
    const emb = await computeQueryEmbedding(query);
    if (!emb) return null;
    const entries = loadSqlFileEmbeddingIndex(indexPath);
    if (entries.length === 0) return null;
    const matches = rankSqlFileEmbeddingEntries(emb, entries, topK);
    return matches.length > 0 ? matches : null;
  } catch (_e) {
    return null;
  }
}

function deriveSemanticEntityHintsFromEmbeddingContext(embeddingContext = [], userQuery = '') {
  const cityNames = new Set();
  const cityNodeIds = new Set();

  const queryHints = deriveCityHintsFromText(userQuery);
  for (const name of queryHints.cityNames) cityNames.add(name);
  for (const nodeId of queryHints.cityNodeIds) cityNodeIds.add(nodeId);

  for (const item of embeddingContext) {
    const row = item?.row || {};
    const name = String(row?.name || row?.city || row?.locality || '').trim();
    const nodeId = String(row?.node_id || row?.id || '').trim();
    if (name) cityNames.add(name);
    if (nodeId) cityNodeIds.add(nodeId);

    const rowHints = deriveCityHintsFromText(name);
    for (const n of rowHints.cityNames) cityNames.add(n);
    for (const nId of rowHints.cityNodeIds) cityNodeIds.add(nId);
  }
  return {
    cityNames: Array.from(cityNames).slice(0, 10),
    cityNodeIds: Array.from(cityNodeIds).slice(0, 10),
  };
}

function rewriteSemanticQueryWithGraphTraversal(query, { schemaGrounding = null, enabled = false } = {}) {
  if (!enabled) return String(query || '');
  const fkPairs = Array.isArray(schemaGrounding?.foreignKeys)
    ? schemaGrounding.foreignKeys.slice(0, 6).map((f) => `${f.fromTable}.${f.fromColumn}->${f.toTable}.${f.toColumn}`)
    : [];
  const fkHint = fkPairs.length > 0 ? ` using graph traversal hints over ${fkPairs.join(', ')}` : '';
  return `${String(query || '').trim()}${fkHint}`.trim();
}

export function buildRecursiveSemanticQueries(seedQuery, {
  recursiveEnabled = false,
  maxDepth = 0,
  maxQueries = SEMANTIC_RETRIEVAL_QUERY_LIMIT,
  maxExpansions = SEMANTIC_RECURSIVE_MAX_EXPANSIONS,
  semanticEntityHints = null,
} = {}) {
  const out = [String(seedQuery || '').trim()].filter(Boolean);
  if (!recursiveEnabled) return Array.from(new Set(out));
  const normalizedMaxQueries = clampInteger(maxQueries, { min: 2, max: 4, fallback: SEMANTIC_RETRIEVAL_QUERY_LIMIT });
  const depth = clampInteger(maxDepth, { min: 0, max: clampInteger(maxExpansions, { min: 1, max: 2, fallback: SEMANTIC_RECURSIVE_MAX_EXPANSIONS }), fallback: 0 });
  const expansionSuffixes = ['with related entities', 'with neighboring graph context'];
  for (let d = 0; d < depth && out.length < normalizedMaxQueries; d++) {
    for (const suffix of expansionSuffixes) {
      if (out.length >= normalizedMaxQueries) break;
      out.push(`${seedQuery} ${suffix}`.trim());
    }
  }
  for (const name of semanticEntityHints?.cityNames || []) {
    if (out.length >= normalizedMaxQueries) break;
    out.push(`${seedQuery} related to ${name}`);
  }
  return Array.from(new Set(out)).slice(0, normalizedMaxQueries);
}

export function buildSemanticRetrievalPlan({
  query,
  schemaGrounding = null,
  anchors = [],
  useGraph = false,
  sqlRewriterEnabled = false,
  recursiveEnabled = false,
  recursiveMaxDepth = 0,
  semanticEntityHints = null,
  maxQueries = SEMANTIC_RETRIEVAL_QUERY_LIMIT,
  maxExpansions = SEMANTIC_RECURSIVE_MAX_EXPANSIONS,
} = {}) {
  const rewrittenQuery = rewriteSemanticQueryWithGraphTraversal(query, {
    schemaGrounding,
    enabled: Boolean(useGraph && sqlRewriterEnabled),
  });
  const initialQueries = [String(rewrittenQuery || '').trim()].filter(Boolean);
  const hintParts = [
    ...((semanticEntityHints?.cityNames || []).map((value) => String(value || '').trim()).filter(Boolean)),
    ...((semanticEntityHints?.cityNodeIds || []).map((value) => String(value || '').trim()).filter(Boolean)),
  ];
  if (hintParts.length > 0 && initialQueries.length < Math.max(1, Number(maxQueries) || SEMANTIC_RETRIEVAL_QUERY_LIMIT)) {
    initialQueries.push(`${rewrittenQuery} focused on ${hintParts.join(' ')} population population_approx`);
  }
  const fallbackQueries = buildRecursiveSemanticQueries(rewrittenQuery, {
    recursiveEnabled,
    maxDepth: recursiveMaxDepth,
    maxQueries,
    maxExpansions,
    semanticEntityHints,
  }).filter((candidate) => candidate !== rewrittenQuery);
  return {
    rewrittenQuery,
    initialQueries: Array.from(new Set(initialQueries.map((entry) => String(entry || '').trim()).filter(Boolean))).slice(0, Math.max(1, Number(maxQueries) || SEMANTIC_RETRIEVAL_QUERY_LIMIT)),
    fallbackQueries,
    anchorFilters: Array.from(new Set([
      ...(anchors || []),
      ...(semanticEntityHints?.cityNames || []),
      ...(semanticEntityHints?.cityNodeIds || []),
    ].map((anchor) => String(anchor || '').trim()).filter(Boolean))),
  };
}

function extractApproxPopulation(candidate) {
  const text = `${candidate?.name || ''}\n${candidate?.description || ''}`;
  if (!text) return null;
  const match = text.match(/population(?:_approx)?[\s\S]{0,120}?(\d[\d,]*)/i);
  if (!match || !match[1]) return null;
  const normalized = String(match[1]).replace(/,/g, '').trim();
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function matchesAnyHint(candidate, hints = []) {
  if (!Array.isArray(hints) || hints.length === 0) return false;
  const haystack = `${candidate?.id || ''} ${candidate?.name || ''} ${candidate?.description || ''}`.toLowerCase();
  return hints.some((hint) => {
    const token = String(hint || '').toLowerCase().trim();
    return token && haystack.includes(token);
  });
}

async function fetchPopulationApproxForCityNodeIds(pool, cityNodeIds = []) {
  const ids = Array.isArray(cityNodeIds)
    ? cityNodeIds.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (ids.length === 0) return null;
  try {
    const res = await pool.query(
      `SELECT node_id, coalesce(attribute_key, key) AS metric_key, attribute_value
       FROM attributes
       WHERE node_id = ANY($1)
         AND (
           attribute_key IN ('population_approx', 'population')
           OR key IN ('population_approx', 'population')
         )
       ORDER BY CASE WHEN attribute_value ~ '^\\d+$' THEN 0 ELSE 1 END, length(attribute_value::text) DESC
       LIMIT 1`,
      [ids],
    );
    const row = res?.rows?.[0];
    if (!row) return null;
    const raw = String(row.attribute_value || '').trim();
    const numeric = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(numeric)) return null;
    return {
      nodeId: String(row.node_id || '').trim(),
      metricKey: String(row.metric_key || 'population').trim(),
      value: numeric,
    };
  } catch (_err) {
    return null;
  }
}

async function fetchPopulationApproxForCityNames(pool, cityNames = []) {
  const names = Array.isArray(cityNames)
    ? cityNames
      .map((value) => String(value || '').trim().toLowerCase())
      .map((value) => value.replace(/[^a-z0-9]+/g, ''))
      .filter(Boolean)
    : [];
  if (names.length === 0) return null;
  try {
    for (const cityName of names) {
      const likeToken = `%${cityName}%`;
      const res = await pool.query(
        `SELECT a.node_id, coalesce(a.attribute_key, a.key) AS metric_key, a.attribute_value
         FROM attributes a
         JOIN nodes n ON n.node_id = a.node_id
         WHERE (
           a.attribute_key IN ('population_approx', 'population')
           OR a.key IN ('population_approx', 'population')
         )
           AND regexp_replace(lower(coalesce(n.name,'') || ' ' || coalesce(n.title,'') || ' ' || coalesce(n.description,'')), '[^a-z0-9]+', '', 'g') LIKE $1
         ORDER BY CASE WHEN a.attribute_value ~ '^\\d+$' THEN 0 ELSE 1 END, length(a.attribute_value::text) DESC
         LIMIT 1`,
        [likeToken],
      );
      const row = res?.rows?.[0];
      if (!row) continue;
      const raw = String(row.attribute_value || '').trim();
      const numeric = Number(raw.replace(/,/g, ''));
      if (!Number.isFinite(numeric)) continue;
      return {
        nodeId: String(row.node_id || '').trim(),
        metricKey: String(row.metric_key || 'population').trim(),
        value: numeric,
      };
    }
    return null;
  } catch (_err) {
    return null;
  }
}

function buildPopulationEvidenceCandidate({ cityLabel = 'city', nodeId = '', metricKey = 'population', value = null } = {}) {
  const safeNode = String(nodeId || '').trim();
  const safeMetric = String(metricKey || 'population').trim();
  const safeCity = String(cityLabel || 'city').trim();
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return {
    id: `population-evidence-${safeNode || 'city'}`,
    name: `${safeCity} ${safeMetric}`,
    description: `city=${safeCity}; node_id=${safeNode || 'unknown'}; ${safeMetric}=${numeric}; source=sql-fallback`,
    semanticScore: 1,
    bm25Score: 1,
    combinedScore: 1,
    sourceQuery: 'sql-fallback-population-evidence',
  };
}

function prependEvidenceCandidate(candidates = [], evidenceCandidate = null, topK = 5) {
  if (!evidenceCandidate) return Array.isArray(candidates) ? candidates : [];
  const existing = Array.isArray(candidates) ? candidates : [];
  const deduped = existing.filter((candidate) => String(candidate?.id || '').trim() !== String(evidenceCandidate.id || '').trim());
  return [evidenceCandidate, ...deduped].slice(0, Math.max(1, Number(topK) || 5));
}

function countAnchorMatches(candidate, anchors = []) {
  if (!Array.isArray(anchors) || anchors.length === 0) return 0;
  const normalizeLoose = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const normalizeCompact = (value) => normalizeLoose(value).replace(/\s+/g, '');
  const haystackRaw = `${candidate?.name || ''} ${candidate?.description || ''} ${candidate?.sourceQuery || ''}`;
  const haystack = normalizeLoose(haystackRaw);
  const haystackCompact = normalizeCompact(haystackRaw);
  let matches = 0;
  for (const anchor of anchors) {
    const normalized = normalizeLoose(anchor);
    const compact = normalizeCompact(anchor);
    if (!normalized) continue;
    if (haystack.includes(normalized) || (compact && haystackCompact.includes(compact))) {
      matches += 1;
    }
  }
  return matches;
}

export function applyAnchorFilteringToCandidates(candidates = [], anchors = [], { minRetain = 3 } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0 || !Array.isArray(anchors) || anchors.length === 0) {
    return Array.isArray(candidates) ? candidates : [];
  }
  const scored = candidates.map((candidate) => ({
    ...candidate,
    anchorMatchCount: countAnchorMatches(candidate, anchors),
  }));
  const matched = scored.filter((candidate) => candidate.anchorMatchCount > 0);
  if (matched.length === 0) return candidates;
  matched.sort((left, right) => {
    if (right.anchorMatchCount !== left.anchorMatchCount) return right.anchorMatchCount - left.anchorMatchCount;
    return Number(right.combinedScore || right.rerankedScore || 0) - Number(left.combinedScore || left.rerankedScore || 0);
  });
  if (matched.length >= Math.min(minRetain, candidates.length)) {
    return matched.map(({ anchorMatchCount, ...candidate }) => candidate);
  }
  const unmatched = scored.filter((candidate) => candidate.anchorMatchCount === 0);
  return [...matched, ...unmatched].map(({ anchorMatchCount, ...candidate }) => candidate);
}

function mergeCandidates(semanticCandidates = [], bm25Candidates = [], weights = { semantic: 0.7, bm25: 0.3 }, topK = 15) {
  const map = new Map();
  const add = (arr, keyName) => {
    for (const item of arr || []) {
      const id = String(item?.id || item?.name || item?.description || '').trim();
      if (!id) continue;
      const prev = map.get(id) || { ...item, semanticScore: 0, bm25Score: 0 };
      prev.semanticScore = Math.max(Number(prev.semanticScore || 0), Number(item?.semanticScore || 0));
      prev.bm25Score = Math.max(Number(prev.bm25Score || 0), Number(item?.bm25Score || 0));
      if (item?.description && !prev.description) prev.description = item.description;
      if (item?.name && !prev.name) prev.name = item.name;
      if (item?.sourceQuery && !prev.sourceQuery) prev.sourceQuery = item.sourceQuery;
      map.set(id, prev);
    }
  };
  add(semanticCandidates, 'semantic');
  add(bm25Candidates, 'bm25');
  const merged = Array.from(map.values()).map((item) => ({
    ...item,
    combinedScore: Number(item.semanticScore || 0) * Number(weights.semantic || 0.7) + Number(item.bm25Score || 0) * Number(weights.bm25 || 0.3),
  }));
  merged.sort((a, b) => Number(b.combinedScore || 0) - Number(a.combinedScore || 0));
  return merged.slice(0, Math.max(1, Number(topK) || 15));
}

function buildPgPoolConfig() {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL };
  }

  return {
    user: process.env.DB_USER || 'sso_user',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'sso_db',
    password: process.env.DB_PASSWORD || 'sso_pass',
    port: parseInt(process.env.DB_PORT || '5433', 10),
  };
}

async function loadBm25Docs(pool) {
  const bm25MaxDocs = parseInt(process.env.RAG_BM25_MAX_DOCS || '1500', 10);
  const res = await pool.query(`SELECT id, content, metadata FROM rag_documents ORDER BY id DESC LIMIT $1`, [bm25MaxDocs]);
  const rows = res.rows || [];
  const { Document } = await import('@langchain/core/documents');
  return rows.map((r) => new Document({ pageContent: r.content, metadata: r.metadata || {} }));
}

async function initializeVectorStore(pool) {
  const { PGVectorStore } = await import('@langchain/community/vectorstores/pgvector');
  return PGVectorStore.initialize(localEmbeddings, {
    pool,
    tableName: 'rag_documents',
    columns: {
      contentColumnName: 'content',
      metadataColumnName: 'metadata',
      vectorColumnName: 'embedding',
      idColumnName: 'id',
    },
  });
}

// Replace computeSemanticCandidates / computeBM25Candidates with LangChain-based retrieval
async function initializeVectorStoreAndDocs(pool) {
  const [vectorStore, allDocs] = await Promise.all([
    withTimeout(initializeVectorStore(pool), SEMANTIC_VECTOR_INIT_TIMEOUT_MS, 'semantic-rag vector store init').catch(() => null),
    withTimeout(loadBm25Docs(pool), SEMANTIC_BM25_DOC_LOAD_TIMEOUT_MS, 'semantic-rag bm25 doc load').catch(() => []),
  ]);
  return { vectorStore, allDocs };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableInsertError(error) {
  const text = `${error?.name || ''} ${error?.message || error || ''}`.toLowerCase();
  return /timeout|timed out|network|socket|temporar|transient|connection|econnreset|econnrefused|deadlock|too many|rate limit|429|502|503|504/.test(text);
}

export function chunkDocumentsForInsert(documents = [], batchSize = 32) {
  const normalizedBatchSize = Math.max(1, Number(batchSize) || 32);
  const batches = [];
  for (let index = 0; index < documents.length; index += normalizedBatchSize) {
    batches.push(documents.slice(index, index + normalizedBatchSize));
  }
  return batches;
}

async function retryAddBatch(addBatch, batch, { retryAttempts = 2, retryDelayMs = 300 } = {}) {
  const attempts = Math.max(1, Number(retryAttempts) || 1);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await addBatch(batch);
      return { attemptsUsed: attempt };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableInsertError(error)) break;
      await sleep(Math.max(100, Number(retryDelayMs) || 300) * (2 ** (attempt - 1)));
    }
  }

  throw lastError;
}

export async function addDocumentsWithBatchControl(addBatch, documents = [], {
  batchSize = 32,
  retryAttempts = 2,
  retryDelayMs = 300,
  onBatchComplete = null,
} = {}) {
  const batches = chunkDocumentsForInsert(documents, batchSize);
  const failedDocuments = [];
  const batchSummaries = [];
  let inserted = 0;
  let partialFailureCount = 0;

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    const startedAt = Date.now();
    try {
      const batchResult = await retryAddBatch(addBatch, batch, { retryAttempts, retryDelayMs });
      inserted += batch.length;
      const summary = {
        batchIndex,
        size: batch.length,
        inserted: batch.length,
        failed: 0,
        attemptsUsed: batchResult.attemptsUsed,
        durationMs: Date.now() - startedAt,
        status: 'fulfilled',
      };
      batchSummaries.push(summary);
      if (typeof onBatchComplete === 'function') onBatchComplete(summary);
      continue;
    } catch (batchError) {
      let batchInserted = 0;
      let batchFailed = 0;
      const itemStartedAt = Date.now();
      for (let itemIndex = 0; itemIndex < batch.length; itemIndex += 1) {
        const document = batch[itemIndex];
        try {
          await retryAddBatch(addBatch, [document], { retryAttempts, retryDelayMs });
          batchInserted += 1;
          inserted += 1;
        } catch (itemError) {
          batchFailed += 1;
          failedDocuments.push({
            batchIndex,
            itemIndex,
            source: document?.metadata?.source || null,
            message: itemError?.message || String(itemError),
          });
        }
      }
      if (batchInserted > 0 && batchFailed > 0) partialFailureCount += 1;
      const summary = {
        batchIndex,
        size: batch.length,
        inserted: batchInserted,
        failed: batchFailed,
        attemptsUsed: Math.max(1, Number(retryAttempts) || 1),
        durationMs: Date.now() - Math.min(startedAt, itemStartedAt),
        status: batchInserted > 0 ? 'partial' : 'rejected',
        error: batchError?.message || String(batchError),
      };
      batchSummaries.push(summary);
      if (typeof onBatchComplete === 'function') onBatchComplete(summary);
    }
  }

  return {
    inserted,
    failedCount: failedDocuments.length,
    failedDocuments,
    batchCount: batchSummaries.length,
    partialFailureCount,
    batches: batchSummaries,
  };
}

// New addDocumentsToRag: uses LangChain PGVectorStore + local embeddings
export async function addDocumentsToRag(docs = [], { truncate = false, batchSize = 32, retryAttempts = 2, retryDelayMs = 300, onBatchComplete = null } = {}) {
  if (!Array.isArray(docs) || docs.length === 0) return { inserted: 0 };
  const pg = await import('pg');
  const pool = new pg.Pool(buildPgPoolConfig());
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rag_documents (
        id bigserial PRIMARY KEY,
        content text,
        metadata jsonb,
        embedding vector(384)
      );
    `);

    if (truncate) await pool.query(`TRUNCATE TABLE rag_documents RESTART IDENTITY;`);

    const { PGVectorStore } = await import('@langchain/community/vectorstores/pgvector');
    const { Document } = await import('@langchain/core/documents');

    const vectorStore = await PGVectorStore.initialize(localEmbeddings, {
      pool,
      tableName: 'rag_documents',
      columns: {
        contentColumnName: 'content',
        metadataColumnName: 'metadata',
        vectorColumnName: 'embedding',
        idColumnName: 'id',
      },
    });

    const toAdd = docs
      .map((d) => new Document({ pageContent: d.pageContent || d.content || '', metadata: d.metadata || {} }))
      .filter((doc) => String(doc.pageContent || '').trim());
    const result = await addDocumentsWithBatchControl(
      (batch) => vectorStore.addDocuments(batch),
      toAdd,
      { batchSize, retryAttempts, retryDelayMs, onBatchComplete },
    );
    return result;
  } catch (err) {
    throw err;
  } finally {
    try { await pool.end(); } catch (e) {}
  }
}

// Fix references: create OpenAI client only if key present (avoid startup crash)
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

function tokenizeForRerank(text = '') {
  return Array.from(new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
  ));
}

function tokenOverlapScore(query = '', text = '') {
  const queryTokens = tokenizeForRerank(query);
  if (queryTokens.length === 0) return 0;
  const docTokens = tokenizeForRerank(text);
  if (docTokens.length === 0) return 0;
  const overlap = docTokens.filter((token) => queryTokens.includes(token)).length;
  return overlap / queryTokens.length;
}

function inferRetrieverScore({ doc = null, index = 0, total = 1, query = '' } = {}) {
  const raw = Number(doc?.score ?? doc?.similarity ?? doc?.metadata?.score ?? NaN);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(0, Math.min(1, raw));
  }
  // LangChain retrievers often return docs without scores; derive a stable fallback from rank and lexical overlap.
  const denom = Math.max(1, Number(total) || 1);
  const rankPrior = Math.max(0.05, (denom - Number(index || 0)) / denom);
  const text = `${doc?.metadata?.title || doc?.metadata?.heading || ''} ${doc?.pageContent || doc?.content || doc?.metadata?.text || doc?.metadata?.description || ''}`;
  const overlap = tokenOverlapScore(query, text);
  return Math.max(0.05, Math.min(1, (rankPrior * 0.55) + (overlap * 0.45)));
}

function extractCityCandidateFromPopulationQuery(query = '') {
  const q = String(query || '').trim();
  if (!/\bpopulation\b/i.test(q)) return '';
  const match = q.match(/\bpopulation(?:\s+(?:of|for|in))?\s+([a-zA-Z][a-zA-Z'`._\-\s]{1,60})/i);
  if (!match || !match[1]) return '';
  let city = String(match[1] || '').replace(/[?.,!;:]+$/g, '').trim();
  city = city.replace(/\b(city|town|municipality)\b/gi, '').replace(/\s+/g, ' ').trim();
  return city;
}

export function localCrossEncoderRerank(docs, query) {
  const queryTokens = tokenizeForRerank(query);
  const scored = docs.map((doc) => {
    const docTokens = tokenizeForRerank(`${doc?.name || ''} ${doc?.description || ''}`);
    const tokenOverlap = queryTokens.length === 0
      ? 0
      : (docTokens.filter((token) => queryTokens.includes(token)).length / queryTokens.length);
    const baseScore = (Number(doc?.semanticScore || 0) * parseFloat(process.env.SEMANTIC_WEIGHT || '0.7'))
      + (Number(doc?.bm25Score || 0) * parseFloat(process.env.BM25_WEIGHT || '0.3'));
    const phraseBoost = String(doc?.description || '').toLowerCase().includes(String(query || '').toLowerCase()) ? 0.15 : 0;
    const rerankedScore = Math.max(0, Math.min(1, (baseScore * 0.55) + (tokenOverlap * 0.30) + phraseBoost));
    return { ...doc, rerankedScore };
  });
  return scored.sort((left, right) => Number(right.rerankedScore || 0) - Number(left.rerankedScore || 0));
}

async function rerankWithOpenAI(docs, query) {
  const llmCalls = [];
  const localBaseline = localCrossEncoderRerank(docs, query);
  try {
    if (!openai) throw new Error('OpenAI client not available');
    const payloadDocs = docs.map((doc, index) => ({
      id: String(doc?.id || `doc-${index}`),
      name: String(doc?.name || '').slice(0, 120),
      description: String(doc?.description || '').slice(0, 700),
    }));
    const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_RERANK_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You score document relevance. Return only a JSON array where every element is {"id":"...","score":number} and score is between 0 and 1.' },
        { role: 'user', content: `Query: ${query}\n\nDocuments: ${JSON.stringify(payloadDocs)}` },
      ],
      max_tokens: 600,
      temperature: 0,
    });
    llmCalls.push(metricFromChatCompletionResponse(resp, { label: 'semantic_rerank_batch' }));
    const text = String(resp.choices?.[0]?.message?.content || '');
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (!arrayMatch) throw new Error('Batch rerank JSON array missing');
    const parsed = JSON.parse(arrayMatch[0]);
    const scoreMap = new Map();
    for (const item of Array.isArray(parsed) ? parsed : []) {
      const id = String(item?.id || '').trim();
      const score = Number(item?.score);
      if (!id || !Number.isFinite(score)) continue;
      scoreMap.set(id, Math.max(0, Math.min(1, score)));
    }
    const reranked = localBaseline.map((doc, index) => {
      const id = String(doc?.id || `doc-${index}`);
      const llmScore = scoreMap.get(id);
      return {
        ...doc,
        rerankedScore: Number.isFinite(llmScore) ? llmScore : Number(doc?.rerankedScore || 0),
      };
    }).sort((left, right) => Number(right.rerankedScore || 0) - Number(left.rerankedScore || 0));
    return {
      docs: reranked,
      llmMetrics: buildLlmMetrics(llmCalls),
    };
  } catch (e) {
    console.warn('OpenAI batch rerank failed or not available, falling back to local reranker:', e.message);
    return { docs: localBaseline, llmMetrics: buildLlmMetrics(llmCalls) };
  }
}

async function collectRetrievedDocs({ queries = [], semanticRetriever = null, bm25Retriever = null, warnings = [] } = {}) {
  const semanticDocs = [];
  const keywordDocs = [];
  let activeSemanticRetriever = semanticRetriever;
  const usedQueries = [];
  for (const qText of queries) {
    usedQueries.push(qText);
    let sDocs = [];
    let kDocs = [];
    if (activeSemanticRetriever) {
      try {
        sDocs = await withTimeout(activeSemanticRetriever.invoke(qText), SEMANTIC_RETRIEVER_TIMEOUT_MS, 'semantic-rag vector retrieve');
      } catch (_e) {
        warnings.push('vector-retriever-timeout');
        activeSemanticRetriever = null;
        sDocs = [];
      }
    }
    if (bm25Retriever) {
      try {
        kDocs = await withTimeout(bm25Retriever.invoke(qText), SEMANTIC_RETRIEVER_TIMEOUT_MS, 'semantic-rag bm25 retrieve');
      } catch (_e) {
        warnings.push('bm25-retriever-timeout');
        kDocs = [];
      }
    }
    semanticDocs.push(...(Array.isArray(sDocs) ? sDocs.map((doc) => ({ ...doc, __sourceQuery: qText })) : []));
    keywordDocs.push(...(Array.isArray(kDocs) ? kDocs.map((doc) => ({ ...doc, __sourceQuery: qText })) : []));
  }
  return {
    semanticDocs,
    keywordDocs,
    semanticRetriever: activeSemanticRetriever,
    usedQueries,
  };
}

function buildSystemPrompt(base = '') {
  const securityFramework = buildAgentSecurityPromptFramework({
    agentName: 'semantic_rag_agent',
    goal: 'Retrieve and synthesize semantic evidence grounded in available contexts.',
    tools: [
      'Semantic retrieval over embeddings and rag_documents.',
      'Proxy index + semantic similarity inference + multi-anchor context inputs.',
    ],
    outputContract: 'Return concise grounded answer text without fabricated citations or unseen facts.',
  });
  const sys = `${base}\n\nAgent role: semantic retrieval and grounded synthesis for hybrid SQL+RAG workflows.\n\nPermissions and boundaries:\n- Allowed inputs: user query, rewritten queries, schema grounding, proxy-index hints, embedding contexts, and retrieved docs.\n- Allowed outputs: concise grounded answer + source-aware summary.\n- Never fabricate facts, schema, SQL results, or citations not present in provided evidence.\n\nMechanism alignment requirements:\n- Consider user-question embedding similarity against embedding-bearing SQL entities and SQL files (cosine-based matches when available).\n- Respect semantic similarity inference layer over proxy dimensions when explicit features are missing.\n- Respect proxy-index mapping from natural language aspects to canonical attribute keys.\n- Respect SQL rewrite + graph traversal context supplied by upstream orchestrators.\n- Respect multi-anchor and recursive retrieval context when provided.\n- Respect SQL ingest bootstrap context powered by ingestSqlTablesToRag when sqlIngestLayerEnabled is true.\n\nRules:\n- Keep answers concise and factual.\n- If evidence is weak or conflicting, say so explicitly.\n- Prefer top-ranked grounded evidence; avoid broad speculation.\n\nFew-shot examples:\n- Query: What is Tel Aviv?\n  Top docs: [{"name":"Tel_Aviv_Yafo","description":"A city..."}]\n  Answer: Tel Aviv is ... (source: Tel_Aviv_Yafo).\n- Query: Which areas are semantically similar to statistical_5000_111 for rent?\n  Context: proxy-index matched rent keys + embedding matches.\n  Answer: The closest areas are ... based on retrieved rent-related context and similarity signals.\n\nReasoning policy:\n- You may reason internally, but never reveal chain-of-thought. Return only final answer content.`;
  return `${sys}\n\n${securityFramework}`;
}

export async function runSemanticRAG({ query, topK = TOP_K, useRerank = false, systemPrompt = '', userId = null, schemaOnly = false, sqlOptions = {} } = {}) {
  console.log('[runSemanticRAG] called with query:', query, 'topK:', topK, 'userId:', userId, 'schemaOnly:', schemaOnly, 'sqlOptions:', sqlOptions);
  const pg = await import('pg');
  const pool = new pg.Pool(buildPgPoolConfig());
  const started = Date.now();
  try {
    let llmMetrics = emptyLlmMetrics();
    const warnings = [];
    const evalMode = Boolean(sqlOptions?.evalMode || sqlOptions?.disableMemory || sqlOptions?.disableWrites);
    const includeRagasReport = sqlOptions?.includeRagasReport != null
      ? Boolean(sqlOptions.includeRagasReport)
      : evalMode;
    const answerGenerationEnabled = sqlOptions?.answerGenerationEnabled != null
      ? Boolean(sqlOptions.answerGenerationEnabled)
      : true;
    const recentMemory = evalMode ? [] : memoryTool({ agent: 'semantic-rag', userId, limit: 5 }).recent;
    let schemaGrounding = { tables: [], columns: [], foreignKeys: [] };
    try {
      console.log('[runSemanticRAG] getting schema graph...');
      const schema = await getSchemaGraph({ db: pool });
      schemaGrounding = buildSchemaGrounding(query, schema, { maxTables: 6, maxColumns: 35, maxForeignKeys: 20 });
      console.log('[runSemanticRAG] schema grounding complete');
    } catch (_e) {
      console.error('[runSemanticRAG] schema grounding failed:', _e);
      schemaGrounding = { tables: [], columns: [], foreignKeys: [] };
    }

    if (schemaOnly) {
      console.log('[runSemanticRAG] schemaOnly mode, returning early');
      const answer = 'Schema grounding generated (schema-only mode).';
      if (!evalMode) {
        await remember({ userId, agent: 'semantic-rag', query, response: { answer, docs: [], schemaGrounding } });
        appendBufferEntry({ agent: 'semantic-rag', userId, type: 'rag-result', payload: { query, docs: 0, schemaOnly: true } });
      }
      return {
        answer,
        docs: [],
        schemaGrounding,
        mode: 'schema-only',
        llmMetrics,
        metrics: {
          totalLatencyMs: Math.max(0, Date.now() - started),
        },
      };
    }

    const recursiveEnabled = sqlOptions?.recursiveEnabled != null
      ? Boolean(sqlOptions.recursiveEnabled)
      : (sqlOptions?.recursiveSqlEnabled != null ? Boolean(sqlOptions.recursiveSqlEnabled) : SEMANTIC_RAG_RECURSIVE_ENABLED);
    const recursiveMaxDepth = clampInteger(
      sqlOptions?.recursiveMaxDepth != null ? sqlOptions.recursiveMaxDepth : sqlOptions?.recursiveSqlMaxDepth,
      { min: 0, max: SEMANTIC_RECURSIVE_MAX_EXPANSIONS, fallback: Math.min(SEMANTIC_RAG_RECURSIVE_MAX_DEPTH, SEMANTIC_RECURSIVE_MAX_EXPANSIONS) }
    );
    const proxyIndexLayerEnabled = sqlOptions?.proxyIndexLayerEnabled != null
      ? Boolean(sqlOptions.proxyIndexLayerEnabled)
      : SEMANTIC_PROXY_INDEX_ENABLED;
    const semanticSimilarityInferenceEnabled = sqlOptions?.semanticSimilarityInferenceEnabled != null
      ? Boolean(sqlOptions.semanticSimilarityInferenceEnabled)
      : SEMANTIC_SIMILARITY_INFERENCE_ENABLED;
    const useGraph = sqlOptions?.useGraph != null ? Boolean(sqlOptions.useGraph) : SEMANTIC_USE_GRAPH;
    const sqlRewriterEnabled = sqlOptions?.sqlRewriterEnabled != null
      ? Boolean(sqlOptions.sqlRewriterEnabled)
      : (sqlOptions?.sqlRewriteWithGraphTraversal != null ? Boolean(sqlOptions.sqlRewriteWithGraphTraversal) : SEMANTIC_SQL_REWRITE_WITH_GRAPH);
    const multiAnchorEnabled = sqlOptions?.multiAnchorEnabled != null
      ? Boolean(sqlOptions.multiAnchorEnabled)
      : SEMANTIC_MULTI_ANCHOR_ENABLED;
    const sqlIngestLayerEnabled = sqlOptions?.sqlIngestLayerEnabled != null
      ? Boolean(sqlOptions.sqlIngestLayerEnabled)
      : (evalMode ? false : SEMANTIC_SQL_INGEST_LAYER_ENABLED);
    const sqlIngestTables = Array.isArray(sqlOptions?.sqlIngestTables) && sqlOptions.sqlIngestTables.length > 0
      ? sqlOptions.sqlIngestTables
      : SEMANTIC_SQL_INGEST_TABLES;

    if (sqlIngestLayerEnabled) {
      try {
        console.log('[runSemanticRAG] Ensuring SQL tables ingested to RAG...');
        await withTimeout(
          ensureSqlTablesIngestedToRag({ enabled: true, tables: sqlIngestTables, truncate: false }),
          SEMANTIC_SQL_INGEST_BOOTSTRAP_TIMEOUT_MS,
          'semantic-rag ingest bootstrap',
        );
        console.log('[runSemanticRAG] SQL ingest complete');
      } catch (_ingestErr) {
        console.error('[runSemanticRAG] SQL ingest failed:', _ingestErr);
      }
    }

    const anchors = multiAnchorEnabled ? extractAnchors(query) : [];

    let proxyIndex = {
      enabled: proxyIndexLayerEnabled,
      categories: inferProxyCategoriesFromQuery(query),
      matchedKeys: [],
      semanticSimilarityInferenceEnabled,
    };
    if (proxyIndexLayerEnabled) {
      try {
        console.log('[runSemanticRAG] Loading proxy index layer...');
        const layer = await getProxyIndexLayer(pool);
        const categories = inferProxyCategoriesFromQuery(query);
        proxyIndex = {
          enabled: true,
          categories,
          matchedKeys: chooseProxyKeys(layer, categories, 16),
          semanticSimilarityInferenceEnabled,
        };
        console.log('[runSemanticRAG] Proxy index loaded');
      } catch (_e) {
        console.error('[runSemanticRAG] Proxy index failed:', _e);
      }
    }

    let embeddingContext = null;
    let fileEmbeddingContext = null;
    if (semanticSimilarityInferenceEnabled) {
      try {
        console.log('[runSemanticRAG] Searching embeddings in DB...');
        embeddingContext = await withTimeout(
          semanticSearchEmbeddingsInDB(pool, query, Math.max(1, Math.min(8, topK))),
          SEMANTIC_EMBED_SEARCH_TIMEOUT_MS,
          'semantic-rag db embedding search',
        );
        console.log('[runSemanticRAG] DB embedding search complete');
      } catch (_e) {
        console.error('[runSemanticRAG] DB embedding search failed:', _e);
        embeddingContext = null;
        warnings.push('db-embedding-search-unavailable');
      }
      try {
        console.log('[runSemanticRAG] Searching embeddings in SQL files...');
        fileEmbeddingContext = await withTimeout(
          semanticSearchEmbeddingsInSqlFiles(query, Math.max(1, Math.min(6, topK))),
          SEMANTIC_EMBED_SEARCH_TIMEOUT_MS,
          'semantic-rag sql-file embedding search',
        );
        console.log('[runSemanticRAG] SQL file embedding search complete');
      } catch (_e) {
        console.error('[runSemanticRAG] SQL file embedding search failed:', _e);
        fileEmbeddingContext = null;
        warnings.push('sql-file-embedding-search-unavailable');
      }
    }

    const semanticEntityHints = deriveSemanticEntityHintsFromEmbeddingContext(embeddingContext || [], query);
    const retrievalPlan = buildSemanticRetrievalPlan({
      query,
      schemaGrounding,
      anchors,
      useGraph,
      sqlRewriterEnabled,
      recursiveEnabled,
      recursiveMaxDepth,
      semanticEntityHints,
      maxQueries: SEMANTIC_RETRIEVAL_QUERY_LIMIT,
      maxExpansions: SEMANTIC_RECURSIVE_MAX_EXPANSIONS,
    });
    const rewrittenQuery = retrievalPlan.rewrittenQuery;

    console.log('[runSemanticRAG] Initializing vector store and loading docs...');
    const { vectorStore, allDocs } = await initializeVectorStoreAndDocs(pool);
    console.log('[runSemanticRAG] Vector store and docs loaded');
    let semanticRetriever = vectorStore ? vectorStore.asRetriever({ k: topK }) : null;
    if (!semanticRetriever) {
      warnings.push('vector-store-unavailable-using-bm25-only');
    }
    const { BM25Retriever } = await import('@langchain/community/retrievers/bm25');
    const bm25Retriever = allDocs.length > 0 ? BM25Retriever.fromDocuments(allDocs) : null;
    if (bm25Retriever) bm25Retriever.k = topK;

    console.log('[runSemanticRAG] Collecting initial retrieved docs...');
    const initialRetrieval = await collectRetrievedDocs({
      queries: retrievalPlan.initialQueries,
      semanticRetriever,
      bm25Retriever,
      warnings,
    });
    semanticRetriever = initialRetrieval.semanticRetriever;
    let semanticDocs = initialRetrieval.semanticDocs;
    let keywordDocs = initialRetrieval.keywordDocs;
    const usedQueries = [...initialRetrieval.usedQueries];

    if (semanticDocs.length === 0 && keywordDocs.length === 0 && retrievalPlan.fallbackQueries.length > 0) {
      console.log('[runSemanticRAG] No docs found, trying fallback queries...');
      const fallbackRetrieval = await collectRetrievedDocs({
        queries: retrievalPlan.fallbackQueries,
        semanticRetriever,
        bm25Retriever,
        warnings,
      });
      semanticDocs = semanticDocs.concat(fallbackRetrieval.semanticDocs);
      keywordDocs = keywordDocs.concat(fallbackRetrieval.keywordDocs);
      semanticRetriever = fallbackRetrieval.semanticRetriever;
      usedQueries.push(...fallbackRetrieval.usedQueries);
    }

    const uniqueQueries = Array.from(new Set(usedQueries.map((entry) => String(entry || '').trim()).filter(Boolean))).slice(0, SEMANTIC_RETRIEVAL_QUERY_LIMIT);

    const semanticCandidates = semanticDocs.map((c, idx) => ({
      id: c.metadata?.id || c.id || `semantic-${idx}`,
      name: c.metadata?.title || c.metadata?.heading || '',
      description: c.pageContent || c.content || (c.metadata && (c.metadata.text || c.metadata.description)) || '',
      semanticScore: inferRetrieverScore({ doc: c, index: idx, total: semanticDocs.length, query }),
      bm25Score: 0,
      sourceQuery: c.__sourceQuery || rewrittenQuery,
    }));
    const keywordCandidates = keywordDocs.map((c, idx) => ({
      id: c.metadata?.id || c.id || `bm25-${idx}`,
      name: c.metadata?.title || c.metadata?.heading || '',
      description: c.pageContent || c.content || (c.metadata && (c.metadata.text || c.metadata.description)) || '',
      semanticScore: 0,
      bm25Score: inferRetrieverScore({ doc: c, index: idx, total: keywordDocs.length, query }),
      sourceQuery: c.__sourceQuery || rewrittenQuery,
    }));

    const rawScoredHits = semanticDocs.filter((doc) => Number.isFinite(Number(doc?.score ?? doc?.similarity ?? doc?.metadata?.score)) && Number(doc?.score ?? doc?.similarity ?? doc?.metadata?.score) > 0).length
      + keywordDocs.filter((doc) => Number.isFinite(Number(doc?.score ?? doc?.similarity ?? doc?.metadata?.score)) && Number(doc?.score ?? doc?.similarity ?? doc?.metadata?.score) > 0).length;
    if ((SEMANTIC_WARN_MISSING_RETRIEVER_SCORES || evalMode) && rawScoredHits === 0 && (semanticDocs.length > 0 || keywordDocs.length > 0)) {
      warnings.push('retriever-scores-missing-fallback-applied');
    }

    const ensemble = applyAnchorFilteringToCandidates(mergeCandidates(
      semanticCandidates,
      keywordCandidates,
      { semantic: parseFloat(process.env.SEMANTIC_WEIGHT || '0.7'), bm25: parseFloat(process.env.BM25_WEIGHT || '0.3') },
      topK,
    ), retrievalPlan.anchorFilters);

    let final = ensemble;
    console.log('[runSemanticRAG] Candidates merged, rerank:', useRerank);
    if (useRerank) {
      if (SEMANTIC_RERANK_STRATEGY === 'openai-batch' && openai) {
        const reranked = await rerankWithOpenAI(ensemble, query);
        final = reranked.docs;
        llmMetrics = combineLlmMetrics(llmMetrics, reranked.llmMetrics);
      } else {
        final = localCrossEncoderRerank(ensemble, query);
      }
    }

    // build answer via LLM using top passages with enriched system prompt
    const docs = final.map(d => ({ id: d.id, name: d.name, description: d.description, score: d.combinedScore || d.rerankedScore }));
    const system = buildSystemPrompt(systemPrompt);

    let answer = '';
    let populationEvidenceCandidate = null;
    console.log('[runSemanticRAG] Building answer...');
    // Force local answer composition fallback: concise summary based on top docs
    try {
      if (!answerGenerationEnabled) {
        answer = '';
      } else if (!docs || docs.length === 0) {
        answer = 'No relevant documents found.';
      } else {
        const cityHints = [
          ...((semanticEntityHints?.cityNames || []).map((v) => String(v || '').trim()).filter(Boolean)),
          ...((semanticEntityHints?.cityNodeIds || []).map((v) => String(v || '').trim()).filter(Boolean)),
        ];
        const queryCityCandidate = extractCityCandidateFromPopulationQuery(query);
        const isPopulationQuestion = /\bpopulation\b/i.test(String(query || ''));
        const cityFocusedDoc = final.find((doc) => matchesAnyHint(doc, cityHints));
        const cityPopulation = cityFocusedDoc ? extractApproxPopulation(cityFocusedDoc) : null;
        const populationFromSql = (isPopulationQuestion && (semanticEntityHints?.cityNodeIds || []).length > 0)
          ? await fetchPopulationApproxForCityNodeIds(pool, semanticEntityHints.cityNodeIds)
          : null;
        const cityNameHints = Array.from(new Set([
          ...((semanticEntityHints?.cityNames || []).map((v) => String(v || '').trim()).filter(Boolean)),
          ...(queryCityCandidate ? [queryCityCandidate] : []),
        ]));
        const populationFromCityNameSql = (isPopulationQuestion && cityNameHints.length > 0)
          ? await fetchPopulationApproxForCityNames(pool, cityNameHints)
          : null;
        if (isPopulationQuestion && cityFocusedDoc && Number.isFinite(cityPopulation)) {
          const cityLabel = semanticEntityHints?.cityNames?.[0] || queryCityCandidate || 'the requested city';
          answer = `${cityLabel} population (population_approx) is ${cityPopulation}.`;
        } else if (isPopulationQuestion && populationFromSql && Number.isFinite(populationFromSql.value)) {
          const cityLabel = semanticEntityHints?.cityNames?.[0] || queryCityCandidate || 'the requested city';
          answer = `${cityLabel} population is ${populationFromSql.value}.`;
          populationEvidenceCandidate = buildPopulationEvidenceCandidate({
            cityLabel,
            nodeId: populationFromSql.nodeId,
            metricKey: populationFromSql.metricKey,
            value: populationFromSql.value,
          });
          warnings.push('population-answer-sql-fallback');
        } else if (isPopulationQuestion && populationFromCityNameSql && Number.isFinite(populationFromCityNameSql.value)) {
          const cityLabel = semanticEntityHints?.cityNames?.[0] || queryCityCandidate || 'the requested city';
          answer = `${cityLabel} population is ${populationFromCityNameSql.value}.`;
          populationEvidenceCandidate = buildPopulationEvidenceCandidate({
            cityLabel,
            nodeId: populationFromCityNameSql.nodeId,
            metricKey: populationFromCityNameSql.metricKey,
            value: populationFromCityNameSql.value,
          });
          warnings.push('population-answer-cityname-sql-fallback');
        } else if (isPopulationQuestion && cityHints.length > 0 && !cityFocusedDoc) {
          answer = 'I could not find a city-specific population row for the requested city in the retrieved documents.';
        } else {
          const top = docs.slice(0, Math.min(5, docs.length));
          const titles = top.map(d => d.name || (d.description || '').slice(0, 60)).join('; ');
          answer = `Found ${final.length} candidate documents. Top sources: ${titles}. Use /api/agents/semantic-rag/debug to inspect candidates.`;
        }
      }
    } catch (e) {
      answer = 'Could not compose an answer without LLM.';
    }

    if (populationEvidenceCandidate) {
      final = prependEvidenceCandidate(final, populationEvidenceCandidate, topK);
    }

    const recursion = {
      enabled: recursiveEnabled,
      maxDepth: recursiveMaxDepth,
      used: uniqueQueries.length > retrievalPlan.initialQueries.length,
      multiAnchorEnabled,
      anchorCount: anchors.length,
      anchors,
      queryCount: uniqueQueries.length,
      initialQueryCount: retrievalPlan.initialQueries.length,
      fallbackQueryCount: retrievalPlan.fallbackQueries.length,
      sqlRewriteWithGraphTraversal: Boolean(useGraph && sqlRewriterEnabled),
    };

    const advancedLayers = {
      proxyIndex,
      semanticSimilarityInference: {
        enabled: semanticSimilarityInferenceEnabled,
        embeddingMatches: Array.isArray(embeddingContext) ? embeddingContext.slice(0, 8) : [],
        sqlFileMatches: Array.isArray(fileEmbeddingContext) ? fileEmbeddingContext.slice(0, 6) : [],
        semanticEntityHints,
      },
      retrievalFallbacks: {
        warnings,
        vectorStoreAvailable: Boolean(vectorStore),
        bm25Available: allDocs.length > 0,
      },
      queryRewrite: {
        enabled: Boolean(useGraph && sqlRewriterEnabled),
        useGraph,
        rewrittenQuery,
      },
      recursion,
    };

    if (!evalMode) {
      try {
        await withTimeout(
          remember({ userId, agent: 'semantic-rag', query, response: { answer, docs: final, schemaGrounding, advancedLayers } }),
          SEMANTIC_MEMORY_WRITE_TIMEOUT_MS,
          'semantic-rag memory write',
        );
      } catch (err) {
        warnings.push('memory-write-timeout');
      }
      appendBufferEntry({ agent: 'semantic-rag', userId, type: 'rag-result', payload: { query, docs: final.length, recursiveQueries: uniqueQueries.length } });
    }
    const totalLatencyMs = Math.max(0, Date.now() - started);
    const resultObj = {
      answer,
      docs: final,
      schemaGrounding,
      proxyIndex,
      recursion,
      advancedLayers,
      warnings,
      llmMetrics,
      metrics: {
        totalLatencyMs,
      },
      ragasReport: includeRagasReport
        ? buildSinglePathwayRagasReport({
            query,
            pathway: 'semantic',
            answer,
            docs: final,
            llmMetrics,
            latencyMs: totalLatencyMs,
          })
        : null,
    };
    if (String(process.env.SEMANTIC_RAG_VERBOSE_OUTPUT || 'false').toLowerCase() === 'true') {
      try {
        console.log('[RAG OUTPUT]', JSON.stringify(resultObj, null, 2));
      } catch (_e) {
        console.log('[RAG OUTPUT] (stringify failed)', resultObj);
      }
    }
    return resultObj;
  } finally {
    try {
      await withTimeout(pool.end(), 3000, 'semantic-rag pool shutdown');
    } catch (_poolErr) {
    }
  }
}

// Debug helper: return semantic + bm25 candidate lists for a query
export async function debugMatchAndRank({ query, topK = TOP_K } = {}) {
  const pg = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { vectorStore, allDocs } = await initializeVectorStoreAndDocs(pool);
    const semanticRetriever = vectorStore.asRetriever({ k: topK });
    const { BM25Retriever } = await import('@langchain/community/retrievers/bm25');
    const bm25Retriever = BM25Retriever.fromDocuments(allDocs);
    bm25Retriever.k = topK;

    let semantic = [];
    let bm25 = [];
    const warnings = [];
    try {
      semantic = await withTimeout(
        semanticRetriever.invoke(query),
        SEMANTIC_RETRIEVER_TIMEOUT_MS,
        'semantic-rag debug vector retrieve',
      );
    } catch (_err) {
      warnings.push('debug-vector-timeout');
    }
    try {
      bm25 = await withTimeout(
        bm25Retriever.invoke(query),
        SEMANTIC_RETRIEVER_TIMEOUT_MS,
        'semantic-rag debug bm25 retrieve',
      );
    } catch (_err) {
      warnings.push('debug-bm25-timeout');
    }

    return { semantic, bm25, warnings };
  } finally {
    try {
      await withTimeout(pool.end(), 3000, 'semantic-rag debug pool shutdown');
    } catch (_poolErr) {
    }
  }
}
