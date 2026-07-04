import { Client } from "pg";
import ExcelJS from 'exceljs';
import { getEmbeddings } from '../providers.js';
import path from "path";
import 'dotenv/config';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const SQL_DIR = path.join(PROJECT_ROOT, 'sql');
const HYBRID_SCHEMA_PATH = path.join(PROJECT_ROOT, 'sql', 'hybrid_schema.sql');
const BASE_PATH = fs.existsSync(path.join(process.cwd(), '04_data'))
  ? path.resolve(process.cwd(), '04_data')
  : path.join(PROJECT_ROOT, '04_data');

function ensureFileExists(fileName) {
  const p = path.join(BASE_PATH, fileName);
  if (!fs.existsSync(p)) throw new Error(`Missing data file: ${p}`);
  return p;
}

async function readExcel(fileName) {
  // try a few common filename variants, but do not throw if missing — return empty array
  const candidates = [fileName, fileName.replace('.xlsx', '_table.xlsx'), fileName.replace('.xlsx', 's.xlsx')];
  for (const f of candidates) {
    const p = path.join(BASE_PATH, f);
    if (!fs.existsSync(p)) continue;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(p);
    const ws = workbook.worksheets[0];
    if (!ws) return [];
    // assume first row is header
    const headers = [];
    ws.getRow(1).eachCell((cell, colNumber) => {
      headers[colNumber] = String(cell.value || '').trim();
    });
    const out = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // skip header
      const obj = {};
      row.eachCell((cell, colNumber) => {
        const key = headers[colNumber] || `col_${colNumber}`;
        obj[key] = cell.value;
      });
      // if entire row empty skip
      if (Object.values(obj).every(v => v === null || v === undefined || v === '')) return;
      out.push(obj);
    });
    return out;
  }
  console.warn(`No Excel file found for ${fileName} (checked: ${candidates.join(', ')})`);
  return [];
}

async function getEmbeddingsBatch(texts) {
  // Use provider wrapper which will prefer Entropic -> OpenAI -> Xenova
  // Implement simple exponential backoff for transient errors / rate limits
  const maxRetries = 5;
  let attempt = 0;
  while (true) {
    try {
      const embs = await getEmbeddings(texts);
      return embs;
    } catch (err) {
      attempt++;
      const msg = err && err.message ? err.message : String(err);
      // if quota/rate limit, retry with backoff up to maxRetries
      if (attempt <= maxRetries && /rate|quota|429/i.test(msg)) {
        const wait = Math.min(10000, 500 * Math.pow(2, attempt));
        console.warn(`Embedding provider rate/quota error, retry ${attempt}/${maxRetries} after ${wait}ms - ${msg}`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

async function main() {
  const client = new Client({
    user: process.env.DB_USER || 'sso_user',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'sso_db',
    password: process.env.DB_PASSWORD || 'sso_pass',
    port: parseInt(process.env.DB_PORT || '5433', 10),
  });

  await client.connect();

  try {
    // Apply canonical schema to keep embedding/export logic aligned with hybrid schema.
    if (!fs.existsSync(HYBRID_SCHEMA_PATH)) {
      throw new Error(`Missing required schema file: ${HYBRID_SCHEMA_PATH}`);
    }
    await client.query(fs.readFileSync(HYBRID_SCHEMA_PATH, 'utf8'));

    await client.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

    // Ensure FK constraints are present and validated before embedding/export steps.
    // This keeps graph integrity intact for downstream SQL-RAG and joins.
    const ensureHybridForeignKeys = async () => {
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_rel_from') THEN
            ALTER TABLE relationships
              ADD CONSTRAINT fk_rel_from FOREIGN KEY (from_node)
              REFERENCES nodes(node_id) ON DELETE CASCADE;
          END IF;

          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_rel_to') THEN
            ALTER TABLE relationships
              ADD CONSTRAINT fk_rel_to FOREIGN KEY (to_node)
              REFERENCES nodes(node_id) ON DELETE CASCADE;
          END IF;

          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_attr_node') THEN
            ALTER TABLE attributes
              ADD CONSTRAINT fk_attr_node FOREIGN KEY (node_id)
              REFERENCES nodes(node_id) ON DELETE CASCADE;
          END IF;
        END $$;
      `);

      const fkRes = await client.query(`
        SELECT conname, convalidated
        FROM pg_constraint
        WHERE conname IN ('fk_rel_from', 'fk_rel_to', 'fk_attr_node')
        ORDER BY conname;
      `);

      const required = new Set(['fk_rel_from', 'fk_rel_to', 'fk_attr_node']);
      const found = new Set((fkRes.rows || []).map((r) => r.conname));
      const missing = [...required].filter((k) => !found.has(k));
      const unvalidated = (fkRes.rows || []).filter((r) => r.convalidated === false).map((r) => r.conname);

      if (missing.length > 0 || unvalidated.length > 0) {
        const message = `FK verification failed. missing=${missing.join(',') || 'none'}, unvalidated=${unvalidated.join(',') || 'none'}`;
        if (String(process.env.STRICT_FK_CHECK || 'true').toLowerCase() === 'true') {
          throw new Error(message);
        }
        console.warn(`[FK] ${message}`);
      } else {
        console.log('[FK] Required hybrid FKs are present and validated.');
      }
    };

    await ensureHybridForeignKeys();

    const normalizeEmbedding = (e) => {
      if (!e) return null;
      if (typeof e === 'object' && !Array.isArray(e) && e.embedding) e = e.embedding;
      if (!Array.isArray(e)) return null;
      const flat = e
        .flat(Infinity)
        .map((x) => (typeof x === 'number' ? x : Number(x) || 0))
        .filter((x) => !Number.isNaN(x));
      return flat.length > 0 ? flat : null;
    };

    const fitDim = (embedding, dim) => {
      let out = (embedding || []).map((x) => Number(x) || 0);
      if (out.length < dim) out = [...out, ...new Array(dim - out.length).fill(0)];
      if (out.length > dim) out = out.slice(0, dim);
      return out;
    };

    const toVectorLiteral = (embedding) => `[${embedding.join(',')}]`;

    const esc = (s) => (s === null || s === undefined ? '' : String(s).replace(/'/g, "''"));

    const getTableColumns = async (table) => {
      const res = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
        [table]
      );
      return new Set((res.rows || []).map((r) => r.column_name));
    };

    const pick = (cols, candidates) => candidates.find((c) => cols.has(c));

    const dimRes = await client.query(`
      SELECT format_type(a.atttypid, a.atttypmod) AS type_display
      FROM pg_attribute a
      JOIN pg_class c ON a.attrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = 'public' AND c.relname = 'nodes' AND a.attname = 'embedding' AND a.attnum > 0 AND NOT a.attisdropped
      LIMIT 1
    `);
    const dimMatch = String(dimRes.rows?.[0]?.type_display || '').match(/vector\((\d+)\)/i);
    const TARGET_DIM = dimMatch ? parseInt(dimMatch[1], 10) : parseInt(process.env.EMBEDDING_DIM || '384', 10);

    const nodeCols = await getTableColumns('nodes');
    const nodeCfg = {
      table: 'nodes',
      pk: pick(nodeCols, ['node_id', 'id']),
      embeddingCol: pick(nodeCols, ['embedding', 'embeddings']) || 'embedding',
      embeddingsCol: pick(nodeCols, ['embeddings', 'embedding']) || 'embeddings',
      textExpr: `
        COALESCE(name, title, metadata->>'name', '') || E'\n' ||
        COALESCE(type, metadata->>'type', '') || E'\n' ||
        COALESCE(description, content, metadata->>'description', '') || E'\n' ||
        COALESCE(source, '')
      `,
    };

    const relCols = await getTableColumns('relationships');
    const relCfg = {
      table: 'relationships',
      pk: pick(relCols, ['rel_id', 'id']),
      embeddingCol: pick(relCols, ['embedding', 'embeddings']) || 'embedding',
      embeddingsCol: pick(relCols, ['embeddings', 'embedding']) || 'embeddings',
      typeCol: pick(relCols, ['rel_type', 'type']) || 'rel_type',
      hasProps: relCols.has('properties'),
      hasSource: relCols.has('source'),
    };
    relCfg.textExpr = `
      COALESCE(from_node, '') || E'\n' ||
      COALESCE(to_node, '') || E'\n' ||
      COALESCE(${relCfg.typeCol}, '') || E'\n' ||
      ${relCfg.hasSource ? "COALESCE(source, '') || E'\\n' ||" : "'' || E'\\n' ||"}
      ${relCfg.hasProps ? "COALESCE(properties::text, '')" : "''"}
    `;

    const attrCols = await getTableColumns('attributes');
    const attrCfg = {
      table: 'attributes',
      pk: pick(attrCols, ['attr_id', 'id']),
      embeddingCol: pick(attrCols, ['embedding', 'embeddings']) || 'embedding',
      embeddingsCol: pick(attrCols, ['embeddings', 'embedding']) || 'embeddings',
      hasMeta: attrCols.has('metadata'),
      hasSource: attrCols.has('source'),
    };
    attrCfg.textExpr = `
      COALESCE(node_id, '') || E'\n' ||
      COALESCE(key, '') || E'\n' ||
      COALESCE(value, '') || E'\n' ||
      ${attrCfg.hasSource ? "COALESCE(source, '') || E'\\n' ||" : "'' || E'\\n' ||"}
      ${attrCfg.hasMeta ? "COALESCE(metadata::text, '')" : "''"}
    `;

    const processMissingEmbeddings = async (cfg) => {
      if (!cfg.pk) {
        console.warn(`[${cfg.table}] missing PK column, skipping`);
        return { updated: 0, skipped: 0 };
      }

      const rowsRes = await client.query(
        `SELECT ${cfg.pk} AS id, ${cfg.textExpr} AS embed_text FROM ${cfg.table} WHERE COALESCE(${cfg.embeddingCol}, ${cfg.embeddingsCol}) IS NULL`
      );
      let rows = rowsRes.rows || [];

      const DEBUG_SAMPLE = String(process.env.DEBUG_EMBED_SAMPLE || '').toLowerCase() === 'true';
      if (DEBUG_SAMPLE) rows = rows.slice(0, 10);

      if (rows.length === 0) {
        console.log(`[${cfg.table}] no missing embeddings`);
        return { updated: 0, skipped: 0 };
      }

      console.log(`[${cfg.table}] embedding ${rows.length} rows`);

      const texts = rows.map((r) => {
        const base = String(r.embed_text || '').trim();
        return base.length > 0 ? base : `${cfg.table} ${r.id}`;
      });

      const chunkSize = 100;
      const vectors = [];
      for (let i = 0; i < texts.length; i += chunkSize) {
        const batch = texts.slice(i, i + chunkSize);
        const embs = await getEmbeddingsBatch(batch);
        for (const e of embs) vectors.push(normalizeEmbedding(e));
      }

      let updated = 0;
      let skipped = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const emb = normalizeEmbedding(vectors[i]);
        if (!emb || emb.length === 0) {
          skipped++;
          continue;
        }
        const fitted = fitDim(emb, TARGET_DIM);
        const vec = toVectorLiteral(fitted);
        await client.query(`UPDATE ${cfg.table} SET ${cfg.embeddingCol} = $1::vector, ${cfg.embeddingsCol} = $1::vector WHERE ${cfg.pk} = $2`, [vec, row.id]);
        updated++;
      }

      console.log(`[${cfg.table}] updated=${updated}, skipped=${skipped}`);
      return { updated, skipped };
    };

    const exportNodesSql = async () => {
      const hasSource = nodeCols.has('source');
      const hasTitle = nodeCols.has('title');
      const hasContent = nodeCols.has('content');
      const hasName = nodeCols.has('name');
      const hasDescription = nodeCols.has('description');
      const hasMetadata = nodeCols.has('metadata');

      const dumpRes = await client.query(`
        SELECT
          ${nodeCfg.pk} AS id,
          ${nodeCfg.pk} AS legacy_id,
          ${hasSource ? "COALESCE(source,'')" : "''"} AS source,
          ${hasTitle ? "COALESCE(title,'')" : (hasName ? "COALESCE(name,'')" : "COALESCE(metadata->>'name','')")} AS title,
          ${hasContent ? "COALESCE(content,'')" : (hasDescription ? "COALESCE(description,'')" : "COALESCE(metadata->>'description','')")} AS content,
          ${hasName ? "COALESCE(name,'')" : "COALESCE(metadata->>'name','')"} AS name,
          ${hasDescription ? "COALESCE(description,'')" : "COALESCE(metadata->>'description','')"} AS description,
          ${nodeCols.has('type') ? "COALESCE(type,'')" : "COALESCE(metadata->>'type','')"} AS type,
          ${hasMetadata ? 'metadata' : "'{}'::jsonb"} AS metadata,
          COALESCE(embedding, embeddings) AS embedding,
          COALESCE(embeddings, embedding) AS embeddings
        FROM nodes
      `);
      const rows = dumpRes.rows || [];
      const out = [];
      out.push('-- nodes.sql');
      out.push('DROP TABLE IF EXISTS nodes CASCADE;');
      out.push('CREATE TABLE nodes (');
      out.push('  node_id VARCHAR PRIMARY KEY,');
      out.push('  id VARCHAR,');
      out.push('  source VARCHAR,');
      out.push('  title TEXT,');
      out.push('  name TEXT,');
      out.push('  type TEXT,');
      out.push('  description TEXT,');
      out.push('  content TEXT,');
      out.push('  metadata JSONB,');
      out.push(`  embedding VECTOR(${TARGET_DIM}),`);
      out.push(`  embeddings VECTOR(${TARGET_DIM})`);
      out.push(');');
      out.push('');

      for (const r of rows) {
        let emb = normalizeEmbedding(r.embedding) || new Array(TARGET_DIM).fill(0);
        emb = fitDim(emb, TARGET_DIM);
        const meta = typeof r.metadata === 'object' && r.metadata ? r.metadata : {};
        meta.embedding = emb;
        out.push(`INSERT INTO nodes (node_id, id, source, title, name, type, description, content, metadata, embedding, embeddings) VALUES ('${esc(r.id)}', '${esc(r.legacy_id)}', '${esc(r.source)}', '${esc(r.title)}', '${esc(r.name)}', '${esc(r.type)}', '${esc(r.description)}', '${esc(r.content)}', '${esc(JSON.stringify(meta))}'::jsonb, '${toVectorLiteral(emb)}'::vector, '${toVectorLiteral(emb)}'::vector);`);
      }

      fs.mkdirSync(SQL_DIR, { recursive: true });
      const outPath = path.join(SQL_DIR, 'nodes.sql');
      fs.writeFileSync(outPath, out.join('\n'));
      console.log('Exported nodes.sql to', outPath);
    };

    const exportRelationshipsSql = async () => {
      const dumpRes = await client.query(`
        SELECT
          ${relCfg.pk} AS rel_id,
          ${relCfg.pk} AS id,
          ${relCfg.hasSource ? "COALESCE(source,'')" : "''"} AS source,
          COALESCE(from_node,'') AS source_id,
          COALESCE(from_node,'') AS from_node,
          COALESCE(to_node,'') AS target_id,
          COALESCE(to_node,'') AS to_node,
          COALESCE(${relCfg.typeCol}, '') AS relationship_type,
          COALESCE(${relCfg.typeCol}, '') AS rel_type,
          COALESCE(${relCfg.typeCol}, '') AS type,
          ${relCfg.hasProps ? "COALESCE(properties, '{}'::jsonb)" : "'{}'::jsonb"} AS properties,
          COALESCE(embedding, embeddings) AS embedding,
          COALESCE(embeddings, embedding) AS embeddings
        FROM relationships
      `);
      const rows = dumpRes.rows || [];
      const out = [];
      out.push('-- relationships.sql');
      out.push('DROP TABLE IF EXISTS relationships CASCADE;');
      out.push('CREATE TABLE relationships (');
      out.push('  rel_id VARCHAR PRIMARY KEY,');
      out.push('  id VARCHAR,');
      out.push('  source VARCHAR,');
      out.push('  source_id VARCHAR,');
      out.push('  from_node VARCHAR,');
      out.push('  target_id VARCHAR,');
      out.push('  to_node VARCHAR,');
      out.push('  relationship_type VARCHAR,');
      out.push('  rel_type VARCHAR,');
      out.push('  type VARCHAR,');
      out.push('  properties JSONB,');
      out.push(`  embedding VECTOR(${TARGET_DIM}),`);
      out.push(`  embeddings VECTOR(${TARGET_DIM}),`);
      out.push('  CONSTRAINT fk_rel_from FOREIGN KEY (from_node) REFERENCES nodes(node_id) ON DELETE CASCADE,');
      out.push('  CONSTRAINT fk_rel_to FOREIGN KEY (to_node) REFERENCES nodes(node_id) ON DELETE CASCADE');
      out.push(');');
      out.push('');

      for (const r of rows) {
        const emb = fitDim(normalizeEmbedding(r.embedding) || new Array(TARGET_DIM).fill(0), TARGET_DIM);
        out.push(`INSERT INTO relationships (rel_id, id, source, source_id, from_node, target_id, to_node, relationship_type, rel_type, type, properties, embedding, embeddings) VALUES ('${esc(r.rel_id)}', '${esc(r.id)}', '${esc(r.source)}', '${esc(r.source_id)}', '${esc(r.from_node)}', '${esc(r.target_id)}', '${esc(r.to_node)}', '${esc(r.relationship_type)}', '${esc(r.rel_type)}', '${esc(r.type)}', '${esc(JSON.stringify(r.properties || {}))}'::jsonb, '${toVectorLiteral(emb)}'::vector, '${toVectorLiteral(emb)}'::vector);`);
      }

      fs.mkdirSync(SQL_DIR, { recursive: true });
      const outPath = path.join(SQL_DIR, 'relationships.sql');
      fs.writeFileSync(outPath, out.join('\n'));
      console.log('Exported relationships.sql to', outPath);
    };

    const exportAttributesSql = async () => {
      const dumpRes = await client.query(`
        SELECT
          ${attrCfg.pk} AS attr_id,
          ${attrCfg.pk} AS id,
          ${attrCfg.hasSource ? "COALESCE(source,'')" : "''"} AS source,
          COALESCE(node_id,'') AS entity_id,
          COALESCE(node_id,'') AS node_id,
          COALESCE(key,'') AS attribute_key,
          COALESCE(key,'') AS key,
          COALESCE(value,'') AS attribute_value,
          COALESCE(value,'') AS value,
          ${attrCfg.hasMeta ? "COALESCE(metadata, '{}'::jsonb)" : "'{}'::jsonb"} AS metadata,
          COALESCE(embedding, embeddings) AS embedding,
          COALESCE(embeddings, embedding) AS embeddings
        FROM attributes
      `);
      const rows = dumpRes.rows || [];
      const out = [];
      out.push('-- attributes.sql');
      out.push('DROP TABLE IF EXISTS attributes CASCADE;');
      out.push('CREATE TABLE attributes (');
      out.push('  attr_id VARCHAR PRIMARY KEY,');
      out.push('  id VARCHAR,');
      out.push('  source VARCHAR,');
      out.push('  entity_id VARCHAR,');
      out.push('  node_id VARCHAR,');
      out.push('  attribute_key VARCHAR,');
      out.push('  key VARCHAR,');
      out.push('  attribute_value TEXT,');
      out.push('  value TEXT,');
      out.push('  metadata JSONB,');
      out.push(`  embedding VECTOR(${TARGET_DIM}),`);
      out.push(`  embeddings VECTOR(${TARGET_DIM}),`);
      out.push('  CONSTRAINT fk_attr_node FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE');
      out.push(');');
      out.push('');

      for (const r of rows) {
        const emb = fitDim(normalizeEmbedding(r.embedding) || new Array(TARGET_DIM).fill(0), TARGET_DIM);
        out.push(`INSERT INTO attributes (attr_id, id, source, entity_id, node_id, attribute_key, key, attribute_value, value, metadata, embedding, embeddings) VALUES ('${esc(r.attr_id)}', '${esc(r.id)}', '${esc(r.source)}', '${esc(r.entity_id)}', '${esc(r.node_id)}', '${esc(r.attribute_key)}', '${esc(r.key)}', '${esc(r.attribute_value)}', '${esc(r.value)}', '${esc(JSON.stringify(r.metadata || {}))}'::jsonb, '${toVectorLiteral(emb)}'::vector, '${toVectorLiteral(emb)}'::vector);`);
      }

      fs.mkdirSync(SQL_DIR, { recursive: true });
      const outPath = path.join(SQL_DIR, 'attributes.sql');
      fs.writeFileSync(outPath, out.join('\n'));
      console.log('Exported attributes.sql to', outPath);
    };

    const n = await processMissingEmbeddings(nodeCfg);
    const r = await processMissingEmbeddings(relCfg);
    const a = await processMissingEmbeddings(attrCfg);

    await exportNodesSql();
    await exportRelationshipsSql();
    await exportAttributesSql();

    console.log(`Embedding backfill summary: nodes=${n.updated}, relationships=${r.updated}, attributes=${a.updated}`);
  } catch (err) {
    console.error("Import failed:", err);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error("Import failed:", err);
});