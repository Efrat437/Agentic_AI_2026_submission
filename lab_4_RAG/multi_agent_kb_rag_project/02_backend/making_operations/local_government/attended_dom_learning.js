import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { Pool } from 'pg';

const ATTENDED_DOM_LEARNING_FILE = path.resolve(process.cwd(), 'tmp', 'attended-dom-learning.json');
const ATTENDED_DOM_LEARNING_DIR = path.resolve(process.cwd(), 'tmp', 'attended-dom-learning');
const ATTENDED_DOM_LEARNING_INDEX_FILE = path.join(ATTENDED_DOM_LEARNING_DIR, 'index.json');
const ATTENDED_DOM_LEARNING_HOSTS_DIR = path.join(ATTENDED_DOM_LEARNING_DIR, 'hosts');
const ATTENDED_DOM_LEARNING_LOCK_FILE = path.join(ATTENDED_DOM_LEARNING_DIR, '.write.lock');
const ATTENDED_DOM_LOCK_TIMEOUT_MS = Math.max(2000, Number(process.env.ATTENDED_DOM_LOCK_TIMEOUT_MS || 8000));
const ATTENDED_DOM_LOCK_RETRY_MS = Math.max(25, Number(process.env.ATTENDED_DOM_LOCK_RETRY_MS || 80));
const ATTENDED_DOM_STORE_DRIVER = String(process.env.ATTENDED_DOM_LEARNING_STORE_DRIVER || 'sharded-json').trim().toLowerCase();
const ATTENDED_DOM_SEMANTIC_DIMENSIONS = 24;
const ATTENDED_DOM_TABLE = 'attended_dom_learning_store';

let attendedDomLearningPool = null;

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateText(value = '', maxLength = 240) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 16))}...[truncated]`;
}

function hashText(value = '', length = 16) {
  return createHash('sha1').update(String(value || ''), 'utf8').digest('hex').slice(0, Math.max(8, Number(length) || 16));
}

function uniqueList(values = [], max = 10) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))).slice(0, max);
}

function normalizedTokenList(values = [], { minLength = 3, max = 24 } = {}) {
  const stopWords = new Set(['the', 'and', 'for', 'with', 'form', 'field', 'page', 'button', 'input', 'label']);
  return uniqueList(values, max * 2)
    .flatMap((value) => normalizeText(value).toLowerCase().split(/[\s|,.;:/\\()[\]{}<>"'`!?+=_-]+/g))
    .filter((token) => token.length >= minLength && !/^\d+$/.test(token) && !stopWords.has(token))
    .slice(0, max);
}

function toComparableSet(values = []) {
  return new Set(uniqueList(values, 20).map((value) => normalizeText(value).toLowerCase()).filter(Boolean));
}

export function safeHostFromUrl(url = '') {
  try {
    return new URL(String(url || '').trim()).host.toLowerCase();
  } catch {
    return '';
  }
}

function buildPagePath(url = '') {
  try {
    return new URL(String(url || '').trim()).pathname || null;
  } catch {
    return null;
  }
}

function buildSemanticText(payload = {}) {
  return normalizeText([
    payload?.pagePath,
    payload?.pageTitle,
    payload?.text,
    payload?.label,
    payload?.placeholder,
    payload?.name,
    payload?.ariaLabel,
    payload?.containerText,
    payload?.structuralSignature,
    ...(Array.isArray(payload?.structuralTerms) ? payload.structuralTerms : []),
  ].join(' '));
}

export function buildSemanticEmbedding(value = '', dimensions = ATTENDED_DOM_SEMANTIC_DIMENSIONS) {
  const vector = new Array(Math.max(8, Number(dimensions) || ATTENDED_DOM_SEMANTIC_DIMENSIONS)).fill(0);
  const tokens = normalizedTokenList([value], { minLength: 2, max: 64 });
  if (!tokens.length) return vector;
  for (const token of tokens) {
    const weight = Math.min(4, Math.max(1, token.length / 4));
    const tokenHash = createHash('sha1').update(token, 'utf8').digest();
    for (let index = 0; index < vector.length; index += 1) {
      const byte = tokenHash[index % tokenHash.length];
      vector[index] += ((byte / 255) * 2 - 1) * weight;
    }
  }
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1;
  return vector.map((item) => Number((item / magnitude).toFixed(6)));
}

export function cosineSimilarity(left = [], right = []) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || !right.length) return 0;
  const size = Math.min(left.length, right.length);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < size; index += 1) {
    const l = Number(left[index] || 0);
    const r = Number(right[index] || 0);
    dot += l * r;
    leftMagnitude += l * l;
    rightMagnitude += r * r;
  }
  if (!leftMagnitude || !rightMagnitude) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function jaccardSimilarity(left = [], right = []) {
  const leftSet = toComparableSet(left);
  const rightSet = toComparableSet(right);
  if (!leftSet.size || !rightSet.size) return 0;
  let intersection = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) intersection += 1;
  }
  const union = new Set([...leftSet, ...rightSet]).size || 1;
  return intersection / union;
}

function sanitizeHostShardName(host = '') {
  return String(host || '').trim().toLowerCase().replace(/[^a-z0-9.-]+/g, '_') || 'unknown-host';
}

function getHostShardFile(host = '') {
  return path.join(ATTENDED_DOM_LEARNING_HOSTS_DIR, `${sanitizeHostShardName(host)}.json`);
}

function getStoreDriver() {
  if (ATTENDED_DOM_STORE_DRIVER === 'postgres' && (process.env.DATABASE_URL || process.env.PGHOST)) return 'postgres';
  return 'sharded-json';
}

function getPostgresPool() {
  if (getStoreDriver() !== 'postgres') return null;
  if (!attendedDomLearningPool) {
    attendedDomLearningPool = new Pool({ connectionString: process.env.DATABASE_URL || undefined });
  }
  return attendedDomLearningPool;
}

async function ensurePostgresStoreTable() {
  const pool = getPostgresPool();
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${ATTENDED_DOM_TABLE} (
      host TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(10, Number(ms) || 10)));
}

async function withFileLock(work, { timeoutMs = ATTENDED_DOM_LOCK_TIMEOUT_MS, retryMs = ATTENDED_DOM_LOCK_RETRY_MS } = {}) {
  const startedAt = Date.now();
  await fs.mkdir(ATTENDED_DOM_LEARNING_DIR, { recursive: true });
  while (true) {
    try {
      const handle = await fs.open(ATTENDED_DOM_LEARNING_LOCK_FILE, 'wx');
      try {
        return await work();
      } finally {
        await handle.close().catch(() => {});
        await fs.unlink(ATTENDED_DOM_LEARNING_LOCK_FILE).catch(() => {});
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for attended DOM learning store lock after ${timeoutMs}ms`);
      }
      await sleep(retryMs);
    }
  }
}

async function writeJsonAtomic(filePath, payload) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(tempPath, filePath);
}

function normalizeStoreShape(store = {}) {
  return {
    updatedAt: store?.updatedAt || null,
    hosts: store?.hosts && typeof store.hosts === 'object' ? store.hosts : {},
  };
}

export function buildDomVersion(payload = {}) {
  const source = normalizeText([
    payload?.pagePath || buildPagePath(payload?.pageUrl || ''),
    payload?.pageTitle,
    payload?.tag,
    payload?.inputType,
    payload?.role,
    payload?.formAction,
    payload?.structuralSignature,
    ...(Array.isArray(payload?.structuralTerms) ? payload.structuralTerms : normalizedTokenList([
      payload?.text,
      payload?.label,
      payload?.placeholder,
      payload?.name,
      payload?.ariaLabel,
      payload?.containerText,
    ], { max: 18 })),
  ].join('|')).toLowerCase();
  return `dv1_${hashText(source, 18)}`;
}

function buildFallbackSelectorCandidates(record = {}) {
  const tag = String(record?.tag || '*').trim().toLowerCase() || '*';
  const list = [];
  if (record?.name) list.push(`${tag}[name="${String(record.name).replace(/"/g, '\\"')}"]`);
  if (record?.ariaLabel) list.push(`${tag}[aria-label="${String(record.ariaLabel).replace(/"/g, '\\"')}"]`);
  if (record?.placeholder) list.push(`${tag}[placeholder="${String(record.placeholder).replace(/"/g, '\\"')}"]`);
  if (record?.href && tag === 'a') list.push(`${tag}[href="${String(record.href).replace(/"/g, '\\"')}"]`);
  if (record?.inputType && tag === 'input') list.push(`${tag}[type="${String(record.inputType).replace(/"/g, '\\"')}"]`);
  if (record?.domPath) list.push(String(record.domPath));
  return uniqueList(list, 10);
}

function buildPlaywrightLocatorHints(record = {}) {
  return {
    label: record?.label || null,
    placeholder: record?.placeholder || null,
    role: record?.role || null,
    text: record?.text || null,
    name: record?.name || null,
    ariaLabel: record?.ariaLabel || null,
  };
}

function computeSuccessRate(successCount = 0, failureCount = 0) {
  const successes = Math.max(0, Number(successCount || 0));
  const failures = Math.max(0, Number(failureCount || 0));
  const attempts = successes + failures;
  if (!attempts) return 0;
  return successes / attempts;
}

function prioritizeSelectorCandidates(selectorCandidates = [], record = {}, selectorStats = {}) {
  const candidates = uniqueList([
    ...(selectorCandidates || []),
    ...buildFallbackSelectorCandidates(record),
  ], 24);
  return candidates
    .map((selector) => {
      const stats = selectorStats?.[selector] || {};
      const successRate = computeSuccessRate(stats?.successCount || 0, stats?.failureCount || 0);
      let score = 0;
      if (selector.startsWith('#')) score += 34;
      if (/data-testid|data-qa/.test(selector)) score += 28;
      if (/\[name=/.test(selector)) score += 24;
      if (/aria-label/.test(selector)) score += 20;
      if (/placeholder/.test(selector)) score += 16;
      if (/\[href=/.test(selector)) score += 15;
      if (/\[type=/.test(selector)) score += 8;
      if (/\./.test(selector)) score += 4;
      score += Math.max(0, 12 - Math.min(12, selector.length / 18));
      score += Number(stats?.successCount || 0) * 12;
      score -= Number(stats?.failureCount || 0) * 8;
      score += successRate * 18;
      if (record?.critical && selector.startsWith('#')) score += 4;
      return { selector, score };
    })
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.selector)
    .slice(0, 12);
}

function createActionEntry(record = {}) {
  return {
    record,
    observedCount: 0,
    replaySuccessCount: 0,
    replayFailureCount: 0,
    selectorStats: {},
    recentFailures: [],
    replayConfidence: 0.2,
    firstSeenAt: record?.recordedAt || new Date().toISOString(),
    lastSeenAt: record?.recordedAt || new Date().toISOString(),
  };
}

function buildRecordSimilarity(left = {}, right = {}) {
  const leftText = buildSemanticText(left);
  const rightText = buildSemanticText(right);
  const lexicalScore = jaccardSimilarity(left?.structuralTerms || normalizedTokenList([leftText], { max: 20 }), right?.structuralTerms || normalizedTokenList([rightText], { max: 20 }));
  const embeddingScore = cosineSimilarity(left?.semanticEmbedding || buildSemanticEmbedding(leftText), right?.semanticEmbedding || buildSemanticEmbedding(rightText));
  const pathScore = String(left?.pagePath || '').trim().toLowerCase() && String(left?.pagePath || '').trim().toLowerCase() === String(right?.pagePath || '').trim().toLowerCase() ? 1 : 0;
  const tagScore = left?.tag && right?.tag && String(left.tag).toLowerCase() === String(right.tag).toLowerCase() ? 1 : 0;
  const inputTypeScore = left?.inputType && right?.inputType && String(left.inputType).toLowerCase() === String(right.inputType).toLowerCase() ? 1 : 0;
  const domVersionScore = left?.domVersion && right?.domVersion && left.domVersion === right.domVersion ? 1 : 0;
  return (lexicalScore * 0.3) + (embeddingScore * 0.35) + (pathScore * 0.18) + (tagScore * 0.08) + (inputTypeScore * 0.04) + (domVersionScore * 0.05);
}

function resolveExistingActionKey(actions = {}, record = {}) {
  const exactKey = buildActionKey(record);
  if (actions[exactKey]) return exactKey;
  let best = { key: exactKey, score: 0 };
  for (const [candidateKey, entry] of Object.entries(actions || {})) {
    const similarity = buildRecordSimilarity(entry?.record || {}, record);
    if (similarity > best.score) best = { key: candidateKey, score: similarity };
  }
  return best.score >= 0.74 ? best.key : exactKey;
}

function computeReplayConfidence(entry = {}, pageContext = {}) {
  const observedCount = Number(entry?.observedCount || 0);
  const replaySuccessCount = Number(entry?.replaySuccessCount || 0);
  const replayFailureCount = Number(entry?.replayFailureCount || 0);
  const selectorStats = entry?.selectorStats && typeof entry.selectorStats === 'object' ? entry.selectorStats : {};
  const selectorSignal = Object.values(selectorStats).reduce((sum, item) => sum + (Number(item?.successCount || 0) * 0.08) - (Number(item?.failureCount || 0) * 0.05), 0);
  const semanticBoost = pageContext && Object.keys(pageContext).length ? Math.min(0.25, Math.max(0, scoreReplayRecordForPage(entry?.record || {}, pageContext) / 160)) : 0;
  const raw = 0.2 + Math.min(0.25, observedCount * 0.03) + Math.min(0.35, replaySuccessCount * 0.09) - Math.min(0.25, replayFailureCount * 0.07) + selectorSignal + semanticBoost;
  return Number(Math.max(0.05, Math.min(0.99, raw)).toFixed(4));
}

function normalizeBindingValue(value) {
  if (value == null) return '';
  return String(value).trim();
}

export function inferApplicantBinding(rawValue = '', applicant = {}) {
  const candidateValue = normalizeBindingValue(rawValue);
  if (!candidateValue) return null;

  const bindings = [
    ['fullName', applicant?.fullName],
    ['idNumber', applicant?.idNumber],
    ['phone', applicant?.phone],
    ['email', applicant?.email],
    ['address', applicant?.address],
    ['notes', applicant?.notes],
    ['loginUsername', applicant?.loginUsername],
    ['loginPassword', applicant?.loginPassword],
    ['otpCode', applicant?.otpCode],
    ['totpSecret', applicant?.totpSecret],
  ];

  for (const [binding, value] of bindings) {
    if (normalizeBindingValue(value) && normalizeBindingValue(value) === candidateValue) return binding;
  }

  const extraFields = applicant?.extraFields && typeof applicant.extraFields === 'object' ? applicant.extraFields : {};
  for (const [key, value] of Object.entries(extraFields)) {
    if (normalizeBindingValue(value) && normalizeBindingValue(value) === candidateValue) {
      return `extraFields.${String(key || '').trim()}`;
    }
  }

  return null;
}

export function resolveApplicantBindingValue(binding = '', applicant = {}) {
  const normalizedBinding = String(binding || '').trim();
  if (!normalizedBinding) return null;
  if (normalizedBinding.startsWith('extraFields.')) {
    const key = normalizedBinding.slice('extraFields.'.length);
    return applicant?.extraFields && typeof applicant.extraFields === 'object' ? applicant.extraFields[key] ?? null : null;
  }
  return applicant?.[normalizedBinding] ?? null;
}

function isSensitiveField(payload = {}) {
  const blob = normalizeText([
    payload?.type,
    payload?.inputType,
    payload?.name,
    payload?.label,
    payload?.placeholder,
    payload?.ariaLabel,
    payload?.text,
  ].join(' ')).toLowerCase();
  return /password|pass|otp|code|verification|cvv|card|credit|token|secret|sms|סיסמה|קוד|אימות|כרטיס|cvv/.test(blob);
}

function isCriticalAction(payload = {}) {
  const blob = normalizeText([
    payload?.eventType,
    payload?.tag,
    payload?.type,
    payload?.text,
    payload?.label,
    payload?.placeholder,
    payload?.name,
    payload?.formAction,
  ].join(' ')).toLowerCase();
  return /submit|book|schedule|continue|next|verify|login|otp|arnona|זימון|קבע|המשך|אישור|שלח|כניסה|הזדהות/.test(blob);
}

function maskValuePreview(value = '') {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 4) return '*'.repeat(text.length);
  return `${text.slice(0, 1)}${'*'.repeat(Math.max(2, text.length - 2))}${text.slice(-1)}`;
}

export function buildAttendedActionRecord(payload = {}, applicant = {}) {
  const sensitive = isSensitiveField(payload);
  const rawValue = String(payload?.value ?? '').trim();
  const valueBinding = rawValue ? inferApplicantBinding(rawValue, applicant) : null;
  const valuePreview = sensitive ? maskValuePreview(rawValue) : truncateText(rawValue, 80);
  const text = normalizeText(payload?.text || payload?.innerText || '');
  const label = normalizeText(payload?.label || '');
  const placeholder = normalizeText(payload?.placeholder || '');
  const structuralTerms = uniqueList([
    text,
    label,
    placeholder,
    payload?.name,
    payload?.ariaLabel,
    payload?.containerText,
    payload?.pageTitle,
  ].flatMap((item) => normalizeText(item).split(/\s+/g).filter((token) => token.length >= 3)), 18);
  const pagePath = buildPagePath(payload?.pageUrl || '');
  const semanticText = buildSemanticText({
    ...payload,
    pagePath,
    text,
    label,
    placeholder,
    structuralTerms,
  });
  const domVersion = buildDomVersion({
    ...payload,
    pagePath,
    text,
    label,
    placeholder,
    structuralTerms,
  });
  const baseRecord = {
    eventType: String(payload?.eventType || '').trim().toLowerCase() || 'unknown',
    tag: String(payload?.tag || '').trim().toLowerCase() || null,
    inputType: String(payload?.inputType || '').trim().toLowerCase() || null,
    pageUrl: String(payload?.pageUrl || '').trim() || null,
    pageHost: safeHostFromUrl(payload?.pageUrl || ''),
    pagePath,
    pageTitle: truncateText(normalizeText(payload?.pageTitle || ''), 120) || null,
    text: text || null,
    label: label || null,
    placeholder: placeholder || null,
    name: normalizeText(payload?.name || '') || null,
    role: normalizeText(payload?.role || '') || null,
    ariaLabel: normalizeText(payload?.ariaLabel || '') || null,
    href: String(payload?.href || '').trim() || null,
    formAction: String(payload?.formAction || '').trim() || null,
    domPath: truncateText(normalizeText(payload?.domPath || ''), 220) || null,
    containerText: truncateText(normalizeText(payload?.containerText || ''), 140) || null,
    structuralTerms,
    structuralSignature: truncateText(normalizeText(payload?.structuralSignature || ''), 220) || null,
    semanticText,
    semanticEmbedding: buildSemanticEmbedding(semanticText),
    domVersion,
    critical: Boolean(payload?.critical || isCriticalAction(payload)),
    sensitive,
    valueBinding,
    valuePreview: valuePreview || null,
    replayConfidence: Number(payload?.replayConfidence || 0.25),
    recordedAt: String(payload?.recordedAt || new Date().toISOString()),
  };
  return {
    ...baseRecord,
    selectorCandidates: prioritizeSelectorCandidates(uniqueList(payload?.selectorCandidates || [], 12), baseRecord, {}),
    fallbackSelectorCandidates: buildFallbackSelectorCandidates(baseRecord),
    playwrightLocatorHints: buildPlaywrightLocatorHints(baseRecord),
  };
}

export function buildActionKey(record = {}) {
  const intentTokens = normalizedTokenList([
    record?.name,
    record?.label,
    record?.text,
    record?.placeholder,
    record?.ariaLabel,
    ...(Array.isArray(record?.structuralTerms) ? record.structuralTerms : []),
  ], { max: 8 });
  return [
    String(record?.eventType || '').trim().toLowerCase(),
    String(record?.pagePath || '').trim().toLowerCase(),
    String(record?.tag || '').trim().toLowerCase(),
    String(record?.inputType || '').trim().toLowerCase(),
    String(record?.role || '').trim().toLowerCase(),
    String(record?.domVersion || '').trim().toLowerCase(),
    hashText(intentTokens.join('|'), 14),
  ].join('|');
}

export async function readAttendedDomLearningStore() {
  if (getStoreDriver() === 'postgres') {
    try {
      await ensurePostgresStoreTable();
      const pool = getPostgresPool();
      const result = await pool.query(`SELECT host, payload, updated_at FROM ${ATTENDED_DOM_TABLE}`);
      const hosts = Object.fromEntries(result.rows.map((row) => [row.host, row.payload]));
      const updatedAt = result.rows.reduce((latest, row) => {
        const iso = row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || '');
        return !latest || iso > latest ? iso : latest;
      }, null);
      return normalizeStoreShape({ updatedAt, hosts });
    } catch {
      return { updatedAt: null, hosts: {} };
    }
  }

  try {
    const shardFiles = await fs.readdir(ATTENDED_DOM_LEARNING_HOSTS_DIR).catch(() => []);
    const hosts = {};
    let updatedAt = null;
    for (const fileName of shardFiles) {
      if (!fileName.endsWith('.json')) continue;
      const raw = await fs.readFile(path.join(ATTENDED_DOM_LEARNING_HOSTS_DIR, fileName), 'utf8').catch(() => '');
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const host = String(parsed?.host || '').trim();
      if (!host) continue;
      hosts[host] = parsed?.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
      if (parsed?.updatedAt && (!updatedAt || parsed.updatedAt > updatedAt)) updatedAt = parsed.updatedAt;
    }
    if (Object.keys(hosts).length > 0) {
      return normalizeStoreShape({ updatedAt, hosts });
    }
  } catch {
  }

  try {
    const raw = await fs.readFile(ATTENDED_DOM_LEARNING_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeStoreShape(parsed);
  } catch {
    return { updatedAt: null, hosts: {} };
  }
}

export async function writeAttendedDomLearningStore(store = {}) {
  const normalized = normalizeStoreShape(store);
  const updatedAt = new Date().toISOString();
  if (getStoreDriver() === 'postgres') {
    await ensurePostgresStoreTable();
    const pool = getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [host, payload] of Object.entries(normalized.hosts || {})) {
        await client.query(
          `INSERT INTO ${ATTENDED_DOM_TABLE} (host, payload, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (host) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
          [host, JSON.stringify(payload || {})]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return;
  }

  await withFileLock(async () => {
    await fs.mkdir(ATTENDED_DOM_LEARNING_HOSTS_DIR, { recursive: true });
    const hostIndex = [];
    for (const [host, payload] of Object.entries(normalized.hosts || {})) {
      const shardFile = getHostShardFile(host);
      hostIndex.push({ host, file: path.basename(shardFile), updatedAt });
      await writeJsonAtomic(shardFile, { host, updatedAt, payload });
    }
    await writeJsonAtomic(ATTENDED_DOM_LEARNING_INDEX_FILE, { updatedAt, hosts: hostIndex });
    await writeJsonAtomic(ATTENDED_DOM_LEARNING_FILE, {
      updatedAt,
      hosts: normalized.hosts,
      storage: 'sharded-json',
    });
  });
}

export function mergeAttendedSessionLearning(store = {}, { host = '', actionRecords = [], failures = [] } = {}) {
  if (!host) return store;
  const hosts = { ...(store?.hosts || {}) };
  const hostEntry = { ...(hosts[host] || {}) };
  const actions = { ...(hostEntry.actions || {}) };

  for (const record of Array.isArray(actionRecords) ? actionRecords : []) {
    const normalizedRecord = {
      ...record,
      domVersion: record?.domVersion || buildDomVersion(record),
      semanticText: record?.semanticText || buildSemanticText(record),
      semanticEmbedding: Array.isArray(record?.semanticEmbedding) ? record.semanticEmbedding : buildSemanticEmbedding(record?.semanticText || buildSemanticText(record)),
      selectorCandidates: uniqueList(record?.selectorCandidates || [], 12),
      fallbackSelectorCandidates: uniqueList([...(record?.fallbackSelectorCandidates || []), ...buildFallbackSelectorCandidates(record)], 12),
      playwrightLocatorHints: record?.playwrightLocatorHints || buildPlaywrightLocatorHints(record),
    };
    const key = resolveExistingActionKey(actions, normalizedRecord);
    const previous = actions[key] || createActionEntry(normalizedRecord);
    const selectorStats = previous.selectorStats && typeof previous.selectorStats === 'object' ? previous.selectorStats : {};
    actions[key] = {
      ...previous,
      record: {
        ...previous.record,
        ...normalizedRecord,
        selectorCandidates: prioritizeSelectorCandidates([...(previous.record?.selectorCandidates || []), ...(normalizedRecord?.selectorCandidates || [])], normalizedRecord, selectorStats),
        fallbackSelectorCandidates: uniqueList([...(previous.record?.fallbackSelectorCandidates || []), ...(normalizedRecord?.fallbackSelectorCandidates || [])], 12),
        structuralTerms: uniqueList([...(previous.record?.structuralTerms || []), ...(normalizedRecord?.structuralTerms || [])], 20),
        semanticText: normalizedRecord.semanticText,
        semanticEmbedding: normalizedRecord.semanticEmbedding,
        domVersion: normalizedRecord.domVersion,
        playwrightLocatorHints: {
          ...(previous.record?.playwrightLocatorHints || {}),
          ...(normalizedRecord.playwrightLocatorHints || {}),
        },
      },
      observedCount: Math.max(0, Number(previous.observedCount || 0)) + 1,
      replayConfidence: computeReplayConfidence({ ...previous, observedCount: Math.max(0, Number(previous.observedCount || 0)) + 1 }),
      lastSeenAt: normalizedRecord?.recordedAt || new Date().toISOString(),
    };
  }

  const trimmedFailures = [
    ...(Array.isArray(hostEntry.failures) ? hostEntry.failures : []),
    ...(Array.isArray(failures) ? failures : []),
  ].slice(-80);

  hosts[host] = {
    ...hostEntry,
    updatedAt: new Date().toISOString(),
    storage: getStoreDriver(),
    actions,
    failures: trimmedFailures,
  };
  return { ...(store || {}), hosts };
}

export function markReplayResult(store = {}, { host = '', record = null, ok = false, selector = '', mode = '', failureReason = '' } = {}) {
  if (!host || !record) return store;
  const hosts = { ...(store?.hosts || {}) };
  const hostEntry = { ...(hosts[host] || {}) };
  const actions = { ...(hostEntry.actions || {}) };
  const normalizedRecord = {
    ...record,
    domVersion: record?.domVersion || buildDomVersion(record),
    semanticText: record?.semanticText || buildSemanticText(record),
    semanticEmbedding: Array.isArray(record?.semanticEmbedding) ? record.semanticEmbedding : buildSemanticEmbedding(record?.semanticText || buildSemanticText(record)),
  };
  const key = resolveExistingActionKey(actions, normalizedRecord);
  if (!actions[key]) {
    actions[key] = createActionEntry(normalizedRecord);
  }
  const entry = actions[key];
  const selectorStats = { ...(entry.selectorStats || {}) };
  const normalizedSelector = String(selector || '').trim();
  if (normalizedSelector) {
    const stats = selectorStats[normalizedSelector] || { successCount: 0, failureCount: 0, lastMode: null, lastSeenAt: null };
    selectorStats[normalizedSelector] = {
      ...stats,
      successCount: Math.max(0, Number(stats.successCount || 0)) + (ok ? 1 : 0),
      failureCount: Math.max(0, Number(stats.failureCount || 0)) + (ok ? 0 : 1),
      lastMode: mode || stats.lastMode || null,
      lastSeenAt: new Date().toISOString(),
    };
  }
  const recentFailures = ok ? (entry.recentFailures || []) : [
    ...(Array.isArray(entry.recentFailures) ? entry.recentFailures : []),
    {
      at: new Date().toISOString(),
      selector: normalizedSelector || null,
      mode: mode || null,
      reason: failureReason || null,
    },
  ].slice(-12);
  actions[key] = {
    ...entry,
    record: {
      ...entry.record,
      ...normalizedRecord,
      selectorCandidates: prioritizeSelectorCandidates(entry.record?.selectorCandidates || normalizedRecord.selectorCandidates || [], normalizedRecord, selectorStats),
      fallbackSelectorCandidates: uniqueList([...(entry.record?.fallbackSelectorCandidates || []), ...(normalizedRecord?.fallbackSelectorCandidates || []), ...buildFallbackSelectorCandidates(normalizedRecord)], 12),
      replayConfidence: Number(normalizedRecord.replayConfidence || entry.record?.replayConfidence || 0.25),
    },
    replaySuccessCount: Math.max(0, Number(entry.replaySuccessCount || 0)) + (ok ? 1 : 0),
    replayFailureCount: Math.max(0, Number(entry.replayFailureCount || 0)) + (ok ? 0 : 1),
    selectorStats,
    recentFailures,
    replayConfidence: computeReplayConfidence({
      ...entry,
      replaySuccessCount: Math.max(0, Number(entry.replaySuccessCount || 0)) + (ok ? 1 : 0),
      replayFailureCount: Math.max(0, Number(entry.replayFailureCount || 0)) + (ok ? 0 : 1),
      selectorStats,
    }),
    lastSeenAt: new Date().toISOString(),
  };
  hosts[host] = { ...hostEntry, actions, updatedAt: new Date().toISOString() };
  return { ...(store || {}), hosts };
}

export function listLearnedActionsForHost(store = {}, host = '', { eventType = '', limit = 20 } = {}) {
  const actions = Object.values(store?.hosts?.[host]?.actions || {});
  return actions
    .map((entry) => entry?.record ? ({
      ...entry.record,
      observedCount: Number(entry.observedCount || 0),
      replaySuccessCount: Number(entry.replaySuccessCount || 0),
      replayFailureCount: Number(entry.replayFailureCount || 0),
      successRate: computeSuccessRate(entry.replaySuccessCount || 0, entry.replayFailureCount || 0),
      selectorStats: entry.selectorStats || {},
      replayConfidence: Number(entry.replayConfidence || computeReplayConfidence(entry)),
      prioritizedSelectorCandidates: prioritizeSelectorCandidates(entry?.record?.selectorCandidates || [], entry?.record || {}, entry?.selectorStats || {}),
      recentFailures: Array.isArray(entry.recentFailures) ? entry.recentFailures : [],
    }) : null)
    .filter(Boolean)
    .filter((record) => !eventType || record.eventType === eventType)
    .sort((left, right) => {
      const leftScore = Number(left.successRate || 0) * 20 + Number(left.replaySuccessCount || 0) * 4 + Number(left.observedCount || 0) + Number(left.replayConfidence || 0) * 10;
      const rightScore = Number(right.successRate || 0) * 20 + Number(right.replaySuccessCount || 0) * 4 + Number(right.observedCount || 0) + Number(right.replayConfidence || 0) * 10;
      return rightScore - leftScore;
    })
    .slice(0, Math.max(1, Number(limit) || 20));
}

export function scoreReplayRecordForPage(record = {}, pageContext = {}) {
  let score = 0;
  const recordPath = String(record?.pagePath || '').trim().toLowerCase();
  const pagePath = String(pageContext?.pagePath || '').trim().toLowerCase();
  if (recordPath && pagePath) {
    if (recordPath === pagePath) score += 35;
    else if (recordPath.split('/').filter(Boolean).some((part) => pagePath.includes(part))) score += 14;
  }
  const recordTitle = normalizeText(record?.pageTitle || '').toLowerCase();
  const pageTitle = normalizeText(pageContext?.pageTitle || '').toLowerCase();
  if (recordTitle && pageTitle) {
    if (recordTitle === pageTitle) score += 16;
    else if (recordTitle.split(' ').some((term) => term.length >= 4 && pageTitle.includes(term))) score += 8;
  }

  const recordTerms = toComparableSet(record?.structuralTerms || []);
  const pageTerms = toComparableSet(pageContext?.pageTerms || []);
  for (const term of recordTerms) {
    if (pageTerms.has(term)) score += 2;
  }
  if (record?.domVersion && pageContext?.domVersion && record.domVersion === pageContext.domVersion) score += 18;
  const semanticRecord = Array.isArray(record?.semanticEmbedding) ? record.semanticEmbedding : buildSemanticEmbedding(record?.semanticText || buildSemanticText(record));
  const semanticPage = pageContext?.semanticEmbedding || buildSemanticEmbedding(normalizeText([
    pageContext?.pagePath,
    pageContext?.pageTitle,
    ...(Array.isArray(pageContext?.pageTerms) ? pageContext.pageTerms : []),
  ].join(' ')));
  score += Math.max(0, cosineSimilarity(semanticRecord, semanticPage)) * 24;
  score += Math.min(8, Number(record?.replayConfidence || 0) * 8);
  score += Math.min(12, Number(record?.replaySuccessCount || 0) * 3);
  score += Math.min(10, Number(record?.observedCount || 0));
  score -= Math.min(10, Number(record?.replayFailureCount || 0) * 2);
  return score;
}

export function scoreFieldForRecordedInput(field = {}, record = {}) {
  const fieldBlob = normalizeText([
    field?.id,
    field?.name,
    field?.placeholder,
    field?.ariaLabel,
    field?.label,
    field?.type,
    field?.role,
    field?.tag,
    ...(Array.isArray(field?.options) ? field.options.flatMap((option) => [option?.value, option?.text]) : []),
  ].join(' ')).toLowerCase();
  const recordBlob = normalizeText([
    record?.name,
    record?.label,
    record?.placeholder,
    record?.ariaLabel,
    record?.text,
    record?.containerText,
    record?.structuralSignature,
  ].join(' ')).toLowerCase();
  let score = 0;
  if (!fieldBlob || !recordBlob) return score;
  if (fieldBlob === recordBlob) score += 25;
  if (record?.name && fieldBlob.includes(String(record.name).toLowerCase())) score += 18;
  if (record?.label && fieldBlob.includes(String(record.label).toLowerCase())) score += 16;
  if (record?.placeholder && fieldBlob.includes(String(record.placeholder).toLowerCase())) score += 14;
  if (record?.ariaLabel && fieldBlob.includes(String(record.ariaLabel).toLowerCase())) score += 10;
  if (record?.inputType && String(field?.type || '').toLowerCase() === String(record.inputType).toLowerCase()) score += 6;
  const recordTerms = recordBlob.split(/\s+/g).filter((term) => term.length >= 3);
  for (const term of recordTerms) {
    if (fieldBlob.includes(term)) score += 2;
  }
  const fieldSemanticText = normalizeText([
    fieldBlob,
    ...(Array.isArray(field?.options) ? field.options.map((option) => option?.text || option?.value || '') : []),
  ].join(' '));
  const fieldEmbedding = buildSemanticEmbedding(fieldSemanticText);
  const recordEmbedding = Array.isArray(record?.semanticEmbedding) ? record.semanticEmbedding : buildSemanticEmbedding(record?.semanticText || recordBlob);
  const semanticSimilarity = Math.max(0, cosineSimilarity(fieldEmbedding, recordEmbedding));
  score += semanticSimilarity * 18;
  score += jaccardSimilarity(normalizedTokenList([fieldSemanticText], { minLength: 2, max: 32 }), normalizedTokenList([record?.semanticText || recordBlob], { minLength: 2, max: 32 })) * 10;
  if (record?.domVersion && buildDomVersion({
    pagePath: record?.pagePath,
    pageTitle: record?.pageTitle,
    tag: field?.tag,
    inputType: field?.type,
    role: field?.role,
    structuralTerms: normalizedTokenList([fieldBlob], { max: 16 }),
  }) === record.domVersion) {
    score += 5;
  }
  return score;
}

export function buildAttendedReplaySummary(session = {}) {
  const replay = session?.replay || {};
  const actionLog = Array.isArray(session?.actionLog) ? session.actionLog : [];
  const domFailures = Array.isArray(session?.domFailures) ? session.domFailures : [];
  const criticalActions = actionLog.filter((entry) => entry?.critical).length;
  const inputBindings = actionLog.filter((entry) => entry?.eventType === 'change' && entry?.valueBinding).length;
  const replayConfidence = actionLog.length
    ? actionLog.reduce((sum, entry) => sum + Number(entry?.replayConfidence || 0), 0) / Math.max(1, actionLog.length)
    : 0;
  return {
    capturedActions: actionLog.length,
    criticalActions,
    boundInputs: inputBindings,
    replayCandidates: Number(replay?.candidateCount || 0),
    replayApplied: Number(replay?.appliedCount || 0),
    replayFailures: Number(replay?.failureCount || 0),
    replayConfidence: Number(replayConfidence.toFixed(4)),
    domFailures: domFailures.length,
    hitlRequired: Boolean(session?.hitlRequired),
    hitlReason: session?.hitlReason || null,
  };
}
