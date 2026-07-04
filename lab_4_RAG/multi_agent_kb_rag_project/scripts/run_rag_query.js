// scripts/run_rag_query.js
// Usage: node scripts/run_rag_query.js "What is Tel Aviv?"

import fetch from 'node-fetch';

const query = process.argv[2] || 'What is Tel Aviv?';

async function main() {
  const response = await fetch('http://127.0.0.1:3000/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      topK: 10,
      useRerank: false,
      systemPrompt: '',
      userId: 'ui-user',
      sqlOptions: { includeRagasReport: true }
    })
  });
  if (!response.ok) {
    console.error('RAG query failed:', response.status, await response.text());
    process.exit(1);
  }
  const data = await response.json();
  console.log('RAG Output for query:', query);
  console.log(JSON.stringify(data, null, 2));
}

main().catch(err => {
  console.error('Error running RAG query:', err);
  process.exit(1);
});
