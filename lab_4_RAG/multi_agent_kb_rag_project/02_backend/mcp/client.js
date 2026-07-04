const MCP_HOST = process.env.MCP_HOST || '127.0.0.2';
const MCP_PORT = Number(process.env.MCP_PORT || '4000');
const MCP_BASE_URL = process.env.MCP_BASE_URL || `http://${MCP_HOST}:${MCP_PORT}`;
const MCP_TIMEOUT_MS = Number(process.env.MCP_TIMEOUT_MS || '45000');
const MCP_SHARED_KEY = process.env.MCP_SHARED_KEY || '';

function resolveBearerHeader({ args = {}, options = {} } = {}) {
  const explicitAuth = String(options?.authorization || '').trim();
  if (explicitAuth) {
    return explicitAuth;
  }

  const token = String(args?.securityContext?.jwtToken || '').trim();
  if (!token) {
    return '';
  }
  if (/^bearer\s+/i.test(token)) {
    return token;
  }
  return `Bearer ${token}`;
}

function withTimeout(promise, timeoutMs, label = 'mcp-call') {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function callTool(name, args = {}, options = {}) {
  const body = { name, args };
  const headers = { 'content-type': 'application/json' };
  if (MCP_SHARED_KEY) headers['x-mcp-key'] = MCP_SHARED_KEY;
  const authorization = resolveBearerHeader({ args, options });
  if (authorization) {
    headers.authorization = authorization;
  }

  const res = await withTimeout(
    fetch(`${MCP_BASE_URL}/mcp/call`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    MCP_TIMEOUT_MS,
    `mcp:${name}`,
  );

  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const msg = payload?.error || text || `MCP HTTP ${res.status}`;
    throw new Error(`MCP tool ${name} failed: ${msg}`);
  }

  if (!payload?.ok) {
    const msg = payload?.error || 'Unknown MCP error';
    throw new Error(`MCP tool ${name} failed: ${msg}`);
  }

  return payload.result;
}

export async function callToolsBatch(calls = [], options = {}) {
  const list = Array.isArray(calls) ? calls : [];
  if (list.length === 0) return [];

  const headers = { 'content-type': 'application/json' };
  if (MCP_SHARED_KEY) headers['x-mcp-key'] = MCP_SHARED_KEY;
  const firstArgs = list[0]?.args && typeof list[0].args === 'object' ? list[0].args : {};
  const authorization = resolveBearerHeader({ args: firstArgs, options });
  if (authorization) {
    headers.authorization = authorization;
  }

  const res = await withTimeout(
    fetch(`${MCP_BASE_URL}/mcp/call-batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ calls: list }),
    }),
    MCP_TIMEOUT_MS,
    'mcp:batch',
  );

  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const msg = payload?.error || text || `MCP HTTP ${res.status}`;
    throw new Error(`MCP batch failed: ${msg}`);
  }
  if (!payload?.ok) {
    const msg = payload?.error || 'Unknown MCP batch error';
    throw new Error(`MCP batch failed: ${msg}`);
  }

  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.map((r) => ({
    index: r?.index,
    ok: Boolean(r?.ok),
    selectedTool: r?.selectedTool || null,
    elapsedMs: Number(r?.elapsedMs || 0),
    result: r?.result,
    error: r?.error || null,
  }));
}
