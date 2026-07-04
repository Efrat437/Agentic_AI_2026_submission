import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getPoolForAccess } from '../config/db.js';

const SQL_INGEST_BOOTSTRAP_TTL_MS = Math.max(10000, parseInt(process.env.SQL_INGEST_BOOTSTRAP_TTL_MS || '600000', 10));

let sqlIngestBootstrapState = {
  runningPromise: null,
  lastRunAt: 0,
  lastResult: null,
};

function normalizeDistinctTextList(items = []) {
  return Array.from(new Set((Array.isArray(items) ? items : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)));
}

function isSafeSqlIdentifier(name) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(name || ''));
}

export function createClient() {
  const readPool = getPoolForAccess('read');
  const writePool = getPoolForAccess('write');

  function pickPoolByQuery(q = '') {
    const sql = String(q || '').trim().toUpperCase();
    if (sql.startsWith('SELECT') || sql.startsWith('WITH') || sql.startsWith('SHOW') || sql.startsWith('EXPLAIN')) {
      return readPool;
    }
    return writePool;
  }

  return {
    async connect() {
      return this;
    },
    async query(queryTextOrConfig, values) {
      const sqlText = typeof queryTextOrConfig === 'string' ? queryTextOrConfig : String(queryTextOrConfig?.text || '');
      const pool = pickPoolByQuery(sqlText);
      if (typeof queryTextOrConfig === 'string') {
        return pool.query(queryTextOrConfig, values);
      }
      return pool.query(queryTextOrConfig);
    },
    async end() {
    },
  };
}

export async function ensureMemoriesTable() {
  const client = createClient();
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id bigserial PRIMARY KEY,
        user_id text,
        agent text,
        query text,
        response jsonb,
        created_at timestamptz DEFAULT now()
      );
    `);
  } finally {
    await client.end();
  }
}

export async function saveMemory({ userId, agent, query, response }) {
  const client = createClient();
  await client.connect();
  try {
    await client.query(
      `INSERT INTO memories (user_id, agent, query, response) VALUES ($1, $2, $3, $4)`,
      [userId || null, agent, query, JSON.stringify(response)]
    );
  } finally {
    await client.end();
  }
}

export async function getRecentMemories({ userId = null, agent = null, limit = 8 } = {}) {
  const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 8));
  const client = createClient();
  await client.connect();
  try {
    const hasUser = userId !== null && userId !== undefined && String(userId) !== '';
    const hasAgent = agent !== null && agent !== undefined && String(agent) !== '';

    if (hasUser && hasAgent) {
      const res = await client.query(
        `SELECT id, user_id, agent, query, response, created_at
         FROM memories
         WHERE user_id = $1 AND agent = $2
         ORDER BY id DESC
         LIMIT $3`,
        [String(userId), String(agent), boundedLimit]
      );
      return res.rows;
    }

    if (hasUser) {
      const res = await client.query(
        `SELECT id, user_id, agent, query, response, created_at
         FROM memories
         WHERE user_id = $1
         ORDER BY id DESC
         LIMIT $2`,
        [String(userId), boundedLimit]
      );
      return res.rows;
    }

    if (hasAgent) {
      const res = await client.query(
        `SELECT id, user_id, agent, query, response, created_at
         FROM memories
         WHERE agent = $1
         ORDER BY id DESC
         LIMIT $2`,
        [String(agent), boundedLimit]
      );
      return res.rows;
    }

    const res = await client.query(
      `SELECT id, user_id, agent, query, response, created_at
       FROM memories
       ORDER BY id DESC
       LIMIT $1`,
      [boundedLimit]
    );
    return res.rows;
  } finally {
    await client.end();
  }
}

export async function ensureActionsTable() {
  const client = createClient();
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS actions (
        id bigserial PRIMARY KEY,
        agent text,
        user_query text,
        proposed_sql text,
        params jsonb,
        status text DEFAULT 'proposed',
        result jsonb,
        created_at timestamptz DEFAULT now(),
        executed_at timestamptz
      );
    `);
  } finally {
    await client.end();
  }
}

export async function ensureGovernmentRequestsTable() {
  const client = createClient();
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS government_requests (
        id bigserial PRIMARY KEY,
        user_id text,
        description text NOT NULL,
        status text NOT NULL DEFAULT 'new',
        notes jsonb,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      );
    `);

    await client.query(`
      ALTER TABLE government_requests
      ALTER COLUMN notes TYPE jsonb
      USING CASE
        WHEN notes IS NULL THEN NULL
        WHEN pg_typeof(notes)::text = 'jsonb' THEN notes
        ELSE to_jsonb(notes)
      END;
    `).catch(() => {
      // Keep table usable even if type migration is not needed or fails on old installs.
    });
  } finally {
    await client.end();
  }
}

export const GOVERNMENT_REQUEST_STATUSES = ['new', 'in_progress', 'approved', 'rejected', 'closed'];

function normalizeGovernmentRequestStatus(status) {
  return String(status || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizeOptionalText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function normalizeOptionalJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  const text = String(value).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function mergeGovernmentRequestNotes(existingNotes, incomingNotes) {
  const current = normalizeOptionalJson(existingNotes) || {};
  const incoming = normalizeOptionalJson(incomingNotes);
  if (!incoming) return Object.keys(current).length ? current : null;
  if (Array.isArray(current) || Array.isArray(incoming)) {
    return incoming;
  }
  if (typeof current === 'object' && typeof incoming === 'object') {
    return { ...current, ...incoming };
  }
  return incoming;
}

export async function createGovernmentRequest({ userId = null, description, status = 'new', notes = null } = {}) {
  const normalizedDescription = normalizeOptionalText(description);
  if (!normalizedDescription) {
    throw new Error('description is required');
  }
  const normalizedStatus = normalizeGovernmentRequestStatus(status || 'new');
  if (!GOVERNMENT_REQUEST_STATUSES.includes(normalizedStatus)) {
    throw new Error(`status must be one of: ${GOVERNMENT_REQUEST_STATUSES.join(', ')}`);
  }
  const normalizedNotes = normalizeOptionalJson(notes);
  const client = createClient();
  await client.connect();
  try {
    const res = await client.query(
      `INSERT INTO government_requests (user_id, description, status, notes) VALUES ($1, $2, $3, $4) RETURNING id, user_id, description, status, notes, created_at, updated_at`,
      [userId, normalizedDescription, normalizedStatus, normalizedNotes ? JSON.stringify(normalizedNotes) : null]
    );
    return res.rows[0];
  } finally {
    await client.end();
  }
}

export async function getGovernmentRequestById(id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new Error('id must be a positive integer');
  }
  const client = createClient();
  await client.connect();
  try {
    const res = await client.query(
      `SELECT id, user_id, description, status, notes, created_at, updated_at FROM government_requests WHERE id = $1`,
      [numericId]
    );
    return res.rows[0] || null;
  } finally {
    await client.end();
  }
}

export async function updateGovernmentRequestStatus({ id, status, notes = null } = {}) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new Error('id must be a positive integer');
  }
  const normalizedStatus = normalizeGovernmentRequestStatus(status);
  if (!normalizedStatus) {
    throw new Error('status is required');
  }
  if (!GOVERNMENT_REQUEST_STATUSES.includes(normalizedStatus)) {
    throw new Error(`status must be one of: ${GOVERNMENT_REQUEST_STATUSES.join(', ')}`);
  }
  const client = createClient();
  await client.connect();
  try {
    const currentRes = await client.query(
      `SELECT notes FROM government_requests WHERE id = $1`,
      [numericId]
    );
    const existing = currentRes.rows[0] || null;
    if (!existing) {
      return null;
    }
    const mergedNotes = mergeGovernmentRequestNotes(existing.notes, notes);
    const res = await client.query(
      `UPDATE government_requests SET status = $1, notes = COALESCE($2, notes), updated_at = now() WHERE id = $3 RETURNING id, user_id, description, status, notes, created_at, updated_at`,
      [normalizedStatus, mergedNotes ? JSON.stringify(mergedNotes) : null, numericId]
    );
    return res.rows[0] || null;
  } finally {
    await client.end();
  }
}

export async function saveProposedAction({ agent, user_query, proposed_sql, params }) {
  const client = createClient();
  await client.connect();
  try {
    const res = await client.query(
      `INSERT INTO actions (agent, user_query, proposed_sql, params) VALUES ($1, $2, $3, $4) RETURNING id`,
      [agent, user_query, proposed_sql, JSON.stringify(params || [])]
    );
    return res.rows[0].id;
  } finally {
    await client.end();
  }
}

export async function getActionById(id) {
  const client = createClient();
  await client.connect();
  try {
    const res = await client.query(`SELECT * FROM actions WHERE id = $1`, [id]);
    return res.rows[0];
  } finally {
    await client.end();
  }
}

export async function updateActionStatus(id, status, result) {
  const client = createClient();
  await client.connect();
  try {
    await client.query(`UPDATE actions SET status = $1, result = $2, executed_at = now() WHERE id = $3`, [status, result ? JSON.stringify(result) : null, id]);
  } finally {
    await client.end();
  }
}

export function resetSqlIngestBootstrapState() {
  sqlIngestBootstrapState = {
    runningPromise: null,
    lastRunAt: 0,
    lastResult: null,
  };
  return { ok: true };
}

export async function cleanupEvaluationArtifacts({ userIds = [], markers = [] } = {}) {
  const normalizedUserIds = normalizeDistinctTextList(userIds);
  const normalizedMarkers = normalizeDistinctTextList(markers);
  const likePatterns = normalizedMarkers.map((item) => `%${item}%`);
  const deleted = {
    memories: 0,
    actions: 0,
    governmentRequests: 0,
  };

  const client = createClient();
  await client.connect();
  try {
    if (normalizedUserIds.length > 0 || likePatterns.length > 0) {
      const params = [];
      const clauses = [];

      if (normalizedUserIds.length > 0) {
        params.push(normalizedUserIds);
        clauses.push(`user_id = ANY($${params.length}::text[])`);
      }
      if (likePatterns.length > 0) {
        params.push(likePatterns);
        const p = `$${params.length}::text[]`;
        clauses.push(`coalesce(query, '') ILIKE ANY(${p})`);
        clauses.push(`coalesce(response::text, '') ILIKE ANY(${p})`);
      }

      const res = await client.query(
        `WITH deleted_rows AS (
           DELETE FROM memories
           WHERE ${clauses.join(' OR ')}
           RETURNING 1
         )
         SELECT COUNT(*)::int AS cnt FROM deleted_rows`,
        params,
      );
      deleted.memories = Number(res.rows?.[0]?.cnt || 0);
    }

    if (likePatterns.length > 0) {
      const res = await client.query(
        `WITH deleted_rows AS (
           DELETE FROM actions
           WHERE coalesce(agent, '') ILIKE ANY($1::text[])
              OR coalesce(user_query, '') ILIKE ANY($1::text[])
              OR coalesce(proposed_sql, '') ILIKE ANY($1::text[])
              OR coalesce(params::text, '') ILIKE ANY($1::text[])
              OR coalesce(to_jsonb(actions)::text, '') ILIKE ANY($1::text[])
           RETURNING 1
         )
         SELECT COUNT(*)::int AS cnt FROM deleted_rows`,
        [likePatterns],
      );
      deleted.actions = Number(res.rows?.[0]?.cnt || 0);
    }

    if (normalizedUserIds.length > 0 || likePatterns.length > 0) {
      const params = [];
      const clauses = [];

      if (normalizedUserIds.length > 0) {
        params.push(normalizedUserIds);
        clauses.push(`user_id = ANY($${params.length}::text[])`);
      }
      if (likePatterns.length > 0) {
        params.push(likePatterns);
        const p = `$${params.length}::text[]`;
        clauses.push(`coalesce(description, '') ILIKE ANY(${p})`);
        clauses.push(`coalesce(notes::text, '') ILIKE ANY(${p})`);
      }

      const res = await client.query(
        `WITH deleted_rows AS (
           DELETE FROM government_requests
           WHERE ${clauses.join(' OR ')}
           RETURNING 1
         )
         SELECT COUNT(*)::int AS cnt FROM deleted_rows`,
        params,
      );
      deleted.governmentRequests = Number(res.rows?.[0]?.cnt || 0);
    }
  } finally {
    await client.end();
  }

  return {
    ok: true,
    userIds: normalizedUserIds,
    markers: normalizedMarkers,
    deleted,
    sqlIngestBootstrapReset: resetSqlIngestBootstrapState(),
  };
}

export const mapAgentToContext = {
  agent_1: { table: 'schemas_vector' },
  agent_2: { table: 'html_city_page' }
};

// Load one or more .sql files into the database. This helper reads each file and executes
// statements sequentially. It's tolerant of multiple statements per file by splitting on `;`.
export async function loadSqlFilesToDb(filePaths = []) {
  const client = createClient();
  await client.connect();
  try {
    // Keep imports bounded so a bad statement does not hang indefinitely.
    await client.query("SET statement_timeout = '120s'");
    await client.query("SET lock_timeout = '15s'");
    for (const p of filePaths) {
      const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
      if (!fs.existsSync(abs)) {
        console.warn(`SQL file not found, skipping: ${abs}`);
        continue;
      }
      const sql = fs.readFileSync(abs, 'utf8');
      // Split on semicolon/newline boundaries with Windows/Linux line endings.
      const stmts = sql.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean);
      console.log(`Loading SQL file ${abs} (${stmts.length} statements)`);

      // Large generated SQL files are much faster as one round-trip.
      if (stmts.length > 2000) {
        try {
          await client.query(sql);
          continue;
        } catch (err) {
          console.warn(`Bulk execution failed for ${p}, falling back to statement mode:`, (err && err.message) || err);
        }
      }

      for (const s of stmts) {
        try {
          await client.query(s);
        } catch (err) {
          // continue on errors but surface them in logs
          console.warn(`Failed executing statement from ${p}:`, (err && err.message) || err);
        }
      }
    }
  } finally {
    await client.end();
  }
}

// Ingest rows from specified SQL tables into the centralized rag_documents store
export async function ingestSqlTablesToRag({ tables = ['attributes', 'nodes', 'relationships'], truncate = false } = {}) {
  const client = createClient();
  await client.connect();
  try {
    const safeTables = Array.from(new Set((Array.isArray(tables) ? tables : [])
      .map((t) => String(t || '').trim())
      .filter((t) => isSafeSqlIdentifier(t))));

    if (safeTables.length === 0) {
      return { inserted: 0, scannedTables: 0, skippedTables: Array.isArray(tables) ? tables : [] };
    }

    const docs = [];
    const skippedTables = [];
    for (const table of safeTables) {
      try {
        const res = await client.query(`SELECT * FROM ${table}`);
        const rows = res.rows || [];
        for (const row of rows) {
          const parts = [];
          const metadata = { sourceTable: table };
          let rowId = null;
          for (const [k, v] of Object.entries(row)) {
            if (k.toLowerCase() === 'id' || k.toLowerCase().endsWith('_id') || k.toLowerCase() === 'gid') rowId = v;
            if (v === null || v === undefined) continue;
            if (typeof v === 'object') {
              // JSONB or nested object
              try { metadata[k] = v; } catch (e) { metadata[k] = JSON.stringify(v); }
              try { parts.push(JSON.stringify(v)); } catch (e) { parts.push(String(v)); }
            } else {
              // primitive
              const s = String(v);
              // keep long text but truncate in metadata to avoid huge entries
              if (s.length > 2000) {
                parts.push(s.slice(0, 2000));
                metadata[k] = s.slice(0, 1000);
              } else {
                parts.push(s);
                metadata[k] = s;
              }
            }
          }
          if (rowId !== null) metadata.rowId = rowId;
          const pageContent = parts.join(' \n ');
          docs.push({ pageContent, metadata });
        }
      } catch (err) {
        console.warn(`Warning: could not read table ${table}: ${err && err.message ? err.message : err}`);
        skippedTables.push(table);
        // continue with next table
      }
    }

    if (docs.length === 0) return { inserted: 0, scannedTables: safeTables.length, skippedTables };

    // dynamically import semantic_rag_agent to avoid circular imports
    const ragMod = await import('./semantic_rag_agent.js');
    if (!ragMod.addDocumentsToRag) throw new Error('semantic_rag_agent.addDocumentsToRag not available');

    // call addDocumentsToRag in batches to avoid huge single insert
    const BATCH = parseInt(process.env.INGEST_BATCH_SIZE || '200', 10);
    let inserted = 0;
    for (let i = 0; i < docs.length; i += BATCH) {
      const batch = docs.slice(i, i + BATCH);
      const res = await ragMod.addDocumentsToRag(batch, { truncate: truncate && i === 0 });
      inserted += res.inserted || 0;
    }

    return { inserted, scannedTables: safeTables.length, skippedTables };
  } finally {
    await client.end();
  }
}

export async function ensureSqlTablesIngestedToRag({
  enabled = true,
  tables = ['attributes', 'nodes', 'relationships'],
  truncate = false,
  ttlMs = SQL_INGEST_BOOTSTRAP_TTL_MS,
  force = false,
} = {}) {
  if (!enabled) {
    return { skipped: true, reason: 'disabled' };
  }

  const now = Date.now();
  if (!force && sqlIngestBootstrapState.lastRunAt > 0 && now - sqlIngestBootstrapState.lastRunAt < Math.max(0, Number(ttlMs) || 0)) {
    return {
      skipped: true,
      reason: 'ttl-active',
      lastRunAt: sqlIngestBootstrapState.lastRunAt,
      ...((sqlIngestBootstrapState.lastResult && typeof sqlIngestBootstrapState.lastResult === 'object') ? sqlIngestBootstrapState.lastResult : {}),
    };
  }

  if (sqlIngestBootstrapState.runningPromise) {
    return sqlIngestBootstrapState.runningPromise;
  }

  sqlIngestBootstrapState.runningPromise = (async () => {
    try {
      const result = await ingestSqlTablesToRag({ tables, truncate });
      sqlIngestBootstrapState.lastRunAt = Date.now();
      sqlIngestBootstrapState.lastResult = result;
      return {
        skipped: false,
        lastRunAt: sqlIngestBootstrapState.lastRunAt,
        ...((result && typeof result === 'object') ? result : {}),
      };
    } finally {
      sqlIngestBootstrapState.runningPromise = null;
    }
  })();

  return sqlIngestBootstrapState.runningPromise;
}
