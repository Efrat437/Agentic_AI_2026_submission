import 'dotenv/config';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { classifyQueryDetailed } from './classifier_agent.js';
import { runSemanticRAG } from './semantic_rag_agent.js';
import { isDirectStructuredLookupQuery, runSQLRAG } from './sql_rag_agent.js';
import { resetConversationState } from './memoryTool.js';
import { cleanupEvaluationArtifacts } from './dbTools.js';
import { buildLlmMetrics, combineLlmMetrics, emptyLlmMetrics, metricFromChatCompletionResponse } from '../services/llmMetrics.js';

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const LANGGRAPH_TOP_K = Math.max(3, parseInt(process.env.LANGGRAPH_RETRIEVAL_TOP_K || '8', 10));
const LANGGRAPH_BRANCH_TIMEOUT_MS = Math.max(5000, parseInt(process.env.LANGGRAPH_BRANCH_TIMEOUT_MS || '25000', 10));
const LANGGRAPH_TOTAL_BUDGET_MS = Math.max(8000, parseInt(process.env.LANGGRAPH_TOTAL_BUDGET_MS || String(LANGGRAPH_BRANCH_TIMEOUT_MS), 10));
const LANGGRAPH_ANSWER_TIMEOUT_MS = Math.max(5000, parseInt(process.env.LANGGRAPH_ANSWER_TIMEOUT_MS || '15000', 10));
const GROUNDED_EVAL_DATASET_PATH = path.resolve(process.cwd(), '02_backend', 'eval', 'langgraph_eval_dataset.json');

let groundedEvalDatasetCache = {
  mtimeMs: 0,
  items: [],
};

const RetrievalState = Annotation.Root({
  query: Annotation(),
  userId: Annotation(),
  sessionId: Annotation(),
  threadId: Annotation(),
  evalMode: Annotation(),
  sqlOptions: Annotation(),
  strategy: Annotation(),
  routeReason: Annotation(),
  branches: Annotation(),
  mergedContext: Annotation(),
  answer: Annotation(),
  metrics: Annotation(),
  llmMetrics: Annotation(),
  errors: Annotation(),
});

function nowMs() {
  return Date.now();
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

function buildIsolatedUserId({ userId = null, sessionId = null, threadId = null, evalMode = false } = {}) {
  if (!evalMode) {
    return userId;
  }
  const sid = String(sessionId || randomUUID());
  const tid = String(threadId || 'thread');
  return `eval:${String(userId || 'anonymous')}:${sid}:${tid}`;
}

function extractAnchors(query = '') {
  const text = String(query || '');
  const matches = text.match(/\b(?:tel\s*aviv|jerusalem|haifa|beer\s*sheva|gdpr|privacy|housing|population|employment|education|mobility|rent|income|relationships?|nodes?|attributes?)\b/gi) || [];
  return Array.from(new Set(matches.map((item) => String(item || '').trim()).filter(Boolean)));
}

function extractEntityAnchors(query = '') {
  const text = String(query || '');
  const entityMatches = text.match(/\b(?:e|statistical)_[a-z0-9_]+\b/gi) || [];
  const planMatches = text.match(/\b\d{2,4}-\d{6,8}\b/g) || [];
  const placeMatches = text.match(/\b(?:tel\s*aviv|jerusalem|haifa|beer\s*sheva)\b/gi) || [];
  return Array.from(new Set([...entityMatches, ...planMatches, ...placeMatches].map((item) => String(item || '').trim()).filter(Boolean)));
}

function hasExplicitTraversalIntent(query = '') {
  return /\b(graph|connected|path|paths|neighbors?|multi-hop|recursive|traverse|traversal|linked|anchor)\b/i.test(String(query || ''));
}

function buildRecursivePlan({ query = '', classification = '', anchors = [], entityAnchors = [] } = {}) {
  const explicitTraversal = hasExplicitTraversalIntent(query);
  if (explicitTraversal) {
    return {
      requested: true,
      mode: 'required',
      reason: 'explicit traversal language requires the recursive graph branch',
    };
  }

  if (entityAnchors.length > 1) {
    return {
      requested: true,
      mode: 'deferred',
      reason: 'multiple concrete entity anchors may benefit from recursive graph expansion if faster branches are insufficient',
    };
  }

  if (classification === 'sql' && anchors.length > 1) {
    return {
      requested: true,
      mode: 'deferred',
      reason: 'multi-anchor structured query can fall back to recursive graph expansion when direct SQL evidence is thin',
    };
  }

  return {
    requested: false,
    mode: 'off',
    reason: 'no explicit traversal or multi-entity graph signal',
  };
}

function dedupeBy(items = [], keyBuilder) {
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    const key = String(keyBuilder(item) || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function normalizeSqlOptions(sqlOptions = {}, evalMode = false) {
  return {
    ...sqlOptions,
    useGraph: true,
    multiAnchorEnabled: true,
    proxyIndexLayerEnabled: true,
    semanticSimilarityInferenceEnabled: true,
    evalMode,
    disableMemory: evalMode,
    disableWrites: evalMode,
    sqlIngestLayerEnabled: sqlOptions?.sqlIngestLayerEnabled != null
      ? Boolean(sqlOptions.sqlIngestLayerEnabled)
      : !evalMode,
  };
}

function buildRequestProfile({ query, userId = null, sessionId = null, threadId = null, evalMode = false, sqlOptions = {} } = {}) {
  return {
    query: String(query || ''),
    userId,
    sessionId,
    threadId,
    evalMode: Boolean(evalMode),
    sqlOptions: normalizeSqlOptions(sqlOptions, Boolean(evalMode)),
  };
}

function buildLangGraphSqlBranchOptions(sqlOptions = {}, { recursiveEnabled = false } = {}) {
  return {
    ...sqlOptions,
    useGraph: recursiveEnabled,
    recursiveEnabled,
    sqlRewriterEnabled: recursiveEnabled,
    // Keep SQL branch deterministic but allow semantic/proxy hints for robust city/entity resolution.
    multiAnchorEnabled: true,
    proxyIndexLayerEnabled: true,
    semanticSimilarityInferenceEnabled: true,
    semanticContextEnabled: false,
    sqlIngestLayerEnabled: false,
    answerGenerationEnabled: false,
  };
}

function buildLangGraphVectorBranchOptions(sqlOptions = {}) {
  return {
    ...sqlOptions,
    useGraph: false,
    recursiveEnabled: false,
    sqlRewriterEnabled: false,
    multiAnchorEnabled: false,
    proxyIndexLayerEnabled: false,
    semanticSimilarityInferenceEnabled: false,
    answerGenerationEnabled: false,
  };
}

function branchHasEvidence(branchResult) {
  return Boolean(
    Array.isArray(branchResult?.rows) && branchResult.rows.length > 0
      || Array.isArray(branchResult?.docs) && branchResult.docs.length > 0
  );
}

function buildBranchBudgets(branchNames = [], totalBudgetMs = LANGGRAPH_TOTAL_BUDGET_MS) {
  const names = Array.isArray(branchNames) ? branchNames.filter(Boolean) : [];
  if (names.length === 0) return {};
  if (names.length === 1) return { [names[0]]: totalBudgetMs };
  if (names.length === 2) {
    const stagedBudget = Math.max(20000, Math.round(totalBudgetMs * 0.95));
    return {
      [names[0]]: stagedBudget,
      [names[1]]: stagedBudget,
    };
  }

  const budgets = {};
  const primaryBudget = Math.max(5000, Math.round(totalBudgetMs * 0.6));
  const remainingBudget = Math.max(0, totalBudgetMs - primaryBudget);
  const supplementalNames = names.slice(1);
  const supplementalBudget = supplementalNames.length > 0
    ? Math.max(4000, Math.floor(remainingBudget / supplementalNames.length))
    : 0;

  budgets[names[0]] = primaryBudget;
  for (const name of supplementalNames) {
    budgets[name] = supplementalBudget;
  }
  return budgets;
}

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
  const answerTokens = tokenizeEvalText(answer);
  const truthTokens = tokenizeEvalText(groundTruth);
  const answerSet = new Set(answerTokens);
  const truthSet = new Set(truthTokens);
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

function extractCityLabelFromText(text = '') {
  const raw = String(text || '');
  if (!raw.trim()) return '';
  const match = raw.match(/\b(?:in|for|of)\s+([a-z0-9_'\-\s]+?)(?:\?|$)/i);
  const candidate = String(match?.[1] || '').trim();
  const normalized = candidate.toLowerCase().replace(/[_'\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const canonical = new Map([
    ['beer sheva', 'Beer-Sheva'],
    ['be er sheva', "Be'er Sheva"],
    ['beersheva', 'Beer-Sheva'],
    ['tel aviv', 'Tel Aviv'],
    ['tel aviv yafo', 'Tel Aviv-Yafo'],
    ['yafo', 'Yafo'],
    ['jerusalem', 'Jerusalem'],
    ['haifa', 'Haifa'],
  ]);
  if (canonical.has(normalized)) return canonical.get(normalized);
  if (!candidate) return '';
  return candidate
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function extractPopulationValueFromRow(row = null) {
  if (!row || typeof row !== 'object') return null;
  if (row.population_value != null && Number.isFinite(Number(row.population_value))) {
    return Number(row.population_value);
  }

  const attrKey = String(row.attribute_key || '').toLowerCase().trim();
  if (/^population(?:_approx|_num|_total)?$/.test(attrKey) && row.attribute_value != null) {
    const numeric = Number(String(row.attribute_value).replace(/[^0-9.]+/g, ''));
    if (Number.isFinite(numeric)) return numeric;
  }

  for (const [key, value] of Object.entries(row)) {
    if (!/^population(?:_value|_approx|_num|_total)?$/i.test(String(key))) continue;
    const numeric = Number(String(value).replace(/[^0-9.]+/g, ''));
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function isSimpleCityPopulationQuery(query = '') {
  const raw = String(query || '').trim();
  if (!/\b(population|residents|inhabitants)\b/i.test(raw)) return false;
  if (/\b(relationship|related|between|compare|comparison|explain|impact|housing|employment|education|mobility|rent|income|trend|vs|versus|similar|similarity)\b/i.test(raw)) {
    return false;
  }
  return /\b(tel\s*aviv|tel-?aviv|yafo|jerusalem|haifa|beer\s*sheva|beersheva|be\s*er\s*sheva)\b/i.test(raw);
}

function shouldForceStructuredSqlQuery(query = '') {
  return isSimpleCityPopulationQuery(query) || isDirectStructuredLookupQuery(query);
}

function normalizeHintToken(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function extractAttributeHintsFromQuery(query = '') {
  const raw = String(query || '');
  const exactTokens = raw.match(/\b[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]+\b/g) || [];
  const normalized = exactTokens
    .map((token) => normalizeHintToken(token))
    .filter((token) => token && !/^(?:e|statistical)_[a-z0-9_]+$/i.test(token));
  const phraseHints = [
    ['religion', 'religion'],
    ['population', 'population_approx'],
    ['median age', 'age_median'],
    ['age median', 'age_median'],
    ['street', 'located_at_street'],
    ['district', 'is_in_district'],
    ['infrastructure', 'involves_infrastructure'],
    ['land use', 'affects_land_use'],
  ];
  for (const [phrase, hint] of phraseHints) {
    if (new RegExp(`\\b${phrase.replace(/\s+/g, '\\s+')}\\b`, 'i').test(raw)) {
      normalized.push(hint);
    }
  }
  return Array.from(new Set(normalized));
}

function shouldKeepGraphInsideLangGraph(query = '') {
  const raw = String(query || '');
  if (!raw.trim()) return false;
  if (hasExplicitTraversalIntent(raw)) return true;
  if (/\bwhich\s+parent\s+does\b/i.test(raw)) return true;
  return extractAttributeHintsFromQuery(raw).length > 0
    && /\b(parent|shared\s+parent|belongs\s+to|connected|linked|graph|traversal|path|relationship)\b/i.test(raw);
}

function summarizeMergedMechanism(query, mergedContext = {}, strategy = null, routeReason = '') {
  const rows = Array.isArray(mergedContext.rows) ? mergedContext.rows : [];
  const docs = Array.isArray(mergedContext.docs) ? mergedContext.docs : [];
  const sqlBranches = Array.isArray(mergedContext.sql) ? mergedContext.sql.map((entry) => String(entry?.branch || '').trim()).filter(Boolean) : [];
  const deterministicFallback = mergedContext?.deterministicFallback || {};
  const graphExpansion = mergedContext?.graphExpansion || {};
  const routeClassification = String(strategy?.classification || '').trim() || 'unknown';
  const proxyEntries = Object.values(mergedContext?.proxyIndex || {}).filter((entry) => entry && typeof entry === 'object');
  const proxyMatchedKeys = Array.from(new Set(
    proxyEntries.flatMap((entry) => Array.isArray(entry?.matchedKeys) ? entry.matchedKeys : [])
  )).slice(0, 6);
  const proxyCategories = Array.from(new Set(
    proxyEntries.flatMap((entry) => Array.isArray(entry?.categories) ? entry.categories : [])
  )).slice(0, 6);

  let route = routeClassification;
  let explanation = routeReason || `router selected ${routeClassification}`;

  if (graphExpansion?.used) {
    route = 'graph_expansion_chain';
    explanation = 'used LangGraph graph expansion to discover connected entities first and then retrieve follow-up structured evidence';
  } else if (deterministicFallback?.used && deterministicFallback?.type === 'population-city-fallback') {
    route = 'sql_population_fallback';
    explanation = 'used deterministic SQL city-population fallback after semantic retrieval lacked a city-grounded row';
  } else if (sqlBranches.includes('deterministic_population_fallback')) {
    route = 'sql_population_fallback';
    explanation = 'used deterministic SQL population fallback';
  } else if (sqlBranches.includes('deterministic_fallback_probe')) {
    route = 'sql_fallback_probe';
    explanation = 'used deterministic SQL fallback probe to recover structured evidence';
  } else if (rows.length > 0 && routeClassification === 'sql') {
    route = 'structured_sql';
    explanation = 'used structured SQL retrieval for a direct factual lookup';
  } else if (rows.length > 0 && routeClassification === 'hybrid') {
    route = 'hybrid_sql_semantic';
    explanation = 'used hybrid retrieval, combining structured SQL evidence with semantic context';
  } else if (docs.length > 0) {
    route = 'semantic_retrieval';
    explanation = 'used semantic retrieval over embedded documents';
  }

  let proxyBasis = '';
  if (proxyMatchedKeys.length > 0) {
    proxyBasis = `proxy keys: ${proxyMatchedKeys.join(', ')}`;
  } else if (proxyCategories.length > 0) {
    proxyBasis = `proxy categories considered: ${proxyCategories.join(', ')}`;
  }

  return {
    route,
    explanation,
    proxyBasis,
  };
}

function appendMechanismExplanation(answer = '', mechanism = null) {
  const text = String(answer || '').trim();
  if (!text) return text;
  const explanation = String(mechanism?.explanation || '').trim();
  const proxyBasis = String(mechanism?.proxyBasis || '').trim();
  if (!explanation && !proxyBasis) return text;
  if (/Mechanism:/i.test(text)) return text;
  const detail = [explanation, proxyBasis].filter(Boolean).join('; ');
  return `${text} Mechanism: ${detail}.`;
}

function buildDeterministicMergedAnswer(query, mergedContext = {}) {
  const rows = Array.isArray(mergedContext.rows) ? mergedContext.rows : [];
  const docs = Array.isArray(mergedContext.docs) ? mergedContext.docs : [];
  const isPopulationQuestion = /\bpopulation\b/i.test(String(query || ''));
  const preferredStructuredAnswer = String(mergedContext?.preferredStructuredAnswer || '').trim();
  const graphExpansionAnswer = String(mergedContext?.graphExpansion?.preferredAnswer || '').trim();

  if (preferredStructuredAnswer) {
    return preferredStructuredAnswer;
  }

  if (graphExpansionAnswer) {
    return graphExpansionAnswer;
  }

  if (isPopulationQuestion && rows.length > 0) {
    const pop = extractPopulationValueFromRow(rows[0]);
    if (Number.isFinite(pop)) {
      const city = extractCityLabelFromText(query) || 'the requested city';
      return `${city} population is ${pop}.`;
    }
  }

  const pathRow = rows.find((row) => Array.isArray(row?.path_nodes) && row.path_nodes.length > 0);
  if (pathRow) {
    const pathNodes = pathRow.path_nodes.join(' -> ');
    const relationshipTrail = Array.isArray(pathRow?.relationship_path) && pathRow.relationship_path.length > 0
      ? ` via ${pathRow.relationship_path.join(' -> ')}`
      : '';
    return `The path from ${pathRow.start_entity_id} to ${pathRow.target_entity_id} is ${pathNodes}${relationshipTrail}.`;
  }

  const adjacencyRow = rows.find((row) => row?.anchor_entity_id && row?.related_entity_id && row?.relationship_type);
  if (adjacencyRow) {
    const related = rows
      .map((row) => `${row.related_entity_id} via ${row.relationship_type}`)
      .filter(Boolean)
      .slice(0, 10)
      .join(', ');
    const suffix = rows.length > 10 ? ` (and ${rows.length - 10} more)` : '';
    return `${adjacencyRow.anchor_entity_id} is connected to ${related}${suffix}.`;
  }

  const topDoc = String(docs?.[0]?.id || docs?.[0]?.name || '').trim();
  const rowCount = rows.length;
  const docCount = docs.length;
  const rowSnippet = rows[0] ? ` First row: ${JSON.stringify(rows[0])}` : '';
  return `Merged retrieval produced ${rowCount} structured rows and ${docCount} semantic documents.${topDoc ? ` Top document: ${topDoc}.` : ''}${rowSnippet}`;
}

function buildGraphProbeQuery(query = '', entityAnchors = []) {
  const normalizedEntities = Array.from(new Set((entityAnchors || []).map((item) => String(item || '').trim()).filter(Boolean)));
  const parentMatch = String(query || '').match(/\bwhich\s+parent\s+does\s+(.+?)\s+belong\s+to\b/i);
  if (parentMatch?.[1]) {
    return `Which parent does ${String(parentMatch[1]).trim()} belong to?`;
  }
  if (/\bpath\s+(?:connects?|links?)\b/i.test(String(query || '')) && normalizedEntities.length >= 2) {
    return `What path connects ${normalizedEntities[0]} and ${normalizedEntities[1]}?`;
  }
  if (/\b(?:connected|linked|relationship|relationships|graph|traversal|neighbors?|nodes?)\b/i.test(String(query || '')) && normalizedEntities.length >= 1) {
    return `What entities are connected to ${normalizedEntities[0]} and what relationship types link them through the graph?`;
  }
  const city = extractCityLabelFromText(query);
  if (city && /\b(?:connected|linked|relationship|relationships|graph|traversal|neighbors?|nodes?)\b/i.test(String(query || ''))) {
    return `What entities are connected to ${city} and what relationship types link them through the graph?`;
  }
  return '';
}

function extractGraphDiscoveredEntities(rows = [], { entityAnchors = [] } = {}) {
  const originalAnchors = new Set((entityAnchors || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
  const discovered = [];
  for (const row of rows || []) {
    const directIds = [
      row?.anchor_entity_id,
      row?.related_entity_id,
      row?.start_entity_id,
      row?.target_entity_id,
      row?.child_id,
      row?.parent_id,
    ];
    for (const candidate of directIds) {
      const normalized = String(candidate || '').trim().toLowerCase();
      if (/^(?:e|statistical)_[a-z0-9_]+$/i.test(normalized) && !originalAnchors.has(normalized)) {
        discovered.push(normalized);
      }
    }
    if (Array.isArray(row?.path_nodes)) {
      for (const candidate of row.path_nodes) {
        const normalized = String(candidate || '').trim().toLowerCase();
        if (/^(?:e|statistical)_[a-z0-9_]+$/i.test(normalized) && !originalAnchors.has(normalized)) {
          discovered.push(normalized);
        }
      }
    }
  }
  return Array.from(new Set(discovered));
}

function chooseGraphFollowUpEntities(query = '', discoveredEntities = []) {
  const entities = Array.from(new Set((discoveredEntities || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)));
  if (entities.length === 0) return [];
  if (/\b(shared\s+parent|that\s+parent|parent'?s|parent\b|belongs\s+to)\b/i.test(String(query || ''))) {
    const preferredParents = entities.filter((value) => /^e_[a-z0-9_]+$/i.test(value));
    if (preferredParents.length > 0) {
      return [...preferredParents, ...entities.filter((value) => !preferredParents.includes(value))];
    }
  }
  return entities;
}

function buildGraphFollowUpPlans(query = '', followUpEntities = [], attributeHints = []) {
  const entities = Array.from(new Set((followUpEntities || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)));
  const hints = Array.from(new Set((attributeHints || []).map((value) => normalizeHintToken(value)).filter(Boolean)));
  if (entities.length === 0 || hints.length === 0) return [];

  const queryText = String(query || '');
  const parentFocused = /\b(shared\s+parent|that\s+parent|parent'?s|parent\b|belongs\s+to)\b/i.test(queryText);
  const graphHeavy = /\b(entities?|relationship|relationships|connected|linked|graph|traversal|path|infrastructure|land\s+use|street|district|applies\s+to)\b/i.test(queryText);
  const maxEntities = parentFocused ? 4 : graphHeavy ? 6 : 3;
  const selectedEntities = entities.slice(0, maxEntities);
  const maxPlans = graphHeavy ? 12 : 8;
  const plans = [];

  for (const entityId of selectedEntities) {
    for (const attributeHint of hints) {
      plans.push({
        entityId,
        attributeHint,
        userQuery: `What is the ${attributeHint} for ${entityId}?`,
      });
      if (plans.length >= maxPlans) {
        return plans;
      }
    }
  }

  return plans;
}

function buildGraphRowsSummary(rows = []) {
  const pathRow = (rows || []).find((row) => Array.isArray(row?.path_nodes) && row.path_nodes.length > 0);
  if (pathRow) {
    const pathNodes = pathRow.path_nodes.join(' -> ');
    const relationshipTrail = Array.isArray(pathRow?.relationship_path) && pathRow.relationship_path.length > 0
      ? ` via ${pathRow.relationship_path.join(' -> ')}`
      : '';
    return `The path from ${pathRow.start_entity_id} to ${pathRow.target_entity_id} is ${pathNodes}${relationshipTrail}.`;
  }

  const adjacencyRow = (rows || []).find((row) => row?.anchor_entity_id && row?.related_entity_id && row?.relationship_type);
  if (adjacencyRow) {
    const related = rows
      .map((row) => `${row.related_entity_id} via ${row.relationship_type}`)
      .filter(Boolean)
      .slice(0, 10)
      .join(', ');
    const suffix = rows.length > 10 ? ` (and ${rows.length - 10} more)` : '';
    return `${adjacencyRow.anchor_entity_id} is connected to ${related}${suffix}.`;
  }

  return '';
}

function buildGraphExpansionAnswer({ query = '', graphRows = [], followUpRows = [] } = {}) {
  const parentAttributeRow = (graphRows || []).find((row) => row?.child_id && row?.parent_id && row?.parent_attribute_key && row?.parent_attribute_value != null);
  if (parentAttributeRow) {
    return `${parentAttributeRow.child_id} belongs to ${parentAttributeRow.parent_id}, and ${parentAttributeRow.parent_id} has ${parentAttributeRow.parent_attribute_key} ${parentAttributeRow.parent_attribute_value}.`;
  }

  const parentRow = (graphRows || []).find((row) => row?.child_id && row?.parent_id && row?.relationship_type);
  if (parentRow && (!Array.isArray(followUpRows) || followUpRows.length === 0)) {
    return `${parentRow.child_id} belongs to ${parentRow.parent_id}.`;
  }

  const graphSummary = buildGraphRowsSummary(graphRows);
  if (!Array.isArray(followUpRows) || followUpRows.length === 0) {
    return graphSummary;
  }

  const fragments = [];
  for (const row of followUpRows) {
    const entityId = String(row?.entity_id || '').trim();
    const attributeKey = String(row?.attribute_key || '').trim();
    const attributeValue = String(row?.attribute_value || '').trim();
    if (!entityId || !attributeKey || !attributeValue) continue;
    fragments.push(`${entityId} has ${attributeKey} ${attributeValue}`);
  }

  if (fragments.length === 0) {
    return graphSummary;
  }

  const summary = fragments.slice(0, 6).join('; ');
  if (parentRow) {
    return `${parentRow.child_id} belongs to ${parentRow.parent_id}, and ${summary}.`;
  }
  if (/\bwhich\s+parent\s+does\b/i.test(String(query || '')) && graphSummary) {
    return `${graphSummary.replace(/\.$/, '')}, and ${summary}.`;
  }
  if (graphSummary) {
    return `${graphSummary} Graph-derived follow-up: ${summary}.`;
  }
  return summary.endsWith('.') ? summary : `${summary}.`;
}

async function runGraphExpansionChain({ query = '', userId = null, evalMode = false, sqlOptions = {}, entityAnchors = [] } = {}) {
  const graphProbeQuery = buildGraphProbeQuery(query, entityAnchors);
  const attributeHints = extractAttributeHintsFromQuery(query).slice(0, 3);
  if (!graphProbeQuery) {
    return { attempted: false, used: false, reason: 'no-graph-probe-query' };
  }

  const graphResult = await runSQLRAG({
    userQuery: graphProbeQuery,
    systemPrompt: 'Return graph traversal evidence only.',
    userId,
    sqlOptions: {
      ...sqlOptions,
      evalMode,
      disableMemory: evalMode,
      disableWrites: evalMode,
      answerGenerationEnabled: false,
      recursiveEnabled: true,
      sqlRewriterEnabled: true,
      multiAnchorEnabled: true,
      proxyIndexLayerEnabled: true,
      semanticSimilarityInferenceEnabled: true,
      semanticContextEnabled: false,
      sqlIngestLayerEnabled: false,
    },
  });

  const graphRows = Array.isArray(graphResult?.rows) ? graphResult.rows : [];
  if (graphRows.length === 0) {
    return {
      attempted: true,
      used: false,
      reason: 'graph-probe-returned-empty',
      graphProbeQuery,
      graphRows: [],
      followUpRows: [],
      sql: typeof graphResult?.sql === 'string' ? graphResult.sql : '',
    };
  }

  const discoveredEntities = extractGraphDiscoveredEntities(graphRows, { entityAnchors });
  const followUpEntities = chooseGraphFollowUpEntities(query, discoveredEntities);
  const followUpPlans = buildGraphFollowUpPlans(query, followUpEntities, attributeHints);
  const followUpRows = [];
  const followUpSql = [];

  for (const plan of followUpPlans) {
      const followUp = await runSQLRAG({
        userQuery: plan.userQuery,
        systemPrompt: 'Return direct attribute evidence only.',
        userId,
        sqlOptions: {
          ...sqlOptions,
          evalMode,
          disableMemory: evalMode,
          disableWrites: evalMode,
          answerGenerationEnabled: false,
          recursiveEnabled: false,
          sqlRewriterEnabled: true,
          multiAnchorEnabled: true,
          proxyIndexLayerEnabled: true,
          semanticSimilarityInferenceEnabled: true,
          semanticContextEnabled: false,
          sqlIngestLayerEnabled: false,
        },
      });
      if (Array.isArray(followUp?.rows) && followUp.rows.length > 0) {
        followUpRows.push(...followUp.rows);
      }
      if (typeof followUp?.sql === 'string' && followUp.sql.trim()) {
        followUpSql.push({ entityId: plan.entityId, attributeHint: plan.attributeHint, sql: followUp.sql });
      }
  }

  return {
    attempted: true,
    used: true,
    graphProbeQuery,
    graphRows,
    followUpRows: dedupeBy(followUpRows, (item) => JSON.stringify(item)).slice(0, 20),
    discoveredEntities,
    followedEntities: followUpEntities.slice(0, 12),
    followUpPlans,
    attributeHints,
    sql: [
      ...(typeof graphResult?.sql === 'string' && graphResult.sql.trim() ? [{ branch: 'graph_probe', sql: graphResult.sql }] : []),
      ...followUpSql.map((item) => ({ branch: `graph_follow_up:${item.entityId}:${item.attributeHint}`, sql: item.sql })),
    ],
    preferredAnswer: buildGraphExpansionAnswer({ query, graphRows, followUpRows }),
  };
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

function buildGroundedPathwayReport({ pathway, answer = '', contexts = [], llmMetrics = {}, latencyMs = 0, groundTruthEntry = null } = {}) {
  const groundTruthAnswer = String(groundTruthEntry?.ground_truth_answer || '');
  const referenceContexts = Array.isArray(groundTruthEntry?.ground_truth_context) ? groundTruthEntry.ground_truth_context.map((item) => String(item || '')) : [];
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

function chooseAccuracyWinner(baselineReport, langgraphReport) {
  const fields = [
    ['exactMatch', 0],
    ['tokenRecall', 0.0001],
    ['jaccard', 0.0001],
    ['contextRecall', 0.0001],
  ];
  for (const [field, epsilon] of fields) {
    const baselineValue = field === 'contextRecall' ? Number(baselineReport?.context?.recall ?? -1) : Number(baselineReport?.answer?.[field] ?? -1);
    const langgraphValue = field === 'contextRecall' ? Number(langgraphReport?.context?.recall ?? -1) : Number(langgraphReport?.answer?.[field] ?? -1);
    if (Math.abs(baselineValue - langgraphValue) <= epsilon) continue;
    return baselineValue > langgraphValue ? 'baseline' : 'langgraph';
  }
  return 'tie';
}

function chooseEfficiencyWinner(baselineReport, langgraphReport) {
  const comparisons = [
    ['latencyMs', 1],
    ['llmCalls', 0],
    ['totalTokens', 1],
    ['estimatedCostUsd', 0.000001],
  ];
  for (const [field, epsilon] of comparisons) {
    const baselineValue = Number(baselineReport?.efficiency?.[field] ?? Number.MAX_SAFE_INTEGER);
    const langgraphValue = Number(langgraphReport?.efficiency?.[field] ?? Number.MAX_SAFE_INTEGER);
    if (Math.abs(baselineValue - langgraphValue) <= epsilon) continue;
    return baselineValue < langgraphValue ? 'baseline' : 'langgraph';
  }
  return 'tie';
}

function buildCompareConclusion({ baselineReport, langgraphReport, groundTruthEntry = null } = {}) {
  const accuracyWinner = groundTruthEntry ? chooseAccuracyWinner(baselineReport, langgraphReport) : 'unavailable';
  const efficiencyWinner = chooseEfficiencyWinner(baselineReport, langgraphReport);
  let overallWinner = 'tie';
  if (accuracyWinner === efficiencyWinner && accuracyWinner !== 'tie' && accuracyWinner !== 'unavailable') {
    overallWinner = accuracyWinner;
  } else if (accuracyWinner !== 'tie' && accuracyWinner !== 'unavailable' && efficiencyWinner === 'tie') {
    overallWinner = accuracyWinner;
  } else if ((accuracyWinner === 'tie' || accuracyWinner === 'unavailable') && efficiencyWinner !== 'tie') {
    overallWinner = efficiencyWinner;
  }

  let summary = `Efficiency winner: ${efficiencyWinner}.`;
  if (accuracyWinner === 'unavailable') {
    summary = `No grounded dataset match was found for this query, so accuracy is unavailable. ${summary}`;
  } else {
    summary = `Accuracy winner: ${accuracyWinner}. ${summary}`;
  }
  if (overallWinner !== 'tie') {
    summary += ` Overall winner: ${overallWinner}.`;
  } else {
    summary += ' Overall winner: tie or trade-off.';
  }

  return { accuracyWinner, efficiencyWinner, overallWinner, summary };
}

async function resetEvalArtifacts({ isolatedUserId, sessionId }) {
  const bufferReset = resetConversationState({ userId: isolatedUserId });
  const storageCleanup = await cleanupEvaluationArtifacts({
    userIds: [isolatedUserId],
    markers: [isolatedUserId, sessionId],
  });
  return {
    bufferReset,
    storageCleanup,
  };
}

function buildAutomaticRagasReport({ query, baseline, langgraph } = {}) {
  const groundTruthEntry = findGroundTruthEntry(query);
  const baselineContexts = baseline?.result?.mergedContext
    ? collectContextStrings(baseline.result.mergedContext)
    : collectContextStrings({ rows: baseline?.result?.rows || [], docs: baseline?.result?.docs || [] });
  const langgraphContexts = collectContextStrings(langgraph?.mergedContext || {});
  const baselineReport = buildGroundedPathwayReport({
    pathway: 'baseline',
    answer: baseline?.result?.answer || '',
    contexts: baselineContexts,
    llmMetrics: baseline?.llmMetrics,
    latencyMs: baseline?.metrics?.totalLatencyMs,
    groundTruthEntry,
  });
  const langgraphReport = buildGroundedPathwayReport({
    pathway: 'langgraph',
    answer: langgraph?.answer || '',
    contexts: langgraphContexts,
    llmMetrics: langgraph?.llmMetrics,
    latencyMs: langgraph?.metrics?.totalLatencyMs,
    groundTruthEntry,
  });

  return {
    engine: 'grounded-local-ragas-lite',
    liveRequest: true,
    datasetEntry: groundTruthEntry
      ? {
          id: groundTruthEntry.id || null,
          category: groundTruthEntry.category || null,
          groundTruthAnswer: groundTruthEntry.ground_truth_answer || '',
          groundTruthContext: groundTruthEntry.ground_truth_context || [],
        }
      : null,
    baseline: baselineReport,
    langgraph: langgraphReport,
    conclusion: buildCompareConclusion({ baselineReport, langgraphReport, groundTruthEntry }),
    note: groundTruthEntry
      ? 'Grounded live-report using the local evaluation dataset and RAGAS-style overlap metrics.'
      : 'No grounded dataset item matched this query, so only efficiency metrics are authoritative for this live report.',
  };
}

async function timedBranch(name, fn) {
  const started = nowMs();
  try {
    const result = await fn();
    return {
      name,
      ok: true,
      elapsedMs: Math.max(0, nowMs() - started),
      result,
    };
  } catch (err) {
    return {
      name,
      ok: false,
      elapsedMs: Math.max(0, nowMs() - started),
      error: String(err?.message || err),
    };
  }
}

function buildAnswerPrompt(query, mergedContext = {}) {
  return [
    `Query: ${query}`,
    `Strategy: ${JSON.stringify(mergedContext.strategy || {})}`,
    `Rows: ${JSON.stringify((mergedContext.rows || []).slice(0, 8))}`,
    `Docs: ${JSON.stringify((mergedContext.docs || []).slice(0, 8))}`,
    `SQL traces: ${JSON.stringify((mergedContext.sql || []).slice(0, 4))}`,
    `Proxy index: ${JSON.stringify(mergedContext.proxyIndex || {})}`,
    `Recursion: ${JSON.stringify(mergedContext.recursion || {})}`,
  ].join('\n\n');
}

async function composeMergedAnswer(query, mergedContext = {}, { answerGenerationEnabled = true } = {}) {
  if (!answerGenerationEnabled) {
    return { answer: '', llmMetrics: emptyLlmMetrics() };
  }

  const fallback = buildDeterministicMergedAnswer(query, mergedContext);
  const mechanism = summarizeMergedMechanism(query, mergedContext, mergedContext?.strategy, mergedContext?.routeReason);

  if (!openai) {
    return { answer: appendMechanismExplanation(fallback, mechanism), llmMetrics: emptyLlmMetrics() };
  }

  try {
    const resp = await withTimeout(openai.chat.completions.create({
      model: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 400,
      messages: [
        {
          role: 'system',
          content: 'You are a retrieval answer synthesizer. Use only the provided context. If evidence is partial, say so clearly and avoid inventing facts.',
        },
        {
          role: 'user',
          content: buildAnswerPrompt(query, mergedContext),
        },
      ],
    }), LANGGRAPH_ANSWER_TIMEOUT_MS, 'langgraph answer synthesis');
    return {
      answer: appendMechanismExplanation(resp.choices?.[0]?.message?.content?.trim() || fallback, mechanism),
      llmMetrics: buildLlmMetrics([metricFromChatCompletionResponse(resp, { label: 'langgraph_answer' })]),
    };
  } catch (_err) {
    return { answer: appendMechanismExplanation(fallback, mechanism), llmMetrics: emptyLlmMetrics() };
  }
}

async function routerNode(state) {
  const started = nowMs();
  const query = String(state.query || '').trim();
  const classificationResult = await classifyQueryDetailed(query, { userId: state.evalMode ? null : state.userId });
  const directStructuredPopulationIntent = shouldForceStructuredSqlQuery(query) && !shouldKeepGraphInsideLangGraph(query);
  const comparativeStatisticalQuery = /\b(statistical\b|sub\s*area\b)/i.test(query)
    && /\b(population|socioeconomic|socio-economic|socio|social|economic|income|rent|education|employment|indicator|indicators)\b/i.test(query)
    && /\b(relationship|related|compare|comparison|nearby|neighbor|neighbour|terms\s+of|in\s+terms\s+of|linked|connected|similar|similarity)\b/i.test(query);
  const statisticalSimilarityQuery = /\b(statistical\b|sub\s*area\b)/i.test(query)
    && /\b(similar|similarity|most\s+similar|closest|nearest)\b/i.test(query)
    && /\b(attribute|attributes|feature|features|multi|multiple)\b/i.test(query);
  const classification = directStructuredPopulationIntent
    ? 'sql'
    : ((comparativeStatisticalQuery || statisticalSimilarityQuery) && classificationResult.kind !== 'hybrid'
      ? 'hybrid'
      : classificationResult.kind);
  const anchors = extractAnchors(query);
  const entityAnchors = extractEntityAnchors(query);
  const primaryBranch = classification === 'semantic' ? 'vector' : 'sql';
  const supplementalBranches = [];
  const recursivePlan = buildRecursivePlan({ query, classification, anchors, entityAnchors });

  if (classification === 'hybrid') {
    supplementalBranches.push(primaryBranch === 'sql' ? 'vector' : 'sql');
  }
  if (recursivePlan.requested) {
    supplementalBranches.push('recursive');
  }

  const branches = Array.from(new Set([primaryBranch, ...supplementalBranches]));
  const runInParallel = false;
  const executionMode = branches.length > 1 ? 'staged' : 'single';

  return {
    strategy: {
      classification,
      primaryBranch,
      supplementalBranches,
      branches,
      runInParallel,
      executionMode,
      anchors,
      entityAnchors,
      recursivePlan,
    },
    routeReason: directStructuredPopulationIntent
      ? 'router forced structured SQL because the query is an explicit direct factual or relation lookup'
      : (classification === 'hybrid'
        ? 'hybrid question needs a primary branch plus supplemental evidence from the other retrieval branch'
        : (branches.includes('recursive')
          ? recursivePlan.reason
          : `router selected a single ${classification} retrieval branch`)),
    llmMetrics: combineLlmMetrics(state.llmMetrics, classificationResult.llmMetrics),
    metrics: {
      ...(state.metrics || {}),
      routerMs: Math.max(0, nowMs() - started),
      llmCallsEstimated: Number(classificationResult?.llmMetrics?.summary?.callCount || 0),
    },
  };
}

async function retrievalNode(state) {
  const started = nowMs();
  const query = String(state.query || '').trim();
  const evalMode = Boolean(state.evalMode);
  const effectiveUserId = buildIsolatedUserId(state);
  const sqlOptions = normalizeSqlOptions(state.sqlOptions || {}, evalMode);
  const branchNames = Array.isArray(state.strategy?.branches) && state.strategy.branches.length > 0
    ? state.strategy.branches
    : ['vector'];
  const branchTimeoutMs = Math.max(1000, Number(state.sqlOptions?.branchTimeoutMs || LANGGRAPH_BRANCH_TIMEOUT_MS));
  const totalBudgetMs = Math.max(branchTimeoutMs, Number(state.sqlOptions?.totalBudgetMs || LANGGRAPH_TOTAL_BUDGET_MS));
  const recursivePlan = state.strategy?.recursivePlan || { requested: false, mode: 'off', reason: 'not requested' };
  const isSimilarityIntent = /\b(similar|similarity|closest|nearest|statistical\s+area|socioeconomic|socio-economic)\b/i
    .test(String(query || ''));

  const buildSqlBranchTask = (name, recursiveEnabled, stageBudgetMs = branchTimeoutMs) => timedBranch(name, () => withTimeout(runSQLRAG({
    userQuery: query,
    systemPrompt: recursiveEnabled
      ? 'Return recursive SQL retrieval evidence only.'
      : 'Return SQL retrieval evidence only.',
    userId: effectiveUserId,
    sqlOptions: {
      ...buildLangGraphSqlBranchOptions(sqlOptions, { recursiveEnabled }),
      executionTimeoutMs: Math.max(1000, Number(stageBudgetMs || branchTimeoutMs) - 500),
    },
  }), stageBudgetMs, `langgraph ${name} branch`));

  const buildVectorBranchTask = (stageBudgetMs = branchTimeoutMs) => timedBranch('vector', () => withTimeout(runSemanticRAG({
    query,
    topK: isSimilarityIntent
      ? Math.max(3, Math.min(5, Number(state.sqlOptions?.topK || LANGGRAPH_TOP_K)))
      : Math.max(3, Number(state.sqlOptions?.topK || LANGGRAPH_TOP_K)),
    useRerank: false,
    systemPrompt: 'Return semantic retrieval evidence only.',
    userId: effectiveUserId,
    sqlOptions: {
      ...buildLangGraphVectorBranchOptions(sqlOptions),
      includeRagasReport: false,
    },
  }), stageBudgetMs, 'langgraph vector branch'));

  const stageOrder = branchNames.filter((name) => name !== 'recursive');
  const branchBudgetsMs = buildBranchBudgets(stageOrder, totalBudgetMs);
  const settled = [];
  const branches = {};
  const errors = [];
  let llmMetrics = combineLlmMetrics(state.llmMetrics);

  for (const branchName of stageOrder) {
    const stageBudgetMs = Math.max(1000, Number(branchBudgetsMs[branchName] || branchTimeoutMs));
    const branchRunner = branchName === 'sql'
      ? () => buildSqlBranchTask('sql', false, stageBudgetMs)
      : () => buildVectorBranchTask(stageBudgetMs);
    const item = await branchRunner();
    settled.push(item);
    branches[item.name] = item;
    if (!item.ok) {
      errors.push({ branch: item.name, error: item.error });
    } else {
      llmMetrics = combineLlmMetrics(llmMetrics, item.result?.llmMetrics);
    }
  }

  const hasEvidence = settled.some((item) => item?.ok && (
    Array.isArray(item?.result?.rows) && item.result.rows.length > 0
      || Array.isArray(item?.result?.docs) && item.result.docs.length > 0
  ));
  const shouldRunRecursive = branchNames.includes('recursive')
    && (recursivePlan.mode === 'required' || !hasEvidence);

  if (branchNames.includes('recursive')) {
    if (shouldRunRecursive) {
      const recursiveBudgetMs = Math.max(1000, Math.min(branchTimeoutMs, Math.max(0, totalBudgetMs - Math.max(0, nowMs() - started))));
      const recursiveBranch = await buildSqlBranchTask('recursive', true, recursiveBudgetMs);
      branches.recursive = recursiveBranch;
      if (!recursiveBranch.ok) {
        errors.push({ branch: 'recursive', error: recursiveBranch.error });
      } else {
        llmMetrics = combineLlmMetrics(llmMetrics, recursiveBranch.result?.llmMetrics);
      }
    } else {
      branches.recursive = {
        name: 'recursive',
        ok: true,
        skipped: true,
        elapsedMs: 0,
        reason: 'deferred because primary branches already returned evidence',
        result: {
          rows: [],
          docs: [],
          sql: '',
          recursion: {
            enabled: false,
            skipped: true,
            reason: 'primary branches already returned evidence',
          },
        },
      };
    }
  }

  const shouldRunGraphExpansion = shouldKeepGraphInsideLangGraph(query);
  if (shouldRunGraphExpansion) {
    const graphExpansion = await timedBranch('graph_expand', () => runGraphExpansionChain({
      query,
      userId: effectiveUserId,
      evalMode,
      sqlOptions,
      entityAnchors: state.strategy?.entityAnchors || [],
    }));
    branches.graph_expand = graphExpansion;
    if (!graphExpansion.ok) {
      errors.push({ branch: 'graph_expand', error: graphExpansion.error });
    }
  }

  return {
    branches,
    errors,
    llmMetrics,
    metrics: {
      ...(state.metrics || {}),
      retrievalMs: Math.max(0, nowMs() - started),
      branchLatenciesMs: Object.fromEntries(Object.entries(branches).map(([name, branch]) => [name, Number(branch?.elapsedMs || 0)])),
      branchBudgetsMs,
      totalBudgetMs,
      llmCallsEstimated: Number(llmMetrics?.summary?.callCount || 0),
    },
  };
}

async function mergeNode(state) {
  const started = nowMs();
  const branchValues = Object.values(state.branches || {}).filter((entry) => entry?.ok && entry?.result);
  const preferredStructuredAnswer = state.strategy?.classification === 'sql'
    ? String(
      branchValues.find((entry) => entry.name === 'sql')?.result?.answer || ''
    ).replace(/\s+Mechanism:.*$/s, '').trim()
    : '';
  let docs = dedupeBy(
    branchValues.flatMap((entry) => Array.isArray(entry.result?.docs) ? entry.result.docs : []),
    (item) => item?.id || item?.name || item?.description,
  ).slice(0, 12);
  let rows = dedupeBy(
    branchValues.flatMap((entry) => Array.isArray(entry.result?.rows) ? entry.result.rows : []),
    (item) => JSON.stringify(item),
  ).slice(0, 12);
  const sql = branchValues
    .filter((entry) => typeof entry.result?.sql === 'string' && entry.result.sql.trim())
    .map((entry) => ({ branch: entry.name, sql: entry.result.sql }));
  const proxyIndex = Object.fromEntries(
    branchValues
      .filter((entry) => entry.result?.proxyIndex)
      .map((entry) => [entry.name, entry.result.proxyIndex]),
  );
  const recursion = Object.fromEntries(
    branchValues
      .filter((entry) => entry.result?.recursion)
      .map((entry) => [entry.name, entry.result.recursion]),
  );

  let deterministicFallback = { attempted: false, used: false };
  const graphExpansion = branchValues
    .map((entry) => entry.result?.graphExpansion || (entry.name === 'graph_expand' ? entry.result : null))
    .find((entry) => entry && typeof entry === 'object') || null;
  const semanticCityHints = Array.from(new Set(
    branchValues.flatMap((entry) => {
      const hints = entry?.result?.advancedLayers?.semanticSimilarityInference?.semanticEntityHints
        || entry?.result?.semanticEntityHints
        || {};
      const cityNames = Array.isArray(hints.cityNames) ? hints.cityNames : [];
      return cityNames.map((name) => String(name || '').trim()).filter(Boolean);
    })
  ));
  const populationIntent = /\bpopulation\b/i.test(String(state.query || ''));
  const explicitCityInQuery = Boolean(extractCityLabelFromText(state.query));
  const graphProbeQuery = buildGraphProbeQuery(state.query, state.strategy?.entityAnchors || []);
  const knownIntentWithoutEvidence = (
    rows.length === 0
    && docs.length === 0
    && /\b(program|building\s+program|plan|taba|similar|similarity|closest|nearest|statistical\s+area|socioeconomic|socio-economic|infrastructure|entities?|relationship|relationships|connected|linked|graph|traversal|path)\b/i.test(String(state.query || ''))
  );

  if (knownIntentWithoutEvidence) {
    deterministicFallback = { attempted: true, used: false };
    try {
      const probeQuery = graphProbeQuery
        || (/\b(similar|similarity|closest|nearest)\b/i.test(String(state.query || ''))
        ? 'List statistical areas related to Tel Aviv with population and socioeconomic indicators'
        : /\b(infrastructure|entities?|relationship|relationships|connected|linked|graph|traversal|path)\b/i.test(String(state.query || ''))
          ? 'What entities are connected to Tel Aviv, including infrastructure when available, and what relationship types link them through the graph?'
        : state.query);
      const probe = await runSQLRAG({
        userQuery: probeQuery,
        userId: state.userId,
        sqlOptions: {
          ...(state.sqlOptions || {}),
          evalMode: Boolean(state.evalMode),
          disableMemory: Boolean(state.evalMode),
          disableWrites: Boolean(state.evalMode),
          answerGenerationEnabled: false,
          recursiveEnabled: false,
          sqlRewriterEnabled: true,
          multiAnchorEnabled: true,
          proxyIndexLayerEnabled: true,
          semanticSimilarityInferenceEnabled: true,
          semanticContextEnabled: false,
        },
      });

      const probeRows = Array.isArray(probe?.rows) ? probe.rows : [];
      const probeDocs = Array.isArray(probe?.docs) ? probe.docs : [];
      if (probeRows.length > 0 || probeDocs.length > 0) {
        rows = dedupeBy([...rows, ...probeRows], (item) => JSON.stringify(item)).slice(0, 12);
        docs = dedupeBy([...docs, ...probeDocs], (item) => item?.id || item?.name || item?.description).slice(0, 12);
        if (typeof probe?.sql === 'string' && probe.sql.trim()) {
          sql.push({ branch: 'deterministic_fallback_probe', sql: probe.sql });
        }
        if (probe?.proxyIndex) {
          proxyIndex.deterministic_fallback_probe = probe.proxyIndex;
        }
        if (probe?.recursion) {
          recursion.deterministic_fallback_probe = probe.recursion;
        }
        deterministicFallback = { attempted: true, used: true, rowCount: probeRows.length, docCount: probeDocs.length };
      } else {
        deterministicFallback = { attempted: true, used: false, reason: 'probe-returned-empty' };
      }
    } catch (error) {
      deterministicFallback = {
        attempted: true,
        used: false,
        reason: 'probe-failed',
        error: String(error?.message || error),
      };
    }
  }

  if (populationIntent && rows.length === 0 && (explicitCityInQuery || semanticCityHints.length > 0)) {
    deterministicFallback = { attempted: true, used: false, reason: 'population-city-fallback' };
    try {
      const populationProbe = await runSQLRAG({
        userQuery: String(state.query || ''),
        userId: state.userId,
        sqlOptions: {
          ...(state.sqlOptions || {}),
          evalMode: Boolean(state.evalMode),
          disableMemory: Boolean(state.evalMode),
          disableWrites: Boolean(state.evalMode),
          answerGenerationEnabled: false,
          recursiveEnabled: false,
          sqlRewriterEnabled: true,
          multiAnchorEnabled: true,
          proxyIndexLayerEnabled: true,
          semanticSimilarityInferenceEnabled: true,
          semanticContextEnabled: false,
        },
      });

      const populationRows = Array.isArray(populationProbe?.rows) ? populationProbe.rows : [];
      if (populationRows.length > 0) {
        rows = dedupeBy([...populationRows, ...rows], (item) => JSON.stringify(item)).slice(0, 12);
        if (typeof populationProbe?.sql === 'string' && populationProbe.sql.trim()) {
          sql.unshift({ branch: 'deterministic_population_fallback', sql: populationProbe.sql });
        }
        deterministicFallback = {
          attempted: true,
          used: true,
          type: 'population-city-fallback',
          rowCount: populationRows.length,
        };
      } else {
        deterministicFallback = { attempted: true, used: false, reason: 'population-city-fallback-empty' };
      }
    } catch (error) {
      deterministicFallback = {
        attempted: true,
        used: false,
        reason: 'population-city-fallback-failed',
        error: String(error?.message || error),
      };
    }
  }

  const preferredAnswerFromGraphExpansion = String(graphExpansion?.preferredAnswer || '').trim();
  if (graphExpansion?.used) {
    const expansionRows = [
      ...(Array.isArray(graphExpansion?.graphRows) ? graphExpansion.graphRows : []),
      ...(Array.isArray(graphExpansion?.followUpRows) ? graphExpansion.followUpRows : []),
    ];
    rows = dedupeBy([...expansionRows, ...rows], (item) => JSON.stringify(item)).slice(0, 20);
    const expansionSql = Array.isArray(graphExpansion?.sql) ? graphExpansion.sql : [];
    sql.push(...expansionSql);
  }

  return {
    mergedContext: {
      strategy: state.strategy,
      routeReason: state.routeReason,
      docs,
      rows,
      sql,
      proxyIndex,
      recursion,
      preferredStructuredAnswer: preferredAnswerFromGraphExpansion || preferredStructuredAnswer,
      graphExpansion,
      deterministicFallback,
      errors: state.errors || [],
    },
    metrics: {
      ...(state.metrics || {}),
      mergeMs: Math.max(0, nowMs() - started),
      mergedDocCount: docs.length,
      mergedRowCount: rows.length,
    },
  };
}

async function answerNode(state) {
  const started = nowMs();
  const answerGenerationEnabled = state.sqlOptions?.answerGenerationEnabled != null
    ? Boolean(state.sqlOptions.answerGenerationEnabled)
    : true;
  const composed = await composeMergedAnswer(state.query, state.mergedContext || {}, { answerGenerationEnabled });
  const llmMetrics = combineLlmMetrics(state.llmMetrics, composed.llmMetrics);

  return {
    answer: composed.answer,
    llmMetrics,
    metrics: {
      ...(state.metrics || {}),
      answerMs: Math.max(0, nowMs() - started),
      llmCallsEstimated: Number(llmMetrics?.summary?.callCount || 0),
    },
  };
}

const retrievalGraph = new StateGraph(RetrievalState)
  .addNode('router', routerNode)
  .addNode('retrieve', retrievalNode)
  .addNode('merge', mergeNode)
  .addNode('finalize_answer', answerNode)
  .addEdge(START, 'router')
  .addEdge('router', 'retrieve')
  .addEdge('retrieve', 'merge')
  .addEdge('merge', 'finalize_answer')
  .addEdge('finalize_answer', END)
  .compile();

export async function runLangGraphRetrieval({
  query,
  userQuery = '',
  userId = null,
  sessionId = null,
  threadId = null,
  evalMode = false,
  sqlOptions = {},
} = {}) {
  const started = nowMs();
  const normalizedQuery = String(query || userQuery || '').trim();
  const effectiveSessionId = String(sessionId || randomUUID());
  const effectiveThreadId = String(threadId || 'retrieval');
  const effectiveSqlOptions = normalizeSqlOptions(sqlOptions, evalMode);
  const isolatedUserId = buildIsolatedUserId({ userId, sessionId: effectiveSessionId, threadId: effectiveThreadId, evalMode });
  let cleanupBefore = null;
  let cleanupAfter = null;
  let result;

  if (evalMode) {
    cleanupBefore = await resetEvalArtifacts({ isolatedUserId, sessionId: effectiveSessionId });
  }

  try {
    if (shouldForceStructuredSqlQuery(normalizedQuery) && !shouldKeepGraphInsideLangGraph(normalizedQuery)) {
      const sqlResult = await runSQLRAG({
        userQuery: normalizedQuery,
        systemPrompt: '',
        userId: isolatedUserId,
        sqlOptions: {
          ...effectiveSqlOptions,
          answerGenerationEnabled: true,
        },
      });

      return {
        requestProfile: buildRequestProfile({
          query: normalizedQuery,
          userId,
          sessionId: effectiveSessionId,
          threadId: effectiveThreadId,
          evalMode,
          sqlOptions: effectiveSqlOptions,
        }),
        route: {
          classification: 'sql',
          primaryBranch: 'sql',
          supplementalBranches: [],
          branches: ['sql'],
          runInParallel: false,
          executionMode: 'single',
          anchors: extractAnchors(normalizedQuery),
          entityAnchors: extractEntityAnchors(normalizedQuery),
          recursivePlan: { requested: false, mode: 'off', reason: 'not requested' },
        },
        routeReason: 'router forced structured SQL because the query is an explicit direct factual or relation lookup',
        mechanism: sqlResult.mechanism || {
          route: 'direct_structured_lookup',
          explanation: 'used deterministic structured SQL lookup for a direct factual request',
          proxyBasis: '',
        },
        branches: {
          sql: {
            name: 'sql',
            ok: true,
            elapsedMs: Math.max(0, nowMs() - started),
            result: sqlResult,
          },
        },
        mergedContext: {
          strategy: {
            classification: 'sql',
            primaryBranch: 'sql',
            supplementalBranches: [],
            branches: ['sql'],
            runInParallel: false,
            executionMode: 'single',
          },
          routeReason: 'router forced structured SQL because the query is an explicit direct factual or relation lookup',
          rows: sqlResult.rows || [],
          docs: sqlResult.docs || [],
          sql: sqlResult.sql ? [{ branch: 'sql', sql: sqlResult.sql }] : [],
          proxyIndex: { sql: sqlResult.proxyIndex || {} },
          recursion: { sql: sqlResult.recursion || {} },
          preferredStructuredAnswer: String(sqlResult.answer || '').replace(/\s+Mechanism:.*$/s, '').trim(),
          deterministicFallback: { attempted: false, used: false },
          errors: sqlResult.errors || [],
        },
        answer: sqlResult.answer || '',
        llmMetrics: sqlResult.llmMetrics || emptyLlmMetrics(),
        metrics: {
          totalLatencyMs: Math.max(0, nowMs() - started),
          sessionId: effectiveSessionId,
          threadId: effectiveThreadId,
          userId: isolatedUserId,
        },
        evalIsolation: evalMode ? {
          enabled: true,
          isolatedUserId,
          cleanupBefore,
          cleanupAfter: null,
        } : { enabled: false },
        errors: sqlResult.errors || [],
      };
    }

    result = await retrievalGraph.invoke({
      query,
      query: normalizedQuery,
      userId: isolatedUserId,
      sessionId: effectiveSessionId,
      threadId: effectiveThreadId,
      evalMode,
      sqlOptions: effectiveSqlOptions,
      metrics: {},
      llmMetrics: emptyLlmMetrics(),
      errors: [],
    });
  } finally {
    if (evalMode) {
      cleanupAfter = await resetEvalArtifacts({ isolatedUserId, sessionId: effectiveSessionId });
    }
  }

  return {
    requestProfile: buildRequestProfile({
      query: normalizedQuery,
      userId,
      sessionId: effectiveSessionId,
      threadId: effectiveThreadId,
      evalMode,
      sqlOptions: effectiveSqlOptions,
    }),
    route: result.strategy,
    routeReason: result.routeReason,
    mechanism: summarizeMergedMechanism(normalizedQuery, {
      ...(result.mergedContext || {}),
      strategy: result.strategy,
      routeReason: result.routeReason,
    }, result.strategy, result.routeReason),
    branches: result.branches || {},
    mergedContext: result.mergedContext || {},
    answer: result.answer || '',
    llmMetrics: result.llmMetrics || emptyLlmMetrics(),
    metrics: {
      ...(result.metrics || {}),
      totalLatencyMs: Math.max(0, nowMs() - started),
      sessionId: effectiveSessionId,
      threadId: effectiveThreadId,
      userId: isolatedUserId,
    },
    evalIsolation: evalMode ? {
      enabled: true,
      isolatedUserId,
      cleanupBefore,
      cleanupAfter,
    } : { enabled: false },
    errors: result.errors || [],
  };
}

export async function runBaselineRetrievalPath({
  query,
  userId = null,
  sessionId = null,
  threadId = null,
  evalMode = true,
  sqlOptions = {},
} = {}) {
  const started = nowMs();
  const effectiveSessionId = String(sessionId || randomUUID());
  const effectiveThreadId = String(threadId || 'baseline');
  const isolatedUserId = buildIsolatedUserId({ userId, sessionId: effectiveSessionId, threadId: effectiveThreadId, evalMode });
  const classificationResult = await classifyQueryDetailed(query, { userId: null });
  const classification = classificationResult.kind;
  const effectiveSqlOptions = normalizeSqlOptions(sqlOptions, evalMode);
  const branchTimeoutMs = Math.max(1000, Number(effectiveSqlOptions?.branchTimeoutMs || LANGGRAPH_BRANCH_TIMEOUT_MS));
  let llmMetrics = combineLlmMetrics(classificationResult.llmMetrics);
  let cleanupBefore = null;
  let cleanupAfter = null;

  if (evalMode) {
    cleanupBefore = await resetEvalArtifacts({ isolatedUserId, sessionId: effectiveSessionId });
  }

  let result;
  try {
    if (classification === 'sql') {
      try {
        result = await withTimeout(runSQLRAG({
          userQuery: query,
          systemPrompt: '',
          userId: isolatedUserId,
          sqlOptions: {
            ...effectiveSqlOptions,
            answerGenerationEnabled: true,
          },
        }), branchTimeoutMs, 'baseline sql branch');
        llmMetrics = combineLlmMetrics(llmMetrics, result?.llmMetrics);
      } catch (err) {
        result = { answer: '', rows: [], sql: '', errors: [{ branch: 'sql', error: String(err?.message || err) }] };
      }
    } else if (classification === 'semantic') {
      try {
        result = await withTimeout(runSemanticRAG({
          query,
          topK: Math.max(3, Number(sqlOptions?.topK || LANGGRAPH_TOP_K)),
          useRerank: false,
          systemPrompt: '',
          userId: isolatedUserId,
          sqlOptions: {
            ...effectiveSqlOptions,
            answerGenerationEnabled: true,
          },
        }), branchTimeoutMs, 'baseline semantic branch');
        llmMetrics = combineLlmMetrics(llmMetrics, result?.llmMetrics);
      } catch (err) {
        result = { answer: '', docs: [], errors: [{ branch: 'vector', error: String(err?.message || err) }] };
      }
    } else {
      const [sqlResult, semanticResult] = await Promise.all([
        withTimeout(runSQLRAG({
          userQuery: query,
          systemPrompt: '',
          userId: isolatedUserId,
          sqlOptions: {
            ...effectiveSqlOptions,
            answerGenerationEnabled: false,
          },
        }), branchTimeoutMs, 'baseline hybrid sql branch').catch((err) => ({ rows: [], sql: '', errors: [{ branch: 'sql', error: String(err?.message || err) }] })),
        withTimeout(runSemanticRAG({
          query,
          topK: Math.max(3, Number(sqlOptions?.topK || LANGGRAPH_TOP_K)),
          useRerank: false,
          systemPrompt: '',
          userId: isolatedUserId,
          sqlOptions: {
            ...effectiveSqlOptions,
            answerGenerationEnabled: false,
          },
        }), branchTimeoutMs, 'baseline hybrid semantic branch').catch((err) => ({ docs: [], errors: [{ branch: 'vector', error: String(err?.message || err) }] })),
      ]);
      llmMetrics = combineLlmMetrics(llmMetrics, sqlResult?.llmMetrics, semanticResult?.llmMetrics);

      const mergedContext = {
        strategy: { classification, branches: ['sql', 'vector'] },
        rows: sqlResult.rows || [],
        docs: semanticResult.docs || [],
        sql: sqlResult.sql ? [{ branch: 'sql', sql: sqlResult.sql }] : [],
        proxyIndex: {
          sql: sqlResult.proxyIndex || {},
          vector: semanticResult.proxyIndex || {},
        },
        recursion: {
          sql: sqlResult.recursion || {},
          vector: semanticResult.recursion || {},
        },
        errors: [
          ...(Array.isArray(sqlResult?.errors) ? sqlResult.errors : []),
          ...(Array.isArray(semanticResult?.errors) ? semanticResult.errors : []),
        ],
      };
      const composed = await composeMergedAnswer(query, mergedContext, { answerGenerationEnabled: true });
      llmMetrics = combineLlmMetrics(llmMetrics, composed.llmMetrics);
      result = {
        answer: composed.answer,
        mergedContext,
        sql: sqlResult,
        semantic: semanticResult,
      };
    }
  } finally {
    if (evalMode) {
      cleanupAfter = await resetEvalArtifacts({ isolatedUserId, sessionId: effectiveSessionId });
    }
  }

  return {
    classification,
    result,
    llmMetrics,
    metrics: {
      totalLatencyMs: Math.max(0, nowMs() - started),
      llmCallsEstimated: Number(llmMetrics?.summary?.callCount || 0),
      sessionId: effectiveSessionId,
      threadId: effectiveThreadId,
      userId: isolatedUserId,
    },
    evalIsolation: evalMode ? {
      enabled: true,
      isolatedUserId,
      cleanupBefore,
      cleanupAfter,
    } : { enabled: false },
  };
}

export async function compareBaselineVsLangGraph({ query, userId = null, evalMode = true, sqlOptions = {} } = {}) {
  const sessionId = randomUUID();
  const effectiveSqlOptions = normalizeSqlOptions(sqlOptions, evalMode);
  const baseline = await runBaselineRetrievalPath({
    query,
    userId,
    sessionId,
    threadId: 'baseline',
    evalMode: Boolean(evalMode),
    sqlOptions: effectiveSqlOptions,
  });
  const langgraph = await runLangGraphRetrieval({
    query,
    userId,
    sessionId,
    threadId: 'langgraph',
    evalMode: Boolean(evalMode),
    sqlOptions: effectiveSqlOptions,
  });
  const finalEvalCleanup = evalMode
    ? await cleanupEvaluationArtifacts({
        userIds: [baseline?.metrics?.userId, langgraph?.metrics?.userId].filter(Boolean),
        markers: [sessionId],
      })
    : { ok: true, skipped: true };
  const ragasReport = buildAutomaticRagasReport({ query, baseline, langgraph });

  return {
    query,
    sessionId,
    requestProfile: buildRequestProfile({
      query,
      userId,
      sessionId,
      threadId: 'compare',
      evalMode,
      sqlOptions: effectiveSqlOptions,
    }),
    baseline,
    langgraph,
    evalIsolation: {
      enabled: Boolean(evalMode),
      finalCleanup: finalEvalCleanup,
    },
    ragasReport,
    comparison: {
      latencyDeltaMs: Number(langgraph?.metrics?.totalLatencyMs || 0) - Number(baseline?.metrics?.totalLatencyMs || 0),
      baselineAnswerLength: String(baseline?.result?.answer || '').length,
      langgraphAnswerLength: String(langgraph?.answer || '').length,
      baselineClassification: baseline?.classification || null,
      langgraphBranches: langgraph?.route?.branches || [],
      llmCallsEstimated: {
        baseline: baseline?.llmMetrics?.summary?.callCount || 0,
        langgraph: langgraph?.llmMetrics?.summary?.callCount || 0,
      },
      totalTokens: {
        baseline: baseline?.llmMetrics?.summary?.totalTokens || 0,
        langgraph: langgraph?.llmMetrics?.summary?.totalTokens || 0,
      },
      estimatedCostUsd: {
        baseline: baseline?.llmMetrics?.summary?.estimatedCostUsd || 0,
        langgraph: langgraph?.llmMetrics?.summary?.estimatedCostUsd || 0,
      },
      accuracyWinner: ragasReport?.conclusion?.accuracyWinner || 'unavailable',
      efficiencyWinner: ragasReport?.conclusion?.efficiencyWinner || 'tie',
      overallWinner: ragasReport?.conclusion?.overallWinner || 'tie',
    },
  };
}