const MCP_HOST = process.env.MCP_HOST || '127.0.0.2';
const MCP_PORT = Number(process.env.MCP_PORT || '4000');
const MCP_BASE_URL = process.env.MCP_BASE_URL || `http://${MCP_HOST}:${MCP_PORT}`;
const MCP_SHARED_KEY = process.env.MCP_SHARED_KEY || '';

function headers() {
  const h = { 'content-type': 'application/json' };
  if (MCP_SHARED_KEY) {
    h['x-mcp-key'] = MCP_SHARED_KEY;
  }
  return h;
}

function toMcpContent(result) {
  if (typeof result === 'string') {
    return [{ type: 'text', text: result }];
  }
  return [{ type: 'text', text: JSON.stringify(result) }];
}

export class RestMcpClientAdapter {
  async listTools() {
    const res = await fetch(`${MCP_BASE_URL}/mcp/tools`, {
      method: 'GET',
      headers: MCP_SHARED_KEY ? { 'x-mcp-key': MCP_SHARED_KEY } : undefined,
    });
    const payload = await res.json();
    if (!res.ok || !payload?.ok) {
      throw new Error(payload?.error || `MCP listTools failed: HTTP ${res.status}`);
    }

    const tools = (payload.tools || []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    return { tools };
  }

  async callTool({ name, arguments: args = {} }) {
    const res = await fetch(`${MCP_BASE_URL}/mcp/call`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name, args }),
    });
    const payload = await res.json();

    if (!res.ok || !payload?.ok) {
      throw new Error(payload?.error || `MCP callTool failed: HTTP ${res.status}`);
    }

    return {
      content: toMcpContent(payload.result),
      result: payload.result,
      selectedTool: payload.selectedTool || name,
    };
  }
}
