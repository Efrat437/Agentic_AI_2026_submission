const profileArg = process.argv.find((arg) => arg.startsWith('--profile='));
const profile = (profileArg ? profileArg.split('=')[1] : 'default').toLowerCase();

const profiles = {
  default: {
    MCP_TIMEOUT_MS: '120000',
    MCP_RAG_TIMEOUT_MS: '90000',
    MCP_SQL_TIMEOUT_MS: '120000',
    QUERY_BUILDER_EXEC_TIMEOUT_MS: '180000',
  },
  max: {
    MCP_TIMEOUT_MS: '180000',
    MCP_RAG_TIMEOUT_MS: '150000',
    MCP_SQL_TIMEOUT_MS: '180000',
    QUERY_BUILDER_EXEC_TIMEOUT_MS: '240000',
  },
};

const selected = profiles[profile] || profiles.default;
for (const [key, value] of Object.entries(selected)) {
  process.env[key] = value;
}

// Local dev defaults: keep backend and MCP reachable on localhost unless explicitly overridden.
if (!process.env.APP_HOST) process.env.APP_HOST = '127.0.0.1';
if (!process.env.MCP_HOST) process.env.MCP_HOST = '127.0.0.1';
if (!process.env.MCP_PORT) process.env.MCP_PORT = '4100';
if (!process.env.ALLOW_SAME_NETWORK_MCP) process.env.ALLOW_SAME_NETWORK_MCP = 'true';

console.log('[backend-timeouts] profile:', profile in profiles ? profile : 'default');
console.log('[backend-timeouts] values:', selected);
console.log('[backend-timeouts] network:', {
  APP_HOST: process.env.APP_HOST,
  MCP_HOST: process.env.MCP_HOST,
  MCP_PORT: process.env.MCP_PORT,
  ALLOW_SAME_NETWORK_MCP: process.env.ALLOW_SAME_NETWORK_MCP,
});

await import('../server.js');
