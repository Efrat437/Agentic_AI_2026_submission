import { createClient } from './dbTools.js';

const DEFAULT_TTL_MS = parseInt(process.env.SCHEMA_GRAPH_CACHE_TTL_MS || '60000', 10);

let schemaCache = {
  expiresAt: 0,
  value: null,
};

async function querySchemaGraph(db) {
  const columnsQuery = `
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position;
  `;

  const foreignKeysQuery = `
    SELECT
      tc.table_name,
      kcu.column_name,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name,
      tc.constraint_name
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
    ORDER BY tc.table_name, tc.constraint_name;
  `;

  const [columnsRes, fkRes] = await Promise.all([
    db.query(columnsQuery),
    db.query(foreignKeysQuery),
  ]);

  return {
    columns: columnsRes.rows || [],
    foreignKeys: fkRes.rows || [],
  };
}

export async function getSchemaGraph({ db = null, useCache = true, ttlMs = DEFAULT_TTL_MS } = {}) {
  const now = Date.now();
  if (useCache && schemaCache.value && schemaCache.expiresAt > now) {
    return schemaCache.value;
  }

  if (db) {
    const value = await querySchemaGraph(db);
    if (useCache) {
      schemaCache = { value, expiresAt: now + Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS) };
    }
    return value;
  }

  const client = createClient();
  await client.connect();
  try {
    const value = await querySchemaGraph(client);
    if (useCache) {
      schemaCache = { value, expiresAt: now + Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS) };
    }
    return value;
  } finally {
    await client.end();
  }
}

export function buildSchemaGrounding(query, schema = { columns: [], foreignKeys: [] }, opts = {}) {
  const q = String(query || '').toLowerCase();
  const maxTables = Math.max(1, Number(opts.maxTables) || 6);
  const maxColumns = Math.max(1, Number(opts.maxColumns) || 40);
  const maxForeignKeys = Math.max(1, Number(opts.maxForeignKeys) || 20);

  const tableNames = [...new Set((schema.columns || []).map((r) => r.table_name).filter(Boolean))];
  const mentioned = tableNames.filter((t) => q.includes(String(t).toLowerCase()));

  const selectedTables = mentioned.length > 0 ? mentioned.slice(0, maxTables) : tableNames.slice(0, maxTables);
  const selectedColumns = (schema.columns || [])
    .filter((r) => selectedTables.includes(r.table_name))
    .slice(0, maxColumns)
    .map((r) => ({ table: r.table_name, column: r.column_name, type: r.data_type }));

  const selectedFks = (schema.foreignKeys || [])
    .filter((fk) => selectedTables.includes(fk.table_name) || selectedTables.includes(fk.foreign_table_name))
    .slice(0, maxForeignKeys)
    .map((fk) => ({
      fromTable: fk.table_name,
      fromColumn: fk.column_name,
      toTable: fk.foreign_table_name,
      toColumn: fk.foreign_column_name,
    }));

  return {
    tables: selectedTables,
    columns: selectedColumns,
    foreignKeys: selectedFks,
  };
}

export function formatSchemaGroundingForPrompt(grounding = {}) {
  const tables = Array.isArray(grounding.tables) ? grounding.tables : [];
  const foreignKeys = Array.isArray(grounding.foreignKeys) ? grounding.foreignKeys : [];
  const columns = Array.isArray(grounding.columns) ? grounding.columns : [];

  const compactColumns = columns.slice(0, 20).map((c) => `${c.table}.${c.column}`);
  const compactFks = foreignKeys.slice(0, 12).map((fk) => `${fk.fromTable}.${fk.fromColumn}->${fk.toTable}.${fk.toColumn}`);

  return JSON.stringify({
    tables,
    columns: compactColumns,
    foreignKeys: compactFks,
  });
}
