import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import sqlParserPkg from 'node-sql-parser';
import { chatCompletion } from '../services/llmService.js';
import { getPoolForAccess, writePool } from '../config/db.js';
import { getUserPermissions as getTableLevelUserPermissions } from './access_control_repository.js';
import { buildGarAgentQuery } from '../agents/GAR_agent.js';
import { buildStatisticsAgentQuery } from '../agents/statistics_agent.js';
import { buildAgentSecurityPromptFramework } from '../agents/prompt_security_framework.js';

const { Parser } = sqlParserPkg;
const sqlParser = new Parser();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-jwt-secret';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || '';
const JWT_ISSUER = process.env.JWT_ISSUER || '';
const SECURE_SQL_QUERY_TIMEOUT_MS = Math.max(1500, Number(process.env.SECURE_SQL_QUERY_TIMEOUT_MS || 15000));
const SECURE_SQL_DEFAULT_SELECT_LIMIT = Math.max(1, Number(process.env.SECURE_SQL_DEFAULT_SELECT_LIMIT || 100));
const SECURE_SQL_STRICT_AGENT_POOL = String(process.env.SECURE_SQL_STRICT_AGENT_POOL || 'true').toLowerCase() !== 'false';
const USER_PERMISSION_CACHE_TTL_MS = Math.max(1000, Number(process.env.USER_PERMISSION_CACHE_TTL_MS || 30000));
const AUTH_METRICS_LOG_ENABLED = String(process.env.AUTH_METRICS_LOG_ENABLED || 'false').toLowerCase() === 'true';
const AUTH_METRICS_ENDPOINT_ENABLED = String(process.env.AUTH_METRICS_ENDPOINT_ENABLED || 'false').toLowerCase() === 'true';
const AUTH_METRICS_WINDOW_MS = Math.max(60_000, Number(process.env.AUTH_METRICS_WINDOW_MS || 300_000)); // default 5 min

const userPermissionCache = new Map();

// ---------------------------------------------------------------------------
// Rolling window auth counters
// Each bucket covers one minute. We keep AUTH_METRICS_WINDOW_MS / 60_000 buckets.
// ---------------------------------------------------------------------------
const _AUTH_BUCKET_COUNT = Math.ceil(AUTH_METRICS_WINDOW_MS / 60_000);
const _authCounterBuckets = []; // circular, newest last
let _authCurrentBucketMinute = -1;

function _getOrCreateCurrentBucket() {
  const nowMinute = Math.floor(Date.now() / 60_000);
  if (nowMinute !== _authCurrentBucketMinute) {
    _authCurrentBucketMinute = nowMinute;
    _authCounterBuckets.push({ minute: nowMinute, coarse: 0, exact: 0, cacheHit: 0, cacheMiss: 0 });
    if (_authCounterBuckets.length > _AUTH_BUCKET_COUNT) {
      _authCounterBuckets.shift(); // drop oldest
    }
  }
  return _authCounterBuckets[_authCounterBuckets.length - 1];
}

function _incrementAuthCounter(field = '') {
  if (!AUTH_METRICS_ENDPOINT_ENABLED) return;
  const bucket = _getOrCreateCurrentBucket();
  if (field in bucket) bucket[field]++;
}

export function getAuthMetricsSummary() {
  const windowMs = AUTH_METRICS_WINDOW_MS;
  const cutoffMinute = Math.floor((Date.now() - windowMs) / 60_000);
  const buckets = _authCounterBuckets.filter(b => b.minute >= cutoffMinute);
  const totals = { coarse: 0, exact: 0, cacheHit: 0, cacheMiss: 0 };
  for (const b of buckets) {
    totals.coarse += b.coarse;
    totals.exact += b.exact;
    totals.cacheHit += b.cacheHit;
    totals.cacheMiss += b.cacheMiss;
  }
  return {
    windowMs,
    windowMinutes: Math.round(windowMs / 60_000),
    bucketCount: buckets.length,
    totals,
    cacheHitRate: (totals.cacheHit + totals.cacheMiss) > 0
      ? Number((totals.cacheHit / (totals.cacheHit + totals.cacheMiss)).toFixed(4))
      : null,
    endpointEnabled: AUTH_METRICS_ENDPOINT_ENABLED,
  };
}

function emitAuthMetric(event = '', payload = {}) {
  // Rolling counter increments (always active when endpoint enabled)
  const stage = payload.stage;
  const cacheHit = payload.cacheHit;
  if (AUTH_METRICS_ENDPOINT_ENABLED && stage) {
    _incrementAuthCounter(stage === 'exact' ? 'exact' : 'coarse');
    if (typeof cacheHit === 'boolean') {
      _incrementAuthCounter(cacheHit ? 'cacheHit' : 'cacheMiss');
    }
  }

  if (!AUTH_METRICS_LOG_ENABLED) return;
  try {
    console.info('[auth-metric]', JSON.stringify({
      event: String(event || ''),
      ts: new Date().toISOString(),
      ...payload,
    }));
  } catch {
  }
}

const ALL_DEFINED_AGENTS = [
  'action_agent',
  'classifier_agent',
  'executor',
  'memoryBuffer',
  'memoryTool',
  'planner',
  'query_builder_agent',
  'ragTool',
  'reactAgent',
  'reactExecutionAgent',
  'reflectionAgent',
  'schemaGraph',
  'semantic_rag_agent',
  'sqlTool',
  'sql_rag_agent',
  'supervisor',
  'GAR_agent',
  'statistics_agent',
];

export const DEFAULT_AGENT_PERMISSION_MATRIX = {
  GAR_agent: {
    access_scope: 'read',
    allowed_commands: ['SELECT'],
    allowed_tables: ['nodes', 'relationships', 'attributes'],
    max_select_limit: 120,
    forbidden_commands: ['INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE'],
  },
  semantic_rag_agent: {
    access_scope: 'read',
    allowed_commands: ['SELECT'],
    allowed_tables: ['nodes', 'relationships', 'attributes', 'memories'],
    max_select_limit: 120,
    forbidden_commands: ['INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE'],
  },
  sql_rag_agent: {
    access_scope: 'hybrid',
    allowed_commands: ['SELECT', 'INSERT', 'UPDATE'],
    allowed_tables: ['nodes', 'relationships', 'attributes', 'actions', 'government_requests', 'memories', 'resources_booking'],
    max_select_limit: 200,
    forbidden_commands: ['ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE', 'CREATE ROLE', 'DROP ROLE'],
  },
  statistics_agent: {
    access_scope: 'statistics',
    allowed_commands: ['SELECT'],
    allowed_tables: ['memories', 'government_requests', 'actions', 'nodes', 'relationships', 'attributes', 'resources_booking'],
    max_select_limit: 300,
    forbidden_commands: ['INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE'],
  },
};

const STRICT_AGENT_POOL_BY_NAME = {
  GAR_agent: 'read',
  semantic_rag_agent: 'read',
  statistics_agent: 'statistics',
  sql_rag_agent: 'write',
};

function clonePermissionSnapshot(snapshot = null) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  try {
    return structuredClone(snapshot);
  } catch {
    return JSON.parse(JSON.stringify(snapshot));
  }
}

function buildUserPermissionCacheKey({ userId = '', roleFromJwt = '', includeTablePermissions = true } = {}) {
  const normalizedUserId = String(userId || '').trim().toLowerCase();
  const normalizedRole = String(roleFromJwt || 'viewer').trim().toLowerCase();
  return `${normalizedUserId}::${normalizedRole}::${includeTablePermissions ? 'exact' : 'coarse'}`;
}

function getCachedUserPermissionSnapshot(key = '') {
  const entry = userPermissionCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    userPermissionCache.delete(key);
    return null;
  }
  return clonePermissionSnapshot(entry.value);
}

function setCachedUserPermissionSnapshot(key = '', value = null) {
  if (!key || !value || typeof value !== 'object') return;
  userPermissionCache.set(key, {
    expiresAt: Date.now() + USER_PERMISSION_CACHE_TTL_MS,
    value: clonePermissionSnapshot(value),
  });
}

export function invalidateUserPermissionCache(userId = '') {
  const normalizedUserId = String(userId || '').trim().toLowerCase();
  if (!normalizedUserId) {
    userPermissionCache.clear();
    return;
  }

  for (const key of userPermissionCache.keys()) {
    if (key.startsWith(`${normalizedUserId}::`)) {
      userPermissionCache.delete(key);
    }
  }
}

function normalizeSqlCommand(v = '') {
  return String(v || '').trim().toUpperCase();
}

function cleanIdentifier(v = '') {
  return String(v || '').replace(/^"|"$/g, '').trim();
}

function uniqUpper(arr = []) {
  return Array.from(new Set((arr || []).map((x) => normalizeSqlCommand(x)).filter(Boolean)));
}

function uniqLower(arr = []) {
  return Array.from(new Set((arr || []).map((x) => cleanIdentifier(String(x || '').toLowerCase())).filter(Boolean)));
}

function commandNeedsTableFlag(command = '') {
  const c = normalizeSqlCommand(command);
  if (c === 'SELECT') return 'can_select';
  if (c === 'INSERT') return 'can_insert';
  if (c === 'UPDATE') return 'can_update';
  if (c === 'DELETE') return 'can_delete';
  return null;
}

function deriveTablePermissionSnapshot(rows = []) {
  const tableMatrix = {};
  const accessScopes = new Set();
  const permissionCodes = new Set();
  let canRead = false;
  let canWrite = false;
  let canDelete = false;
  let canStatistics = false;

  for (const row of rows || []) {
    const tableName = cleanIdentifier(String(row?.table_name || '').toLowerCase());
    const accessScope = String(row?.access_scope || '').trim().toLowerCase();
    const permissionCode = String(row?.permission_code || '').trim().toUpperCase();

    if (permissionCode) permissionCodes.add(permissionCode);
    if (accessScope) accessScopes.add(accessScope);

    if (!tableName) continue;
    const canSelect = Boolean(row?.can_select);
    const canInsert = Boolean(row?.can_insert);
    const canUpdate = Boolean(row?.can_update);
    const canDeleteOnTable = Boolean(row?.can_delete);

    const prev = tableMatrix[tableName] || {
      can_select: false,
      can_insert: false,
      can_update: false,
      can_delete: false,
    };

    tableMatrix[tableName] = {
      can_select: prev.can_select || canSelect,
      can_insert: prev.can_insert || canInsert,
      can_update: prev.can_update || canUpdate,
      can_delete: prev.can_delete || canDeleteOnTable,
    };

    canRead = canRead || canSelect;
    canWrite = canWrite || canInsert || canUpdate;
    canDelete = canDelete || canDeleteOnTable;
  }

  if (accessScopes.has('stats') || accessScopes.has('manager')) {
    canStatistics = true;
  }

  return {
    tableMatrix,
    accessScopes: Array.from(accessScopes),
    permissionCodes: Array.from(permissionCodes),
    canRead,
    canWrite,
    canDelete,
    canStatistics,
  };
}

function hashText(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 20);
}

function looksAggregationQuery(text = '') {
  return /count\(|sum\(|avg\(|min\(|max\(|group\s+by|having\s+/i.test(String(text || ''));
}

function parseTokenFromAuthHeader(authHeader = '') {
  const raw = String(authHeader || '').trim();
  if (!/^bearer\s+/i.test(raw)) return '';
  return raw.replace(/^bearer\s+/i, '').trim();
}

export function verifyJwtFromRequest(req) {
  const token = parseTokenFromAuthHeader(req?.headers?.authorization || '');
  if (!token) return { ok: false, reason: 'missing-bearer-token' };

  const verifyOptions = {};
  if (JWT_AUDIENCE) verifyOptions.audience = JWT_AUDIENCE;
  if (JWT_ISSUER) verifyOptions.issuer = JWT_ISSUER;

  try {
    const payload = jwt.verify(token, JWT_SECRET, verifyOptions);
    const userId = String(payload?.sub || payload?.userId || payload?.uid || '').trim();
    const role = String(payload?.role || payload?.userRole || '').trim().toLowerCase() || 'viewer';
    if (!userId) return { ok: false, reason: 'jwt-missing-subject' };
    return {
      ok: true,
      token,
      payload,
      user: {
        userId,
        role,
      },
    };
  } catch (err) {
    return { ok: false, reason: `jwt-invalid:${String(err?.message || err)}` };
  }
}

export async function ensureDefenseInDepthSecurity() {
  const client = await writePool.connect();
  try {
    const requiredTables = [
      'secure_roles',
      'secure_users',
      'secure_role_permissions',
      'secure_agent_permissions',
      'secure_query_logs',
    ];
    const checkRes = await client.query(
      `SELECT t.rel_name
         FROM (
           VALUES ($1::text), ($2::text), ($3::text), ($4::text), ($5::text)
         ) AS t(rel_name)
        WHERE to_regclass('public.' || t.rel_name) IS NULL`,
      requiredTables,
    );
    const missingTables = (checkRes.rows || []).map((r) => String(r.rel_name || '')).filter(Boolean);
    if (missingTables.length > 0) {
      throw new Error(`Missing required security tables: ${missingTables.join(', ')}. Run npm run security:init first.`);
    }

    const roleCountRes = await client.query('SELECT COUNT(*)::int AS cnt FROM secure_roles');
    const rolePermCountRes = await client.query('SELECT COUNT(*)::int AS cnt FROM secure_role_permissions');
    const roleCount = Number(roleCountRes.rows?.[0]?.cnt || 0);
    const rolePermCount = Number(rolePermCountRes.rows?.[0]?.cnt || 0);
    if (roleCount === 0 || rolePermCount === 0) {
      throw new Error('Missing security seed data in secure_roles/secure_role_permissions. Run npm run security:init first.');
    }

    for (const agentName of ALL_DEFINED_AGENTS) {
      const fallback = {
        access_scope: 'read',
        allowed_commands: ['SELECT'],
        allowed_tables: ['nodes', 'relationships', 'attributes', 'memories'],
        max_select_limit: 120,
        forbidden_commands: ['INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE'],
      };
      const cfg = DEFAULT_AGENT_PERMISSION_MATRIX[agentName] || fallback;
      await client.query(
        `INSERT INTO secure_agent_permissions(agent_name, access_scope, allowed_commands, allowed_tables, max_select_limit, forbidden_commands)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (agent_name)
         DO UPDATE SET
           access_scope = EXCLUDED.access_scope,
           allowed_commands = EXCLUDED.allowed_commands,
           allowed_tables = EXCLUDED.allowed_tables,
           max_select_limit = EXCLUDED.max_select_limit,
           forbidden_commands = EXCLUDED.forbidden_commands,
           updated_at = now()`,
        [
          agentName,
          String(cfg.access_scope || 'read'),
          uniqUpper(cfg.allowed_commands || ['SELECT']),
          uniqLower(cfg.allowed_tables || ['nodes']),
          Math.max(1, Number(cfg.max_select_limit || SECURE_SQL_DEFAULT_SELECT_LIMIT)),
          uniqUpper(cfg.forbidden_commands || []),
        ],
      );
    }

    invalidateUserPermissionCache();

    return { ok: true, seededAgents: ALL_DEFINED_AGENTS.length };
  } finally {
    client.release();
  }
}

export async function getUserPermissions(userId, roleFromJwt = '', options = {}) {
  const includeTablePermissions = options?.includeTablePermissions !== false;
  const useCache = options?.useCache !== false;
  const requestSource = String(options?.source || 'unknown');
  const requestedUserId = String(userId || '').trim();
  const cacheKey = buildUserPermissionCacheKey({ userId, roleFromJwt, includeTablePermissions });
  if (useCache) {
    const cached = getCachedUserPermissionSnapshot(cacheKey);
    if (cached) {
      cached.permissionResolution = {
        ...(cached.permissionResolution && typeof cached.permissionResolution === 'object' ? cached.permissionResolution : {}),
        cacheHit: true,
      };
      emitAuthMetric('user_permissions_resolved', {
        source: requestSource,
        userId: requestedUserId,
        stage: String(cached?.resolutionStage || (includeTablePermissions ? 'exact' : 'coarse')),
        cacheHit: true,
      });
      return cached;
    }
  }

  const readClient = await getPoolForAccess('read').connect();
  try {
    const userRes = await readClient.query(
      `SELECT user_id, role_name, active FROM secure_users WHERE user_id = $1`,
      [String(userId || '')],
    );

    let roleName = String(roleFromJwt || 'viewer').toLowerCase();
    let dbUser = null;

    if (userRes.rows.length > 0) {
      dbUser = userRes.rows[0];
      if (dbUser.active === false) {
        return { ok: false, reason: 'user-inactive' };
      }
      roleName = String(dbUser.role_name || roleName).toLowerCase();
    }

    const permRes = await readClient.query(
      `SELECT permission_key, permission_value FROM secure_role_permissions WHERE role_name = $1`,
      [roleName],
    );

    const agentPermRes = await readClient.query(
      `SELECT agent_name, access_scope, allowed_commands, allowed_tables, max_select_limit, forbidden_commands
         FROM secure_agent_permissions`,
      [],
    );

    const rolePermissions = {};
    for (const row of permRes.rows || []) {
      rolePermissions[String(row.permission_key)] = row.permission_value || {};
    }

    const agentPermissions = {};
    for (const row of agentPermRes.rows || []) {
      agentPermissions[String(row.agent_name)] = {
        access_scope: String(row.access_scope || 'read'),
        allowed_commands: uniqUpper(row.allowed_commands || []),
        allowed_tables: uniqLower(row.allowed_tables || []),
        max_select_limit: Math.max(1, Number(row.max_select_limit || SECURE_SQL_DEFAULT_SELECT_LIMIT)),
        forbidden_commands: uniqUpper(row.forbidden_commands || []),
      };
    }

    for (const agentName of ALL_DEFINED_AGENTS) {
      if (agentPermissions[agentName]) continue;
      const fallback = DEFAULT_AGENT_PERMISSION_MATRIX[agentName] || {
        access_scope: 'read',
        allowed_commands: ['SELECT'],
        allowed_tables: ['nodes', 'relationships', 'attributes', 'memories'],
        max_select_limit: 120,
        forbidden_commands: ['INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE'],
      };
      agentPermissions[agentName] = {
        access_scope: String(fallback.access_scope || 'read'),
        allowed_commands: uniqUpper(fallback.allowed_commands || ['SELECT']),
        allowed_tables: uniqLower(fallback.allowed_tables || ['nodes']),
        max_select_limit: Math.max(1, Number(fallback.max_select_limit || SECURE_SQL_DEFAULT_SELECT_LIMIT)),
        forbidden_commands: uniqUpper(fallback.forbidden_commands || []),
      };
    }

    if (!includeTablePermissions) {
      const coarseResult = {
        ok: true,
        resolutionStage: 'coarse',
        permissionResolution: {
          stage: 'coarse',
          cacheHit: false,
        },
        user: {
          userId: String(userId || ''),
          roleName,
        },
        rolePermissions,
        agentPermissions,
        hasDbProfile: Boolean(dbUser),
        tableLevelPermissions: {
          hasTablePermissions: false,
          permissionCodes: [],
          accessScopes: [],
          tableMatrix: {},
        },
      };
      emitAuthMetric('user_permissions_resolved', {
        source: requestSource,
        userId: requestedUserId,
        stage: 'coarse',
        cacheHit: false,
      });
      if (useCache) setCachedUserPermissionSnapshot(cacheKey, coarseResult);
      return coarseResult;
    }

    let tableLevelRows = [];
    try {
      tableLevelRows = await getTableLevelUserPermissions({ userId: String(userId || '') });
    } catch {
      tableLevelRows = [];
    }

    const tableSnapshot = deriveTablePermissionSnapshot(tableLevelRows);
    const hasTablePermissions = tableLevelRows.length > 0;

    rolePermissions.can_read = {
      enabled: Boolean(rolePermissions?.can_read?.enabled) && tableSnapshot.canRead,
    };
    rolePermissions.can_write = {
      enabled: Boolean(rolePermissions?.can_write?.enabled) && (tableSnapshot.canWrite || tableSnapshot.canDelete),
    };
    rolePermissions.can_statistics = {
      enabled: Boolean(rolePermissions?.can_statistics?.enabled) && tableSnapshot.canStatistics,
    };
    rolePermissions.can_delete = {
      enabled: Boolean(rolePermissions?.can_write?.enabled) && tableSnapshot.canDelete,
    };

    for (const [agentName, cfg] of Object.entries(agentPermissions)) {
      const commands = uniqUpper(cfg?.allowed_commands || []);
      const tables = uniqLower(cfg?.allowed_tables || []);

      const filteredTables = tables.filter((tableName) => {
        const grants = tableSnapshot.tableMatrix[tableName];
        if (!grants) return false;
        return grants.can_select || grants.can_insert || grants.can_update || grants.can_delete;
      });

      const filteredCommands = commands.filter((command) => {
        const neededFlag = commandNeedsTableFlag(command);
        if (!neededFlag) return false;
        return filteredTables.some((tableName) => Boolean(tableSnapshot.tableMatrix[tableName]?.[neededFlag]));
      });

      const forbidden = new Set(uniqUpper(cfg?.forbidden_commands || []));
      for (const candidate of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        if (!filteredCommands.includes(candidate)) {
          forbidden.add(candidate);
        }
      }

      agentPermissions[agentName] = {
        ...cfg,
        allowed_tables: filteredTables,
        allowed_commands: filteredCommands,
        forbidden_commands: Array.from(forbidden),
      };
    }

    const exactResult = {
      ok: true,
      resolutionStage: 'exact',
      permissionResolution: {
        stage: 'exact',
        cacheHit: false,
      },
      user: {
        userId: String(userId || ''),
        roleName,
      },
      rolePermissions,
      agentPermissions,
      hasDbProfile: Boolean(dbUser),
      tableLevelPermissions: {
        hasTablePermissions,
        permissionCodes: tableSnapshot.permissionCodes,
        accessScopes: tableSnapshot.accessScopes,
        tableMatrix: tableSnapshot.tableMatrix,
      },
    };
    emitAuthMetric('user_permissions_resolved', {
      source: requestSource,
      userId: requestedUserId,
      stage: 'exact',
      cacheHit: false,
    });
    if (useCache) setCachedUserPermissionSnapshot(cacheKey, exactResult);
    return exactResult;
  } finally {
    readClient.release();
  }
}

export async function ensureExecutionUserPermissions({ userId = '', roleFromJwt = '', currentPermissions = null } = {}) {
  if (currentPermissions?.ok && currentPermissions?.resolutionStage === 'exact') {
    return currentPermissions;
  }

  const effectiveUserId = String(userId || currentPermissions?.user?.userId || '').trim();
  const effectiveRole = String(roleFromJwt || currentPermissions?.user?.roleName || 'viewer').trim().toLowerCase();
  return getUserPermissions(effectiveUserId, effectiveRole, { includeTablePermissions: true });
}

function pickAgentByIntent(userRequest = '', requestedAgent = '') {
  const req = String(userRequest || '').toLowerCase();
  const requested = String(requestedAgent || '').trim();
  if (requested) return requested;
  if (looksAggregationQuery(req) || /stat|aggregate|dashboard|summary|group by|\bhow many\b|\bnumber of\b|\bcount\b/.test(req)) return 'statistics_agent';
  if (/insert|update|delete|book|schedule|create|approve|reject|close/.test(req)) return 'sql_rag_agent';
  if (/read|list|show|find|get|search|who|which|what|count/.test(req)) return 'GAR_agent';
  return 'GAR_agent';
}

function parseAstSummary(sql = '') {
  let ast;
  try {
    ast = sqlParser.astify(sql, { database: 'postgresql' });
  } catch (err) {
    throw new Error(`sql-ast-parse-failed: ${String(err?.message || err)}`);
  }

  const first = Array.isArray(ast) ? ast[0] : ast;
  const type = normalizeSqlCommand(first?.type || 'UNKNOWN');

  const tableSet = new Set();
  try {
    const tableList = sqlParser.tableList(sql, { database: 'postgresql' }) || [];
    for (const item of tableList) {
      const parts = String(item || '').split('::');
      const tableName = parts[2] || parts[1] || parts[0] || '';
      if (tableName) tableSet.add(cleanIdentifier(String(tableName).toLowerCase()));
    }
  } catch {
  }

  const hasLimit = /\blimit\s+\d+/i.test(sql);
  const limitMatch = String(sql || '').match(/\blimit\s+(\d+)/i);
  const limitValue = limitMatch ? Number(limitMatch[1]) : null;

  return {
    ast: first,
    queryType: type,
    tables: Array.from(tableSet),
    isAggregate: looksAggregationQuery(sql),
    hasLimit,
    limitValue: Number.isFinite(limitValue) ? limitValue : null,
  };
}

function enforceSelectLimit(sql = '', maxLimit = SECURE_SQL_DEFAULT_SELECT_LIMIT) {
  const bounded = Math.max(1, Number(maxLimit || SECURE_SQL_DEFAULT_SELECT_LIMIT));
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) return sql;
  if (/\blimit\s+\d+/i.test(sql)) {
    return sql.replace(/\blimit\s+(\d+)/i, (_, n) => `LIMIT ${Math.min(bounded, Math.max(1, Number(n || bounded)))}`);
  }
  return `${String(sql || '').trim()} LIMIT ${bounded}`;
}

function validateGuard({ sql, summary, agentCfg }) {
  const queryType = normalizeSqlCommand(summary?.queryType || 'UNKNOWN');
  const allowedCommands = uniqUpper(agentCfg?.allowed_commands || ['SELECT']);
  const forbiddenCommands = uniqUpper(agentCfg?.forbidden_commands || []);
  const allowedTables = uniqLower(agentCfg?.allowed_tables || []);

  if (forbiddenCommands.includes(queryType)) {
    return { ok: false, reason: `forbidden-command:${queryType}` };
  }

  if (!allowedCommands.includes(queryType)) {
    return { ok: false, reason: `command-not-allowed:${queryType}` };
  }

  for (const t of summary.tables || []) {
    if (!allowedTables.includes(cleanIdentifier(String(t || '').toLowerCase()))) {
      return { ok: false, reason: `table-not-allowed:${t}` };
    }
  }

  if (/;\s*\S+/g.test(String(sql || ''))) {
    return { ok: false, reason: 'multi-statement-not-allowed' };
  }

  return { ok: true };
}

function choosePoolName({ queryType = 'SELECT', selectedAgent = '', agentCfg = {}, summary = {} } = {}) {
  const normalized = normalizeSqlCommand(queryType);
  const scope = String(agentCfg?.access_scope || 'read').toLowerCase();

  if (SECURE_SQL_STRICT_AGENT_POOL) {
    const strictPool = STRICT_AGENT_POOL_BY_NAME[String(selectedAgent || '')];
    if (strictPool === 'statistics') return 'statistics';
    if (strictPool === 'read') return 'read';
    if (strictPool === 'write') {
      if (['INSERT', 'UPDATE', 'DELETE'].includes(normalized)) return 'write';
      if (summary?.isAggregate) return 'statistics';
      return 'read';
    }
  }

  if (scope === 'statistics' || summary?.isAggregate) return 'statistics';
  if (['INSERT', 'UPDATE', 'DELETE'].includes(normalized)) return 'write';
  if (scope === 'hybrid' && normalized === 'SELECT' && summary?.isAggregate) return 'statistics';
  return 'read';
}

function resolvePermissionKeyFromInputs({ permissionKey = '', userRequest = '' } = {}) {
  const direct = String(permissionKey || '').trim().toLowerCase();
  if (direct) return direct;

  const text = String(userRequest || '');
  const match = text.match(/(?:permission[_\s-]*key|perm[_\s-]*key|require[_\s-]*permission)\s*[:=]\s*([a-zA-Z0-9_\-.]+)/i);
  if (!match) return '';
  return String(match[1] || '').trim().toLowerCase();
}

function buildDeterministicFallbackSql({ userRequest, selectedAgent, agentCfg }) {
  const request = String(userRequest || '').toLowerCase();
  const allowedCommands = uniqUpper(agentCfg?.allowed_commands || ['SELECT']);
  const maxLimit = Math.max(1, Number(agentCfg?.max_select_limit || SECURE_SQL_DEFAULT_SELECT_LIMIT));

  if (selectedAgent === 'statistics_agent' && allowedCommands.includes('SELECT')) {
    const built = buildStatisticsAgentQuery({ userRequest, maxLimit });
    return {
      sql: built.sql,
      params: built.params,
      reason: built.reason || 'fallback-statistics-agent',
    };
  }

  if ((selectedAgent === 'GAR_agent' || /read|list|show|find|get|search|who|which|what|count/.test(request)) && allowedCommands.includes('SELECT')) {
    const built = buildGarAgentQuery({ userRequest, maxLimit });
    return {
      sql: built.sql,
      params: built.params,
      reason: built.reason || 'fallback-gar-agent',
    };
  }

  if (allowedCommands.includes('UPDATE') && /update|status|government_request|request/.test(request)) {
    return {
      sql: 'UPDATE government_requests SET status = status WHERE 1 = 0',
      params: [],
      reason: 'fallback-write-safe-noop',
    };
  }

  return {
    sql: `SELECT node_id, title, type FROM nodes ORDER BY node_id LIMIT ${maxLimit}`,
    params: [],
    reason: 'fallback-read-default',
  };
}

async function generateSqlByLlm({ userRequest, userPermissions, selectedAgent }) {
  const agentCfg = userPermissions?.agentPermissions?.[selectedAgent] || {};
  const allowedTables = (agentCfg.allowed_tables || []).join(', ') || 'nodes, relationships, attributes';
  const allowedCommands = (agentCfg.allowed_commands || ['SELECT']).join(', ');
  const maxLimit = Math.max(1, Number(agentCfg.max_select_limit || SECURE_SQL_DEFAULT_SELECT_LIMIT));
  const orchestratorSystemPrompt = [
    'You are a strict secure SQL orchestrator. Return strict JSON only.',
    buildAgentSecurityPromptFramework({
      agentName: 'secure_sql_orchestrator',
      goal: 'Generate SQL that passes guard checks and honors JWT-derived permissions.',
      tools: [
        'Allowed commands/tables and max limit constraints provided in prompt.',
        'PostgreSQL AST guard validation and pool selection are enforced downstream.',
      ],
      outputContract: 'Return JSON only: {"sql":"...","params":[],"reason":"..."}',
    }),
  ].join('\n\n');

  const prompt = [
    'You are a secure SQL generator. Return strict JSON only.',
    `Agent: ${selectedAgent}`,
    `Allowed commands: ${allowedCommands}`,
    `Allowed tables: ${allowedTables}`,
    `Select LIMIT max: ${maxLimit}`,
    'Rules:',
    '- Use PostgreSQL syntax.',
    '- Use prepared-statement placeholders ($1, $2...) when user data appears.',
    '- Never generate disallowed commands or tables.',
    '- Return one SQL statement only.',
    '- Keep query minimal.',
    'Return JSON schema exactly:',
    '{"sql":"...","params":[],"reason":"..."}',
    `User request: ${userRequest}`,
  ].join('\n');

  let raw = '';
  try {
    raw = await chatCompletion({
      messages: [
        { role: 'system', content: orchestratorSystemPrompt },
        { role: 'user', content: prompt },
      ],
      max_tokens: 350,
      temperature: 0,
    });
  } catch (err) {
    const fallback = buildDeterministicFallbackSql({ userRequest, selectedAgent, agentCfg });
    return {
      sql: fallback.sql,
      params: fallback.params,
      reason: `fallback-llm-unavailable:${String(err?.message || err).slice(0, 220)}`,
    };
  }

  const text = String(raw || '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  let parsed = null;
  try {
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch {
    const fallback = buildDeterministicFallbackSql({ userRequest, selectedAgent, agentCfg });
    return { sql: fallback.sql, params: fallback.params, reason: 'fallback-json-parse-failed' };
  }

  const sql = String(parsed?.sql || '').trim();
  const params = Array.isArray(parsed?.params) ? parsed.params : [];
  const reason = String(parsed?.reason || '').slice(0, 600);
  if (!sql) {
    const fallback = buildDeterministicFallbackSql({ userRequest, selectedAgent, agentCfg });
    return { sql: fallback.sql, params: fallback.params, reason: 'fallback-empty-sql' };
  }
  return { sql, params, reason };
}

async function logSecureQuery({ userId, roleName, agentName, poolName, queryType, sqlText, params, guardAllowed, guardReason, rowCount }) {
  try {
    await writePool.query(
      `INSERT INTO secure_query_logs(user_id, role_name, agent_name, pool_name, query_type, sql_text, sql_params, guard_allowed, guard_reason, row_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        String(userId || ''),
        String(roleName || ''),
        String(agentName || ''),
        String(poolName || ''),
        String(queryType || ''),
        String(sqlText || ''),
        JSON.stringify(Array.isArray(params) ? params : []),
        Boolean(guardAllowed),
        guardReason ? String(guardReason).slice(0, 800) : null,
        Number.isFinite(Number(rowCount)) ? Number(rowCount) : null,
      ],
    );
  } catch {
  }
}

export async function runSecureAgentSqlFlow({ userRequest, jwtUser, userPermissions, requestedAgent = '', permissionKey = '' } = {}) {
  const effectivePermissions = await ensureExecutionUserPermissions({
    userId: jwtUser?.userId,
    roleFromJwt: jwtUser?.role,
    currentPermissions: userPermissions,
  });
  if (!effectivePermissions?.ok) {
    return {
      ok: false,
      selectedAgent: pickAgentByIntent(userRequest, requestedAgent),
      guard: { ok: false, reason: effectivePermissions?.reason || 'permissions-unavailable' },
    };
  }

  const selectedAgent = pickAgentByIntent(userRequest, requestedAgent);
  const agentCfg = effectivePermissions?.agentPermissions?.[selectedAgent];
  if (!agentCfg) {
    throw new Error(`No permissions defined for selected agent: ${selectedAgent}`);
  }

  if (!effectivePermissions?.tableLevelPermissions?.hasTablePermissions) {
    return {
      ok: false,
      selectedAgent,
      guard: { ok: false, reason: 'no-table-permissions' },
    };
  }

  const rolePerms = effectivePermissions?.rolePermissions || {};
  const canRead = Boolean(rolePerms?.can_read?.enabled);
  const canWrite = Boolean(rolePerms?.can_write?.enabled);
  const canStats = Boolean(rolePerms?.can_statistics?.enabled);
  const requiredPermissionKey = resolvePermissionKeyFromInputs({ permissionKey, userRequest });

  if (requiredPermissionKey) {
    const permissionEntry = rolePerms?.[requiredPermissionKey];
    const permissionEnabled = Boolean(permissionEntry?.enabled === true);
    if (!permissionEnabled) {
      return {
        ok: false,
        selectedAgent,
        guard: { ok: false, reason: `permission-key-denied:${requiredPermissionKey}` },
        requiredPermissionKey,
      };
    }
  }

  const generated = await generateSqlByLlm({ userRequest, userPermissions: effectivePermissions, selectedAgent });
  const sqlWithLimit = enforceSelectLimit(generated.sql, Number(agentCfg.max_select_limit || SECURE_SQL_DEFAULT_SELECT_LIMIT));
  const summary = parseAstSummary(sqlWithLimit);

  const guard = validateGuard({ sql: sqlWithLimit, summary, agentCfg });
  if (!guard.ok) {
    await logSecureQuery({
      userId: jwtUser?.userId,
      roleName: jwtUser?.role,
      agentName: selectedAgent,
      poolName: 'n/a',
      queryType: summary.queryType,
      sqlText: sqlWithLimit,
      params: generated.params,
      guardAllowed: false,
      guardReason: guard.reason,
      rowCount: 0,
    });
    return {
      ok: false,
      selectedAgent,
      guard,
      querySummary: summary,
      generated: { sql: sqlWithLimit, params: generated.params, reason: generated.reason },
    };
  }

  const poolName = choosePoolName({ queryType: summary.queryType, selectedAgent, agentCfg, summary });
  if (poolName === 'read' && !canRead) return { ok: false, selectedAgent, guard: { ok: false, reason: 'role-cannot-read' } };
  if (poolName === 'write' && !canWrite) return { ok: false, selectedAgent, guard: { ok: false, reason: 'role-cannot-write' } };
  if (poolName === 'statistics' && !canStats) return { ok: false, selectedAgent, guard: { ok: false, reason: 'role-cannot-statistics' } };

  const targetPool = getPoolForAccess(poolName);
  const queryName = `secure_${poolName}_${selectedAgent}_${hashText(sqlWithLimit)}`;

  const result = await targetPool.query({
    name: queryName,
    text: sqlWithLimit,
    values: Array.isArray(generated.params) ? generated.params : [],
    rowMode: 'array',
  });

  await logSecureQuery({
    userId: jwtUser?.userId,
    roleName: jwtUser?.role,
    agentName: selectedAgent,
    poolName,
    queryType: summary.queryType,
    sqlText: sqlWithLimit,
    params: generated.params,
    guardAllowed: true,
    guardReason: 'allowed',
    rowCount: result?.rowCount || 0,
  });

  return {
    ok: true,
    selectedAgent,
    poolName,
    guard,
    querySummary: summary,
    generated: { sql: sqlWithLimit, params: generated.params, reason: generated.reason },
    result: {
      rowCount: result?.rowCount || 0,
      fields: (result?.fields || []).map((f) => f.name),
      rows: result?.rows || [],
    },
    rolePermissions: {
      canRead,
      canWrite,
      canStatistics: canStats,
    },
    requiredPermissionKey: requiredPermissionKey || null,
  };
}
