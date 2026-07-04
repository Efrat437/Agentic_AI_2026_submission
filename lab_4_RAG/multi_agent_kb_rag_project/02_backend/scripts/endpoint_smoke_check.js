import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

async function call(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return {
    status: res.status,
    ok: res.ok,
    textPreview: text.slice(0, 300),
    parsed,
  };
}

async function main() {
  const semantic = await call('http://127.0.0.1:3000/api/agents/semantic-rag', {
    query: 'What is Tel Aviv?',
    useRerank: false,
    userId: 'verify-user',
  });

  const sqlrag = await call('http://127.0.0.1:3000/api/agents/sql-rag', {
    query: 'How many nodes are there?',
    userId: 'verify-user',
  });

  const ask = await call('http://127.0.0.1:3000/ask', {
    query: 'Tell me briefly what Tel Aviv is',
    userId: 'verify-user',
  });

  const out = {
    semantic: {
      status: semantic.status,
      ok: semantic.ok,
      docs: Array.isArray(semantic.parsed?.docs) ? semantic.parsed.docs.length : null,
      answerPreview: String(semantic.parsed?.answer || semantic.textPreview).slice(0, 120),
    },
    sqlrag: {
      status: sqlrag.status,
      ok: sqlrag.ok,
      sql: sqlrag.parsed?.sql || null,
      rows: Array.isArray(sqlrag.parsed?.rows) ? sqlrag.parsed.rows.length : null,
      answerPreview: String(sqlrag.parsed?.answer || sqlrag.textPreview).slice(0, 120),
    },
    ask: {
      status: ask.status,
      ok: ask.ok,
      route: ask.parsed?.decision?.route || null,
      planSteps: Array.isArray(ask.parsed?.plan) ? ask.parsed.plan.length : null,
      resultItems: Array.isArray(ask.parsed?.result) ? ask.parsed.result.length : null,
      reflection: ask.parsed?.reflection?.quality || null,
      textPreview: ask.textPreview,
    },
  };

  console.log(JSON.stringify(out, null, 2));
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const outPath = path.resolve(__dirname, 'endpoint_smoke_report.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
