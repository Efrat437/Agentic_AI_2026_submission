import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { inspectBookingSiteNetwork } from './browser_appointment_agent.js';

const DISCOVER_API_NODE_STORE = path.resolve(process.cwd(), 'tmp', 'discover-api-node-catalog.json');

function safeHostFromUrl(url = '') {
  try {
    return new URL(String(url || '')).host || '';
  } catch {
    return '';
  }
}

function normalizeText(v = '') {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

function detectIntent(userRequest = '') {
  const q = normalizeText(userRequest).toLowerCase();
  const isSchedule = /schedule|book|reserve|appoint|set up|קבע|זימון|הרשמה/.test(q);
  const isSlots = /slot|availability|available|calendar|time|when|check|תור|זמינות/.test(q);

  let action = 'discover';
  if (isSchedule) action = 'schedule';
  else if (isSlots) action = 'slots';

  const methodHint = action === 'schedule' ? 'POST' : 'GET';
  const keywords = Array.from(new Set(
    q.split(/[\s,.;:|/()\-]+/g).map((x) => x.trim()).filter((x) => x.length >= 3).slice(0, 40),
  ));

  return {
    action,
    methodHint,
    confidence: isSchedule || isSlots ? 0.88 : 0.55,
    keywords,
    llmStyleReasoning: action === 'schedule'
      ? 'Detected booking intent from request terms; prioritizing create/submit/schedule style APIs.'
      : action === 'slots'
        ? 'Detected availability-check intent; prioritizing read/list/availability style APIs.'
        : 'No clear scheduling intent terms; running broad API discovery and selecting highest-confidence endpoint.',
  };
}

function classifyEndpoint(method = 'GET', url = '', intent = null) {
  const m = String(method || 'GET').toUpperCase();
  const u = String(url || '').toLowerCase();
  const pathname = (() => {
    try { return new URL(url).pathname.toLowerCase(); } catch { return u; }
  })();

  let score = 0;
  let kind = 'unknown';

  if (/\/api\//.test(u)) score += 25;
  if (/\.svc\//.test(u) || /_vti_bin/.test(u)) score += 12;
  if (/analytics|clarity|tiktok|facebook|google-analytics|hotjar|pixel/.test(u)) score -= 50;

  if (/slot|avail|calendar|times?|free/.test(pathname) && m === 'GET') {
    kind = 'slots';
    score += 30;
  }
  if (/schedule|book|reserve|submit|create|appointment/.test(pathname) && ['POST', 'PUT', 'PATCH'].includes(m)) {
    kind = 'schedule';
    score += 30;
  }

  if (intent?.action === 'schedule' && ['POST', 'PUT', 'PATCH'].includes(m)) score += 12;
  if (intent?.action === 'slots' && m === 'GET') score += 12;

  if (Array.isArray(intent?.keywords) && intent.keywords.length) {
    const text = `${pathname} ${u}`;
    for (const kw of intent.keywords.slice(0, 25)) {
      if (kw && text.includes(String(kw).toLowerCase())) score += 2;
    }
  }

  return { kind, score };
}

function toCandidate(entry = {}, intent = null) {
  const method = String(entry?.method || '').toUpperCase();
  const url = String(entry?.url || '').trim();
  const status = Number(entry?.status || 0);
  if (!url || !method) return null;
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null;
  if (status >= 400) return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const cls = classifyEndpoint(method, url, intent);
  if (cls.score < 8) return null;

  return {
    id: randomUUID(),
    key: `${method}|${url}`,
    method,
    url,
    host: parsed.host,
    path: parsed.pathname,
    kind: cls.kind,
    score: cls.score,
    lastStatus: status || null,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    hits: 1,
  };
}

function buildDiscoveredSources(inspection = {}, intent = null) {
  const networkCandidates = (inspection?.networkRequests || [])
    .map((entry) => ({ ...entry, source: 'network-response' }))
    .map((entry) => toCandidate(entry, intent))
    .filter(Boolean);

  const sourceMatches = (inspection?.pageAnalysis?.sourceApiMatches || [])
    .map((url) => toCandidate({ method: 'GET', url, status: 200, source: 'page-source' }, intent))
    .filter(Boolean);

  const javascriptMatches = (inspection?.javascriptScan?.endpoints || [])
    .map((url) => toCandidate({ method: 'GET', url, status: 200, source: 'javascript-scan' }, intent))
    .filter(Boolean);

  const formActionMatches = (inspection?.pageAnalysis?.forms || [])
    .map((form) => toCandidate({ method: String(form?.method || 'GET').toUpperCase(), url: form?.action || '', status: 200, source: 'form-action' }, intent))
    .filter(Boolean);

  return [...networkCandidates, ...sourceMatches, ...javascriptMatches, ...formActionMatches];
}

function mergeCandidates(existing = [], discovered = []) {
  const map = new Map();
  for (const item of existing || []) {
    if (item?.key) map.set(item.key, { ...item });
  }
  for (const item of discovered || []) {
    if (!item?.key) continue;
    if (!map.has(item.key)) {
      map.set(item.key, item);
      continue;
    }
    const prev = map.get(item.key);
    map.set(item.key, {
      ...prev,
      score: Math.max(Number(prev.score || 0), Number(item.score || 0)),
      kind: item.kind === 'unknown' ? prev.kind : item.kind,
      lastStatus: item.lastStatus ?? prev.lastStatus,
      lastSeenAt: item.lastSeenAt,
      hits: Number(prev.hits || 1) + 1,
    });
  }
  return Array.from(map.values()).sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}

function choosePreferredScanFocus(intent = null, hostLearning = {}, adaptiveLearning = true) {
  const action = String(intent?.action || 'discover').toLowerCase();
  if (action === 'slots' || action === 'schedule') return action;
  if (adaptiveLearning && hostLearning?.preferredScanFocus) return String(hostLearning.preferredScanFocus);
  return 'discover';
}

function updateHostLearning(hostLearning = {}, { intent = null, discoveredCount = 0, execution = null, preferredScanFocus = 'discover' } = {}) {
  const action = String(intent?.action || 'discover').toLowerCase();
  const current = { ...(hostLearning || {}) };
  const runs = Number(current.runs || 0) + 1;
  const success = Number(discoveredCount || 0) > 0 || Boolean(execution?.ok);

  const byFocus = { ...(current.byFocus || {}) };
  const focusStats = { ...(byFocus[preferredScanFocus] || { runs: 0, success: 0 }) };
  focusStats.runs = Number(focusStats.runs || 0) + 1;
  focusStats.success = Number(focusStats.success || 0) + (success ? 1 : 0);
  byFocus[preferredScanFocus] = focusStats;

  const byAction = { ...(current.byAction || {}) };
  const actionStats = { ...(byAction[action] || { runs: 0, success: 0 }) };
  actionStats.runs = Number(actionStats.runs || 0) + 1;
  actionStats.success = Number(actionStats.success || 0) + (success ? 1 : 0);
  byAction[action] = actionStats;

  const bestFocus = Object.entries(byFocus)
    .map(([focus, stats]) => ({
      focus,
      score: (Number(stats?.success || 0) / Math.max(1, Number(stats?.runs || 0))) + (Number(stats?.runs || 0) * 0.01),
    }))
    .sort((a, b) => b.score - a.score)[0]?.focus || preferredScanFocus;

  return {
    ...current,
    runs,
    lastAction: action,
    lastRunAt: new Date().toISOString(),
    preferredScanFocus: bestFocus,
    byFocus,
    byAction,
  };
}

function selectBestEndpoint(catalog = [], intent = null) {
  const action = String(intent?.action || 'discover').toLowerCase();
  const preferredMethod = action === 'schedule' ? 'POST' : 'GET';
  const preferredKind = action === 'schedule' ? 'schedule' : (action === 'slots' ? 'slots' : 'unknown');

  const ranked = (catalog || []).map((api) => {
    let bonus = 0;
    if (api.kind === preferredKind) bonus += 30;
    if (api.method === preferredMethod) bonus += 18;
    if (action === 'slots' && /slot|avail|calendar|times?|list/.test(String(api.path || '').toLowerCase())) bonus += 8;
    if (action === 'schedule' && /schedule|book|reserve|submit|create/.test(String(api.path || '').toLowerCase())) bonus += 8;
    return { ...api, finalScore: Number(api.score || 0) + bonus };
  }).sort((a, b) => b.finalScore - a.finalScore);

  return ranked[0] || null;
}

async function executeSelectedEndpoint(endpoint, { intent = null, payload = null, headers = {}, timeoutMs = 45000 } = {}) {
  if (!endpoint?.url) return { ok: false, error: 'No endpoint selected' };

  const action = String(intent?.action || 'discover').toLowerCase();
  const method = action === 'schedule' ? 'POST' : 'GET';
  const reqHeaders = { accept: 'application/json, text/plain;q=0.9, */*;q=0.8', ...(headers || {}) };
  if (method !== 'GET') reqHeaders['content-type'] = reqHeaders['content-type'] || 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 45000));
  try {
    const resp = await fetch(endpoint.url, {
      method,
      headers: reqHeaders,
      body: method === 'GET' ? undefined : (payload == null ? undefined : (typeof payload === 'string' ? payload : JSON.stringify(payload))),
      signal: controller.signal,
    });

    const text = await resp.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: String(text || '').slice(0, 5000) };
    }

    return {
      ok: resp.ok,
      method,
      status: resp.status,
      statusText: resp.statusText,
      url: endpoint.url,
      response: parsed,
    };
  } catch (err) {
    return { ok: false, method, url: endpoint.url, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function readStore() {
  try {
    const raw = await fs.readFile(DISCOVER_API_NODE_STORE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      updatedAt: parsed?.updatedAt || null,
      hosts: parsed?.hosts && typeof parsed.hosts === 'object' ? parsed.hosts : {},
      learning: parsed?.learning && typeof parsed.learning === 'object' ? parsed.learning : {},
    };
  } catch {
    return { updatedAt: null, hosts: {}, learning: {} };
  }
}

async function writeStore(store = {}) {
  await fs.mkdir(path.dirname(DISCOVER_API_NODE_STORE), { recursive: true });
  await fs.writeFile(DISCOVER_API_NODE_STORE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    hosts: store?.hosts && typeof store.hosts === 'object' ? store.hosts : {},
    learning: store?.learning && typeof store.learning === 'object' ? store.learning : {},
  }, null, 2), 'utf8');
}

export class DiscoverAPINode {
  async run({
    websiteUrl,
    userRequest,
    payload = null,
    headers = {},
    executeAction = true,
    autonomousBrowse = true,
    maxAutonomousSteps = 4,
    maxNetworkEntries = 300,
    timeoutMs = 90000,
    endpointHarvesting = {},
    adaptiveLearning = true,
  } = {}) {
    const siteUrl = String(websiteUrl || '').trim();
    if (!siteUrl) {
      return { ok: false, error: 'websiteUrl is required' };
    }

    const intent = detectIntent(userRequest || 'discover appointment API and perform action');

    const store = await readStore();
    const host = safeHostFromUrl(siteUrl);
    const hostLearning = store?.learning?.[host] || {};
    const preferredScanFocus = choosePreferredScanFocus(intent, hostLearning, adaptiveLearning !== false);
    const resolvedHarvesting = {
      browserAutomationHarvesting: true,
      level: 'turbo20',
      strategy: 'high-level-efficient',
      ...(endpointHarvesting || {}),
      scanFocus: String(endpointHarvesting?.scanFocus || preferredScanFocus || 'auto'),
    };

    const inspection = await inspectBookingSiteNetwork({
      bookingUrl: siteUrl,
      intentText: userRequest || intent.action,
      autonomousBrowse: Boolean(autonomousBrowse),
      maxAutonomousSteps: Math.max(1, Math.min(8, Number(maxAutonomousSteps) || 4)),
      maxNetworkEntries: Math.max(50, Number(maxNetworkEntries) || 300),
      timeoutMs: Math.max(10000, Number(timeoutMs) || 90000),
      endpointHarvesting: resolvedHarvesting,
    });

    const discoveredCandidates = buildDiscoveredSources(inspection, intent);

    const existingHostCatalog = Array.isArray(store.hosts?.[host]) ? store.hosts[host] : [];
    const mergedCatalog = mergeCandidates(existingHostCatalog, discoveredCandidates);
    store.hosts = { ...(store.hosts || {}), [host]: mergedCatalog };

    const selected = selectBestEndpoint(mergedCatalog, intent);
    const execution = executeAction
      ? await executeSelectedEndpoint(selected, { intent, payload, headers })
      : null;

    const updatedHostLearning = updateHostLearning(hostLearning, {
      intent,
      discoveredCount: discoveredCandidates.length,
      execution,
      preferredScanFocus: String(resolvedHarvesting.scanFocus || preferredScanFocus || 'discover'),
    });
    store.learning = { ...(store.learning || {}), [host]: updatedHostLearning };
    await writeStore(store);

    return {
      ok: true,
      flow: ['User request', 'Intent detection', 'API discovery', 'Action execution'],
      verification: {
        networkInspection: Boolean(inspection?.networkCount >= 0),
        websiteSourceSearch: Array.isArray(inspection?.pageAnalysis?.sourceApiMatches),
        urlPatternExploration: Array.isArray(inspection?.urlPatternExploration),
        apiResponseInspection: Array.isArray(inspection?.apiResponsePreviews),
        automatedNetworkLogging: Boolean(inspection?.automatedNetworkLogging?.enabled),
        browserAgentAnalysis: Array.isArray(inspection?.pageAnalysis?.buttons) && Array.isArray(inspection?.pageAnalysis?.forms),
        javascriptApiScan: Array.isArray(inspection?.javascriptScan?.endpoints),
        htmlScriptExtractionRegex: Array.isArray(inspection?.pageAnalysis?.htmlRegexScriptUrls),
        webWorkerDiscovery: Array.isArray(inspection?.javascriptScan?.workerScripts),
        serviceWorkerIdentification: typeof inspection?.pageAnalysis?.serviceWorker === 'object' && inspection?.pageAnalysis?.serviceWorker != null,
        discoverAPIWebWorkers: Array.isArray(inspection?.javascriptScan?.discoverAPIWebWorkers),
        systemGoalUnderMinute: inspection?.systemGoal?.metUnderMinuteTarget === true,
        systemGoalUnderTwentySeconds: inspection?.systemGoal?.metUnderTwentySecondTarget === true,
        endpointHarvesting: typeof inspection?.endpointHarvesting === 'object' && inspection?.endpointHarvesting != null,
        selfLearningMechanism: adaptiveLearning !== false,
      },
      orchestration: {
        browserAgentFlow: inspection?.browserAgent?.flow || ['User request', 'Agent opens website', 'Agent analyzes page', 'Agent finds form/API', 'Agent performs action'],
        agentLayers: inspection?.browserAgent?.layers || ['LLM', 'planner', 'browser controller', 'action executor'],
        systemGoalFlow: inspection?.browserAgent?.systemGoalFlow || ['system goal: user question', 'agent reasoning', 'data query OR action', 'browser automation', 'find javascript files', 'scan for api paths', 'print endpoints'],
        llm: {
          role: 'intent detection and reasoning',
          userRequest,
          outputAction: intent.action,
          methodHint: intent.methodHint,
          reasoning: intent.llmStyleReasoning,
        },
        planner: {
          goal: userRequest || 'discover APIs and perform the requested website action',
          chosenPath: intent.action === 'discover' ? 'data query OR action' : 'action',
          plan: ['open website', 'analyze page', 'inspect forms and buttons', 'inspect network', 'find javascript files', 'scan API paths', executeAction ? 'perform action' : 'print endpoints'],
        },
        browserController: {
          autonomousBrowse: Boolean(autonomousBrowse),
          maxAutonomousSteps: Math.max(1, Math.min(8, Number(maxAutonomousSteps) || 4)),
          finalUrl: inspection?.finalUrl || siteUrl,
        },
        actionExecutor: {
          executeAction: Boolean(executeAction),
          selectedEndpoint: selected?.url || null,
          executionStatus: execution?.status || null,
        },
        endpointHarvesting: inspection?.endpointHarvesting || null,
      },
      selfLearning: {
        enabled: adaptiveLearning !== false,
        preferredScanFocus,
        learnedRuns: Number(updatedHostLearning?.runs || 0),
        model: updatedHostLearning,
      },
      userRequest,
      websiteUrl: siteUrl,
      intent,
      discovery: {
        ok: Boolean(inspection?.ok),
        finalUrl: inspection?.finalUrl || null,
        pageTitle: inspection?.pageTitle || null,
        networkCount: inspection?.networkCount || 0,
        discoveredCount: discoveredCandidates.length,
        traversal: inspection?.traversal || null,
        pageAnalysis: inspection?.pageAnalysis || null,
        urlPatternExploration: inspection?.urlPatternExploration || [],
        apiResponsePreviews: inspection?.apiResponsePreviews || [],
        automatedNetworkLogging: inspection?.automatedNetworkLogging || { enabled: false, apiLikeEntries: [] },
        javascriptScan: inspection?.javascriptScan || { ok: false, scannedCount: 0, endpoints: [] },
        selfHealing: inspection?.selfHealing || { enabled: false, attemptedSelectors: [], successfulHits: [] },
        endpointHarvesting: inspection?.endpointHarvesting || null,
        systemGoal: inspection?.systemGoal || null,
      },
      catalog: {
        host,
        total: mergedCatalog.length,
        apis: mergedCatalog,
      },
      selectedEndpoint: selected,
      execution,
    };
  }
}

export async function runDiscoverAPINode(args = {}) {
  const node = new DiscoverAPINode();
  return node.run(args);
}

export async function getDiscoverApiNodeCatalog({ host = '' } = {}) {
  const store = await readStore();
  const requestedHost = String(host || '').trim();
  if (!requestedHost) {
    return {
      ok: true,
      updatedAt: store.updatedAt,
      hosts: store.hosts,
      totalHosts: Object.keys(store.hosts || {}).length,
    };
  }
  return {
    ok: true,
    updatedAt: store.updatedAt,
    host: requestedHost,
    apis: Array.isArray(store.hosts?.[requestedHost]) ? store.hosts[requestedHost] : [],
  };
}
