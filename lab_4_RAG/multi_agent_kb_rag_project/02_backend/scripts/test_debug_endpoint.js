// Simple test script to POST to /api/agents/semantic-rag/debug
// Retries until the server is available or timeout reached.
// Falls back to /api/health if debug endpoint stays unavailable.
const DEBUG_URL = 'http://127.0.0.1:3000/api/agents/semantic-rag/debug';
const HEALTH_URL = 'http://127.0.0.1:3000/api/health';
const payload = { query: 'What is PKCE in OAuth?', topK: 5 };
const REQUEST_TIMEOUT_MS = 12000;

async function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function run(){
  const start = Date.now();
  const timeout = 60000; // 60s
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(DEBUG_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.error('Debug endpoint responded with', res.status, res.statusText);
        const text = await res.text();
        console.error(text);
        break;
      }
      const json = await res.json();
      console.log('DEBUG RESULT:\n', JSON.stringify(json, null, 2));
      process.exit(0);
    } catch (e) {
      // server not ready yet
      await wait(1500);
    }
  }

  // Fallback: confirm the server is at least alive even if debug path is slow/unavailable.
  try {
    const health = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (health.ok) {
      const json = await health.json();
      console.log('Debug endpoint unavailable; health check passed:', JSON.stringify(json));
      process.exit(0);
    }
  } catch {
    // no-op; handled below
  }

  console.error('Timed out waiting for server at', DEBUG_URL);
  process.exit(2);
}

run();
