import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runSemanticRAG } from '../agents/semantic_rag_agent.js';
import { runSQLRAG } from '../agents/sql_rag_agent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const reportPath = path.resolve(__dirname, 'verify_direct_pipelines_report.json');

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  const report = {
    semanticRag: { ok: false },
    sqlRag: { ok: false },
    timestamp: new Date().toISOString(),
  };

  try {
    const s = await withTimeout(
      runSemanticRAG({ query: 'What is Tel Aviv?', topK: 5, useRerank: false, userId: 'verify-user' }),
      180000,
      'semantic-rag'
    );
    report.semanticRag = {
      ok: true,
      docs: Array.isArray(s?.docs) ? s.docs.length : 0,
      answerPreview: String(s?.answer || '').slice(0, 140),
    };
  } catch (e) {
    report.semanticRag = { ok: false, error: e.message };
  }

  try {
    const q = await withTimeout(
      runSQLRAG({ userQuery: 'How many nodes are there?', systemPrompt: '', userId: 'verify-user' }),
      180000,
      'sql-rag'
    );
    report.sqlRag = {
      ok: true,
      sql: q?.sql || null,
      rowCount: Array.isArray(q?.rows) ? q.rows.length : 0,
      answerPreview: String(q?.answer || '').slice(0, 140),
    };
  } catch (e) {
    report.sqlRag = { ok: false, error: e.message };
  }

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  fs.writeFileSync(reportPath, JSON.stringify({ fatal: err.message, timestamp: new Date().toISOString() }, null, 2), 'utf8');
  process.exit(1);
});
