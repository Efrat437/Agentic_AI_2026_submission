// test-mcp-e2e.js
import fetch from 'node-fetch';

const baseUrl = 'http://localhost:5000/mcp/receipts/query-sqlrag';
const questions = [
  'what is the weather today?',
  'how many receipts do you have?',
  'what is the total amount in the receipt?',
  'does the total amount in shekels or dollars?'
];

async function ask(question) {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userQuery: question })
  });
  try {
    const data = await res.json();
    return data;
  } catch (e) {
    return { error: 'Invalid JSON', status: res.status };
  }
}

(async () => {
  for (const q of questions) {
    const answer = await ask(q);
    console.log(`Q: ${q}\nA:`, answer, '\n');
  }
})();
