

import pkg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

// Debug: Print relevant DB env variables
console.log('[DB DEBUG] Loaded env:', {
  READ_DB_USER: process.env.READ_DB_USER,
  READ_DB_HOST: process.env.READ_DB_HOST,
  READ_DB_NAME: process.env.READ_DB_NAME,
  READ_DB_PASSWORD: process.env.READ_DB_PASSWORD,
  READ_DB_PORT: process.env.READ_DB_PORT,
  WRITE_DB_USER: process.env.WRITE_DB_USER,
  WRITE_DB_HOST: process.env.WRITE_DB_HOST,
  WRITE_DB_NAME: process.env.WRITE_DB_NAME,
  WRITE_DB_PASSWORD: process.env.WRITE_DB_PASSWORD,
  WRITE_DB_PORT: process.env.WRITE_DB_PORT,
  DB_USER: process.env.DB_USER,
  DB_HOST: process.env.DB_HOST,
  DB_NAME: process.env.DB_NAME,
  DB_PASSWORD: process.env.DB_PASSWORD,
  DB_PORT: process.env.DB_PORT,
});

const { Pool } = pkg;

// Separate read and write pools
export const readPool = new Pool({
  user: process.env.READ_DB_USER || process.env.DB_USER || 'sso_user',
  host: process.env.READ_DB_HOST || process.env.DB_HOST || 'localhost',
  database: process.env.READ_DB_NAME || process.env.DB_NAME || 'sso_db',
  password: process.env.READ_DB_PASSWORD || process.env.DB_PASSWORD || 'sso_pass',
  port: parseInt(process.env.READ_DB_PORT || process.env.DB_PORT || '5433', 10),
});

export const writePool = new Pool({
  user: process.env.WRITE_DB_USER || process.env.DB_USER || 'sso_user',
  host: process.env.WRITE_DB_HOST || process.env.DB_HOST || 'localhost',
  database: process.env.WRITE_DB_NAME || process.env.DB_NAME || 'sso_db',
  password: process.env.WRITE_DB_PASSWORD || process.env.DB_PASSWORD || 'sso_pass',
  port: parseInt(process.env.WRITE_DB_PORT || process.env.DB_PORT || '5433', 10),
});

// Read service function
export async function executeReadQuery(sql, params = []) {
  const client = await readPool.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows;
  } finally {
    client.release();
  }
}

// Write service function
export async function executeWriteQuery(sql, params = []) {
  const client = await writePool.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows;
  } finally {
    client.release();
  }
}

// Buffer memory for recent queries/results (stub)
const bufferMemory = [];
export function addToBufferMemory(entry) {
  bufferMemory.push({ ...entry, timestamp: Date.now() });
  // Clean up old entries if needed
  if (bufferMemory.length > 1000) bufferMemory.shift();
}
export function getBufferMemory() {
  return bufferMemory;
}

// Simple cache for query results (stub)
const queryCache = new Map();
export function cacheQueryResult(key, value) {
  queryCache.set(key, { value, timestamp: Date.now() });
  // Optionally implement cache eviction/TTL
}
export function getCachedQueryResult(key) {
  const entry = queryCache.get(key);
  // Optionally check TTL/expiration
  return entry ? entry.value : null;
}
