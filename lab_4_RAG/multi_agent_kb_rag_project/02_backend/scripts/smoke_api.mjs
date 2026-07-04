const base = 'http://localhost:3000';

async function call(name, url, init = {}) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('timeout')), 20000);
    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timeout);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { test: name, ok: res.ok, status: res.status, body };
  } catch (err) {
    return { test: name, ok: false, status: 0, body: err.message || String(err) };
  }
}

const tests = [];
tests.push(await call('classify', `${base}/api/classify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'How many nodes are in the database?', userId: 'u1' }),
}));

tests.push(await call('semantic-rag', `${base}/api/agents/semantic-rag`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'Tell me about urban planning entities', userId: 'u1', useRerank: false }),
}));

tests.push(await call('sql-rag', `${base}/api/agents/sql-rag`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'How many rows are in nodes table?', userId: 'u1' }),
}));

tests.push(await call('ask-full-pipeline', `${base}/ask`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'Give me a quick overview using SQL and RAG', userId: 'u1' }),
}));

tests.push(await call('mcp-tool-sql', `${base}/api/tools/sql`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'Count rows in attributes', userId: 'u1' }),
}));

tests.push(await call('mcp-tool-rag', `${base}/api/tools/rag`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'Find related planning documents', userId: 'u1' }),
}));

tests.push(await call('mcp-tool-memory', `${base}/api/tools/memory?userId=u1&agent=semantic-rag&limit=3`));

console.log(JSON.stringify(tests, null, 2));
