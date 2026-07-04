import pkg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pkg;

function toInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function poolOptionsFromEnv({
  userEnv = 'DB_USER',
  passwordEnv = 'DB_PASSWORD',
  hostEnv = 'DB_HOST',
  nameEnv = 'DB_NAME',
  portEnv = 'DB_PORT',
  maxEnv = 'DB_POOL_MAX',
  idleEnv = 'DB_POOL_IDLE_TIMEOUT_MS',
  connTimeoutEnv = 'DB_POOL_CONNECTION_TIMEOUT_MS',
} = {}) {
  return {
    user: process.env[userEnv] || process.env.DB_USER || 'sso_user',
    host: process.env[hostEnv] || process.env.DB_HOST || 'localhost',
    database: process.env[nameEnv] || process.env.DB_NAME || 'sso_db',
    password: process.env[passwordEnv] || process.env.DB_PASSWORD || 'sso_pass',
    port: toInt(process.env[portEnv] || process.env.DB_PORT || '5433', 5433),
    max: Math.max(1, toInt(process.env[maxEnv] || process.env.DB_POOL_MAX || '10', 10)),
    idleTimeoutMillis: Math.max(1000, toInt(process.env[idleEnv] || process.env.DB_POOL_IDLE_TIMEOUT_MS || '30000', 30000)),
    connectionTimeoutMillis: Math.max(1000, toInt(process.env[connTimeoutEnv] || process.env.DB_POOL_CONNECTION_TIMEOUT_MS || '10000', 10000)),
  };
}

export const pool = new Pool(poolOptionsFromEnv());

export const readPool = new Pool(poolOptionsFromEnv({
  userEnv: 'DB_READ_USER',
  passwordEnv: 'DB_READ_PASSWORD',
  hostEnv: 'DB_READ_HOST',
  nameEnv: 'DB_READ_NAME',
  portEnv: 'DB_READ_PORT',
  maxEnv: 'DB_READ_POOL_MAX',
  idleEnv: 'DB_READ_POOL_IDLE_TIMEOUT_MS',
  connTimeoutEnv: 'DB_READ_POOL_CONNECTION_TIMEOUT_MS',
}));

export const writePool = new Pool(poolOptionsFromEnv({
  userEnv: 'DB_WRITE_USER',
  passwordEnv: 'DB_WRITE_PASSWORD',
  hostEnv: 'DB_WRITE_HOST',
  nameEnv: 'DB_WRITE_NAME',
  portEnv: 'DB_WRITE_PORT',
  maxEnv: 'DB_WRITE_POOL_MAX',
  idleEnv: 'DB_WRITE_POOL_IDLE_TIMEOUT_MS',
  connTimeoutEnv: 'DB_WRITE_POOL_CONNECTION_TIMEOUT_MS',
}));

export const statisticsPool = new Pool(poolOptionsFromEnv({
  userEnv: 'DB_STATS_USER',
  passwordEnv: 'DB_STATS_PASSWORD',
  hostEnv: 'DB_STATS_HOST',
  nameEnv: 'DB_STATS_NAME',
  portEnv: 'DB_STATS_PORT',
  maxEnv: 'DB_STATS_POOL_MAX',
  idleEnv: 'DB_STATS_POOL_IDLE_TIMEOUT_MS',
  connTimeoutEnv: 'DB_STATS_POOL_CONNECTION_TIMEOUT_MS',
}));

export function getPoolForAccess(access = 'read') {
  const mode = String(access || 'read').toLowerCase();
  if (mode === 'write') return writePool;
  if (mode === 'statistics' || mode === 'stats') return statisticsPool;
  return readPool;
}

export const dbPools = {
  read: readPool,
  write: writePool,
  statistics: statisticsPool,
};

export function getPoolSummary(access = 'read') {
  const selectedPool = access === 'default' ? pool : getPoolForAccess(access);
  const options = selectedPool?.options || {};
  return {
    access: access === 'default' ? 'default' : String(access || 'read').toLowerCase(),
    max: Number(options.max || 0),
    idleTimeoutMillis: Number(options.idleTimeoutMillis || 0),
    connectionTimeoutMillis: Number(options.connectionTimeoutMillis || 0),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForDatabaseReady({
  access = 'read',
  attempts = Math.max(1, toInt(process.env.DB_READY_MAX_ATTEMPTS || '8', 8)),
  initialDelayMs = Math.max(250, toInt(process.env.DB_READY_INITIAL_DELAY_MS || '750', 750)),
  backoffFactor = Math.max(1, Number(process.env.DB_READY_BACKOFF_FACTOR || '1.5') || 1.5),
  sql = 'SELECT 1 AS ok',
} = {}) {
  const selectedPool = access === 'default' ? pool : getPoolForAccess(access);
  let lastError = null;
  let delayMs = initialDelayMs;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await selectedPool.query(sql);
      return {
        ok: true,
        access: access === 'default' ? 'default' : String(access || 'read').toLowerCase(),
        attempts: attempt,
        pool: getPoolSummary(access),
      };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      await sleep(delayMs);
      delayMs = Math.max(delayMs, Math.round(delayMs * backoffFactor));
    }
  }

  return {
    ok: false,
    access: access === 'default' ? 'default' : String(access || 'read').toLowerCase(),
    attempts,
    pool: getPoolSummary(access),
    error: lastError?.message || String(lastError || 'database-not-ready'),
  };
}

export default pool;
