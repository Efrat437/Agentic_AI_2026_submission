import 'dotenv/config';

const APP_BASE = process.env.APP_BASE_URL || `http://${process.env.APP_HOST || '127.0.0.1'}:${process.env.PORT || '3000'}`;
const MCP_BASE = process.env.MCP_BASE_URL || `http://${process.env.MCP_HOST || '127.0.0.2'}:${process.env.MCP_PORT || '4000'}`;

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function requestJson(url, { method = 'GET', body = undefined, timeoutMs = 60000 } = {}) {
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: t.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return {
      ok: res.ok,
      status: res.status,
      json,
      textPreview: text.slice(0, 400),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err.message,
    };
  } finally {
    t.done();
  }
}

async function main() {
  const out = {};

  out.apiHealth = await requestJson(`${APP_BASE}/api/health`, { timeoutMs: 15000 });
  out.mcpHealth = await requestJson(`${MCP_BASE}/mcp/health`, { timeoutMs: 15000 });

  out.mcpStoreMemory = await requestJson(`${MCP_BASE}/mcp/call`, {
    method: 'POST',
    body: {
      name: 'store_memory',
      args: { userId: 'verify-user', content: 'security-boundary-check' },
    },
    timeoutMs: 15000,
  });

  out.askPipeline = await requestJson(`${APP_BASE}/ask`, {
    method: 'POST',
    body: { query: 'Tell me briefly what Tel Aviv is', userId: 'verify-user' },
    timeoutMs: 240000,
  });

  if (out.askPipeline.json) {
    out.askSummary = {
      route: out.askPipeline.json?.decision?.route || null,
      planSteps: Array.isArray(out.askPipeline.json?.plan) ? out.askPipeline.json.plan.length : null,
      resultItems: Array.isArray(out.askPipeline.json?.result) ? out.askPipeline.json.result.length : null,
      reflectionQuality: out.askPipeline.json?.reflection?.quality || null,
    };
  }

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
