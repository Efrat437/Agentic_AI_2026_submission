import { startMcpHttpServer } from './server/httpServer.js';

let started = false;
let startup = null;

// Keep this wrapper as the MCP boundary entry point used by the backend server.
// We keep it separate from the raw HTTP server module so callers import one stable API.
export async function startMcpToolServer() {
  if (started) return startup;

  const appHost = process.env.APP_HOST || '127.0.0.1';
  const mcpHost = process.env.MCP_HOST || '127.0.0.2';
  const allowSameNetwork = String(process.env.ALLOW_SAME_NETWORK_MCP || 'false').toLowerCase() === 'true';

  // Fail fast if both services are configured on the same interface by mistake.
  if (!allowSameNetwork && appHost === mcpHost) {
    throw new Error(
      `Unsafe network config: APP_HOST (${appHost}) must differ from MCP_HOST (${mcpHost}). ` +
      'Set ALLOW_SAME_NETWORK_MCP=true only for local debugging.'
    );
  }

  startup = await startMcpHttpServer();
  started = true;
  return startup;
}
