import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { ingestSqlTablesToRag } from '../agents/dbTools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const reportPath = path.resolve(__dirname, 'ingest_sql_to_rag_report.json');

async function main() {
  const startedAt = new Date().toISOString();
  const out = { ok: false, startedAt, tables: ['attributes', 'nodes', 'relationships'] };
  try {
    const result = await ingestSqlTablesToRag({
      tables: ['attributes', 'nodes', 'relationships'],
      truncate: true,
    });
    out.ok = true;
    out.result = result;
    out.finishedAt = new Date().toISOString();
    fs.writeFileSync(reportPath, JSON.stringify(out, null, 2), 'utf8');
    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    out.ok = false;
    out.error = err.message;
    out.finishedAt = new Date().toISOString();
    fs.writeFileSync(reportPath, JSON.stringify(out, null, 2), 'utf8');
    console.error(JSON.stringify(out, null, 2));
    process.exit(1);
  }
}

main();
