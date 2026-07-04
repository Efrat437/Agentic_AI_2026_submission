import { Client } from 'pg';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const HYBRID_SCHEMA_CANDIDATES = [
  path.join(PROJECT_ROOT, '04_data', 'hybrid_schema.sql'),
  path.join(PROJECT_ROOT, 'sql', 'hybrid_schema.sql'),
];
const HYBRID_SCHEMA_PATH = HYBRID_SCHEMA_CANDIDATES.find((p) => fs.existsSync(p)) || HYBRID_SCHEMA_CANDIDATES[1];

const client = new Client({
  user: process.env.DB_USER || 'sso_user',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'sso_db',
  password: process.env.DB_PASSWORD || 'sso_pass',
  port: parseInt(process.env.DB_PORT || '5433', 10),
});

await client.connect();

const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIM || '384', 10);

async function ensureColumn(table, column, definition) {
  await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition};`);
}

try {
  // Apply canonical schema file first so this script stays aligned with sql/hybrid_schema.sql.
  if (!fs.existsSync(HYBRID_SCHEMA_PATH)) {
    throw new Error(`Missing required schema file: ${HYBRID_SCHEMA_PATH}`);
  }
  const hybridSchemaSql = fs.readFileSync(HYBRID_SCHEMA_PATH, 'utf8');
  await client.query(hybridSchemaSql);

  // Ensure pgvector extension
  await client.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

  // Create canonical tables with node_id/rel_id/attr_id keys.
  // Extra compatibility columns are added below so legacy scripts keep working.
  // Excel-aligned table headlines requested:
  // nodes: id, name, type, embeddings
  // relationships: source_id, relationship_type, target_id, embeddings
  // attributes: entity_id, attribute_key, attribute_value, embeddings

  // Create nodes table (canonical key + excel/compat columns added after CREATE).
  await client.query(`
    CREATE TABLE IF NOT EXISTS nodes (
      node_id VARCHAR PRIMARY KEY
    );
  `);

  await ensureColumn('nodes', 'id', 'VARCHAR');
  await ensureColumn('nodes', 'source', 'TEXT');
  await ensureColumn('nodes', 'title', 'TEXT');
  await ensureColumn('nodes', 'content', 'TEXT');
  await ensureColumn('nodes', 'name', 'TEXT');
  await ensureColumn('nodes', 'type', 'TEXT');
  await ensureColumn('nodes', 'description', 'TEXT');
  await ensureColumn('nodes', 'metadata', `JSONB DEFAULT '{}'::jsonb`);
  await ensureColumn('nodes', 'embeddings', `VECTOR(${EMBEDDING_DIM})`);

  // Ensure embedding column exists with correct dimension
  const colRes = await client.query(`
    SELECT column_name, udt_name
    FROM information_schema.columns
    WHERE table_name = 'nodes' AND column_name = 'embedding'
  `);

  if (colRes.rowCount === 0) {
    // add embedding column
    await client.query(`ALTER TABLE nodes ADD COLUMN embedding VECTOR(${EMBEDDING_DIM});`);
    console.log(`[DB] Added embedding column with dimension ${EMBEDDING_DIM}`);
  } else {
    const dimRes = await client.query(`
      SELECT format_type(a.atttypid, a.atttypmod) AS type_display
      FROM pg_attribute a
      JOIN pg_class c ON a.attrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = 'public' AND c.relname = 'nodes' AND a.attname = 'embedding' AND a.attnum > 0 AND NOT a.attisdropped
      LIMIT 1
    `);
    const display = dimRes.rows?.[0]?.type_display || 'vector';
    console.log(`[DB] Keeping existing nodes.embedding type: ${display}`);
  }

  // Create relationships table
  await client.query(`
    CREATE TABLE IF NOT EXISTS relationships (
      rel_id VARCHAR PRIMARY KEY,
      from_node VARCHAR REFERENCES nodes(node_id),
      to_node VARCHAR REFERENCES nodes(node_id)
    );
  `);

  await ensureColumn('relationships', 'source', 'TEXT');
  await ensureColumn('relationships', 'rel_id', 'VARCHAR');
  await ensureColumn('relationships', 'id', 'VARCHAR');
  await ensureColumn('relationships', 'source_id', 'TEXT');
  await ensureColumn('relationships', 'target_id', 'TEXT');
  await ensureColumn('relationships', 'relationship_type', 'TEXT');
  await ensureColumn('relationships', 'rel_type', 'TEXT');
  await ensureColumn('relationships', 'type', 'TEXT');
  await ensureColumn('relationships', 'properties', `JSONB DEFAULT '{}'::jsonb`);
  await ensureColumn('relationships', 'embedding', `VECTOR(${EMBEDDING_DIM})`);
  await ensureColumn('relationships', 'embeddings', `VECTOR(${EMBEDDING_DIM})`);

  // Create attributes table
  await client.query(`
    CREATE TABLE IF NOT EXISTS attributes (
      attr_id VARCHAR PRIMARY KEY,
      node_id VARCHAR REFERENCES nodes(node_id)
    );
  `);

  await ensureColumn('attributes', 'source', 'TEXT');
  await ensureColumn('attributes', 'attr_id', 'VARCHAR');
  await ensureColumn('attributes', 'id', 'VARCHAR');
  await ensureColumn('attributes', 'entity_id', 'TEXT');
  await ensureColumn('attributes', 'attribute_key', 'TEXT');
  await ensureColumn('attributes', 'attribute_value', 'TEXT');
  await ensureColumn('attributes', 'key', 'TEXT');
  await ensureColumn('attributes', 'value', 'TEXT');
  await ensureColumn('attributes', 'metadata', `JSONB DEFAULT '{}'::jsonb`);
  await ensureColumn('attributes', 'embedding', `VECTOR(${EMBEDDING_DIM})`);
  await ensureColumn('attributes', 'embeddings', `VECTOR(${EMBEDDING_DIM})`);

  // Keep canonical and excel/alias columns synchronized for existing rows.
  await client.query(`
    UPDATE nodes
    SET
      id = COALESCE(id, node_id),
      node_id = COALESCE(node_id, id),
      title = COALESCE(title, name),
      name = COALESCE(name, title),
      content = COALESCE(content, description),
      description = COALESCE(description, content),
      embeddings = COALESCE(embeddings, embedding),
      embedding = COALESCE(embedding, embeddings)
  `);

  await client.query(`
    UPDATE relationships
    SET
      id = COALESCE(id, rel_id),
      rel_id = COALESCE(rel_id, id),
      source_id = COALESCE(source_id, from_node),
      from_node = COALESCE(from_node, source_id),
      target_id = COALESCE(target_id, to_node),
      to_node = COALESCE(to_node, target_id),
      relationship_type = COALESCE(relationship_type, rel_type, type),
      rel_type = COALESCE(rel_type, relationship_type, type),
      type = COALESCE(type, relationship_type, rel_type),
      embeddings = COALESCE(embeddings, embedding),
      embedding = COALESCE(embedding, embeddings)
  `);

  await client.query(`
    UPDATE attributes
    SET
      id = COALESCE(id, attr_id),
      attr_id = COALESCE(attr_id, id),
      entity_id = COALESCE(entity_id, node_id),
      node_id = COALESCE(node_id, entity_id),
      attribute_key = COALESCE(attribute_key, key),
      key = COALESCE(key, attribute_key),
      attribute_value = COALESCE(attribute_value, value),
      value = COALESCE(value, attribute_value),
      embeddings = COALESCE(embeddings, embedding),
      embedding = COALESCE(embedding, embeddings)
  `);

  console.log('[DB] Tables created or already exist');
} catch (err) {
  console.error('[DB] Error creating tables:', err);
  throw err;
} finally {
  await client.end();
}