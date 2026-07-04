import { Client } from 'pg';
import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, '04_data');

const client = new Client({
  user: process.env.DB_USER || 'sso_user',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'sso_db',
  password: process.env.DB_PASSWORD || 'sso_pass',
  port: parseInt(process.env.DB_PORT || '5433', 10),
});

function toText(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function writeWorkbook(filePath, headers, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.addRow(headers);
  for (const row of rows) {
    sheet.addRow(headers.map((h) => toText(row[h])));
  }
  await workbook.xlsx.writeFile(filePath);
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  await client.connect();

  try {
    const nodesRes = await client.query(`
      SELECT
        COALESCE(node_id, id) AS id,
        COALESCE(name, title, metadata->>'name', '') AS name,
        COALESCE(type, metadata->>'type', '') AS type,
        COALESCE(description, content, metadata->>'description', '') AS description
      FROM nodes
      ORDER BY COALESCE(node_id, id)
    `);

    const relRes = await client.query(`
      SELECT
        COALESCE(rel_id, id) AS id,
        COALESCE(from_node, source_id, '') AS from_node,
        COALESCE(to_node, target_id, '') AS to_node,
        COALESCE(rel_type, relationship_type, type, '') AS type
      FROM relationships
      ORDER BY COALESCE(rel_id, id)
    `);

    const attrRes = await client.query(`
      SELECT
        COALESCE(attr_id, id) AS id,
        COALESCE(node_id, entity_id, '') AS node_id,
        COALESCE(key, attribute_key, '') AS key,
        COALESCE(value, attribute_value, '') AS value
      FROM attributes
      ORDER BY COALESCE(attr_id, id)
    `);

    const nodesPath = path.join(OUTPUT_DIR, 'nodes.xlsx');
    const relPath = path.join(OUTPUT_DIR, 'relationships.xlsx');
    const attrPath = path.join(OUTPUT_DIR, 'attributes.xlsx');

    await writeWorkbook(nodesPath, ['id', 'name', 'type', 'description'], nodesRes.rows || []);
    await writeWorkbook(relPath, ['id', 'from_node', 'to_node', 'type'], relRes.rows || []);
    await writeWorkbook(attrPath, ['id', 'node_id', 'key', 'value'], attrRes.rows || []);

    console.log(JSON.stringify({
      ok: true,
      outputDir: OUTPUT_DIR,
      files: {
        nodes: { path: nodesPath, rows: nodesRes.rowCount || 0 },
        relationships: { path: relPath, rows: relRes.rowCount || 0 },
        attributes: { path: attrPath, rows: attrRes.rowCount || 0 },
      },
    }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Failed to restore 04_data from DB:', err?.message || err);
  process.exit(1);
});