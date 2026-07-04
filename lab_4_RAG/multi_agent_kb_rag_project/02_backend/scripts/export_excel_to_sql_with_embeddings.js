// export_excel_to_sql_with_embeddings.js
// Reads the three Excel files (nodes_table.xlsx, relationships.xlsx, attributes.xlsx),
// computes embeddings using the providers.getEmbeddings (Xenova local) and
// writes full .sql files into ./sql/*.sql containing table DDL and INSERT statements

process.env.PREFER_LOCAL_EMBEDDINGS = 'true'; // prefer Xenova local model

import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { getEmbeddings } from '../../02_backend/providers.js';
import { fileURLToPath } from 'url';

// Resolve paths relative to this script so it works regardless of cwd
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..', '..');
const dataDir = path.join(workspaceRoot, '04_data');
const outDir = path.join(workspaceRoot, 'sql');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const files = {
  nodes: path.join(dataDir, 'nodes_table.xlsx'),
  relationships: path.join(dataDir, 'relationships.xlsx'),
  attributes: path.join(dataDir, 'attributes.xlsx'),
};

async function readSheetAsObjects(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheet = wb.worksheets[0];
  const rows = [];
  const header = [];
  sheet.eachRow((row, rowNumber) => {
    const vals = row.values || [];
    // exceljs row.values is 1-indexed
    if (rowNumber === 1) {
      for (let i = 1; i < vals.length; i++) header.push(String(vals[i] ?? '').trim());
      return;
    }
    const obj = {};
    for (let i = 1; i <= header.length; i++) {
      const key = header[i - 1] || `col_${i}`;
      const v = vals[i] ?? null;
      obj[key] = v === undefined || v === null ? null : String(v);
    }
    // skip empty rows
    const allNull = Object.values(obj).every(v => v === null || v === '');
    if (!allNull) rows.push(obj);
  });
  return rows;
}

function pickContentForEmbedding(rowObj) {
  // prefer common text fields
  const priority = ['content', 'text', 'description', 'body', 'summary', 'title'];
  for (const k of priority) {
    if (rowObj[k] && rowObj[k].trim()) return rowObj[k].trim();
  }
  // fallback: join all non-empty values into one string
  const parts = [];
  for (const [k, v] of Object.entries(rowObj)) {
    if (v && String(v).trim()) parts.push(`${k}: ${v}`);
  }
  return parts.join('\n').slice(0, 20000); // cap length
}

function sqlEscapeString(s) {
  if (s === null || s === undefined) return 'NULL';
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function vectorToSqlLiteral(vec) {
  if (!Array.isArray(vec)) return 'NULL';
  // format: '[0.1,0.2,...]'::vector
  const nums = vec.map(x => Number(x) || 0);
  return "'[" + nums.join(',') + "]'::vector";
}

async function processTable(kind, filePath, tableName, idPrefix) {
  console.log(`Processing ${kind} from ${filePath}`);
  const rows = await readSheetAsObjects(filePath);
  console.log(`Read ${rows.length} rows from ${path.basename(filePath)}`);

  // build entries
  const entries = rows.map((r, idx) => {
    // try to find an id-like column
    const possibleIdKeys = ['id', 'node_id', 'attr_id', 'rel_id', 'uid', 'uuid'];
    let id = null;
    for (const k of possibleIdKeys) {
      if (r[k] && r[k].trim()) { id = r[k].trim(); break; }
    }
    if (!id) id = `${idPrefix}_${idx + 1}`;
    const source = path.basename(filePath);
    const metadata = { ...r };
    const content = pickContentForEmbedding(r) || '';
    return { id, source, metadata, content, raw: r };
  });

  // compute embeddings in batches (for nodes/relationships/attributes)
  const batchSize = 8; // conservative
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const texts = batch.map(e => e.content || '');
    try {
      console.log(`Embedding batch ${i}..${i + batch.length - 1}`);
      const embs = await getEmbeddings(texts);
      for (let j = 0; j < batch.length; j++) {
        batch[j].embedding = (embs[j] && embs[j].length) ? embs[j] : new Array((embs[0] && embs[0].length) || 384).fill(0);
      }
    } catch (e) {
      console.error('Embedding error, filling zeros for this batch:', e.message || e);
      // fallback zeros
      const dim = 384;
      for (const b of batch) b.embedding = new Array(dim).fill(0);
    }
  }

  // derive embedding dim from first entry
  const dim = entries[0] && entries[0].embedding && entries[0].embedding.length ? entries[0].embedding.length : 384;

  // compose SQL
  const lines = [];
  lines.push(`-- ${tableName}.sql`);
  lines.push(`DROP TABLE IF EXISTS ${tableName} CASCADE;`);
  if (tableName === 'nodes') {
    lines.push(`CREATE TABLE ${tableName} (`);
    lines.push(`  node_id VARCHAR PRIMARY KEY,`);
    lines.push(`  source VARCHAR,`);
    lines.push(`  title TEXT,`);
    lines.push(`  content TEXT,`);
    lines.push(`  metadata JSONB,`);
    lines.push(`  embedding VECTOR(${dim})`);
    lines.push(`);`);
  } else if (tableName === 'relationships') {
    lines.push(`CREATE TABLE ${tableName} (`);
    lines.push(`  rel_id VARCHAR PRIMARY KEY,`);
    lines.push(`  source VARCHAR,`);
    lines.push(`  from_node VARCHAR,`);
    lines.push(`  to_node VARCHAR,`);
    lines.push(`  rel_type VARCHAR,`);
    lines.push(`  properties JSONB,`);
    lines.push(`  embedding VECTOR(${dim})`);
    lines.push(`);`);
  } else if (tableName === 'attributes') {
    lines.push(`CREATE TABLE ${tableName} (`);
    lines.push(`  attr_id VARCHAR PRIMARY KEY,`);
    lines.push(`  source VARCHAR,`);
    lines.push(`  node_id VARCHAR,`);
    lines.push(`  key VARCHAR,`);
    lines.push(`  value TEXT,`);
    lines.push(`  metadata JSONB,`);
    lines.push(`  embedding VECTOR(${dim})`);
    lines.push(`);`);
  }

  // INSERTs
  for (const e of entries) {
    if (tableName === 'nodes') {
      const node_id = sqlEscapeString(e.id);
      const source = sqlEscapeString(e.source);
      const title = sqlEscapeString(e.raw.title || e.raw.name || '');
      const content = sqlEscapeString(e.content);
      const metadata = sqlEscapeString(JSON.stringify(e.metadata));
      const embedding = vectorToSqlLiteral(e.embedding);
      lines.push(`INSERT INTO ${tableName} (node_id, source, title, content, metadata, embedding) VALUES (${node_id}, ${source}, ${title}, ${content}, ${metadata}::jsonb, ${embedding});`);
    } else if (tableName === 'relationships') {
      const rel_id = sqlEscapeString(e.id);
      const source = sqlEscapeString(e.source);
      const from_node = sqlEscapeString(e.raw.from_node || e.raw.from || e.raw.source_id || '');
      const to_node = sqlEscapeString(e.raw.to_node || e.raw.to || e.raw.target_id || '');
      const rel_type = sqlEscapeString(e.raw.rel_type || e.raw.type || '');
      const properties = sqlEscapeString(JSON.stringify(e.metadata));
      const embedding = vectorToSqlLiteral(e.embedding);
      lines.push(`INSERT INTO ${tableName} (rel_id, source, from_node, to_node, rel_type, properties, embedding) VALUES (${rel_id}, ${source}, ${from_node}, ${to_node}, ${rel_type}, ${properties}::jsonb, ${embedding});`);
    } else if (tableName === 'attributes') {
      const attr_id = sqlEscapeString(e.id);
      const source = sqlEscapeString(e.source);
      const node_id = sqlEscapeString(e.raw.node_id || e.raw.node || '');
      // pick a key/value pair if present, else create from row
      const key = sqlEscapeString(e.raw.key || e.raw.attr_key || '');
      const value = sqlEscapeString(e.raw.value || e.raw.attr_value || pickContentForEmbedding(e.raw) || '');
      const metadata = sqlEscapeString(JSON.stringify(e.metadata));
      const embedding = vectorToSqlLiteral(e.embedding);
      lines.push(`INSERT INTO ${tableName} (attr_id, source, node_id, key, value, metadata, embedding) VALUES (${attr_id}, ${source}, ${node_id}, ${key}, ${value}, ${metadata}::jsonb, ${embedding});`);
    }
  }

  const outPath = path.join(outDir, `${tableName}.sql`);
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${outPath} (${lines.length} lines)`);
}

async function main() {
  try {
    await processTable('nodes', files.nodes, 'nodes', 'node');
    await processTable('relationships', files.relationships, 'relationships', 'rel');
    await processTable('attributes', files.attributes, 'attributes', 'attr');
    console.log('All done. SQL files written to sql/');
  } catch (e) {
    console.error('Failed:', e);
    process.exit(1);
  }
}

main();
