import express from 'express';
import { buildDefaultRegistry, decideToolFromQuery } from './toolRegistry.js';
import { verifyJwtFromRequest, getUserPermissions } from '../../security/secure_sql_orchestrator.js';

// Keep MCP on a different loopback interface by default from the main app host.
const MCP_HOST = process.env.MCP_HOST || '127.0.0.2';
const MCP_PORT = Number(process.env.MCP_PORT || '4000');
const MCP_SHARED_KEY = process.env.MCP_SHARED_KEY || '';
const MCP_BATCH_MAX_ITEMS = Number(process.env.MCP_BATCH_MAX_ITEMS || '20');
const MCP_JWT_GLOBAL_ENFORCED = String(process.env.MCP_JWT_GLOBAL_ENFORCED || process.env.JWT_GLOBAL_ENFORCED || 'true').toLowerCase() !== 'false';

let serverRef = null;
const registry = buildDefaultRegistry();
const startedAt = Date.now();
let totalCalls = 0;

function elapsedMsSince(startMs) {
  return Math.max(0, Date.now() - startMs);
}

function checkSharedKey(req) {
  if (!MCP_SHARED_KEY) return true;
  return req.headers['x-mcp-key'] === MCP_SHARED_KEY;
}

function isMcpPublicPath(req) {
  const p = String(req.path || '').toLowerCase();
  return p === '/health' || p === '/mcp/health';
}

function isSqlFamilyTool(toolName = '') {
  const tool = String(toolName || '');
  return tool === 'sql_query' || tool === 'sql_rag_query' || tool === 'hybrid_query';
}

function needsAuthSecurityContext(toolName = '') {
  const tool = String(toolName || '');
  return isSqlFamilyTool(tool) || tool === 'agent_manager';
}

function resolveRequestedUserId(req, jwtUser = {}) {
  const body = req?.body && typeof req.body === 'object' ? req.body : {};
  const args = body?.args && typeof body.args === 'object' ? body.args : {};
  const explicitBodyUserId = String(body.userId || '').trim();
  const explicitArgsUserId = String(args.userId || '').trim();
  const explicitQueryUserId = String(req?.query?.userId || '').trim();
  const jwtUserId = String(jwtUser?.userId || '').trim();
  return explicitBodyUserId || explicitArgsUserId || explicitQueryUserId || jwtUserId;
}

async function attachMcpAuthenticatedUserContext(req, res, next) {
  if (isMcpPublicPath(req)) {
    return next();
  }

  if (!requireMcpKey(req, res)) {
    return;
  }

  if (!MCP_JWT_GLOBAL_ENFORCED) {
    return next();
  }

  const jwtValidation = verifyJwtFromRequest(req);
  if (!jwtValidation.ok) {
    return sendError(res, 401, `JWT verification failed: ${jwtValidation.reason}`);
  }

  try {
    const effectiveUserId = resolveRequestedUserId(req, jwtValidation.user);
    const permissions = await getUserPermissions(effectiveUserId, jwtValidation.user.role, {
      includeTablePermissions: false,
      source: `mcp:${String(req.path || '')}`,
    });
    if (!permissions.ok) {
      return sendError(res, 403, `Permission loading failed: ${permissions.reason || 'unknown'}`);
    }

    if (String(process.env.AUTH_METRICS_LOG_ENABLED || 'false').toLowerCase() === 'true') {
      const stage = String(permissions?.permissionResolution?.stage || permissions?.resolutionStage || 'unknown');
      const cacheHit = Boolean(permissions?.permissionResolution?.cacheHit);
      console.info('[auth-metric]', JSON.stringify({
        event: 'mcp_auth_context_loaded',
        ts: new Date().toISOString(),
        endpoint: String(req.path || ''),
        userId: effectiveUserId,
        stage,
        cacheHit,
      }));
    }

    req.authContext = {
      jwtUser: jwtValidation.user,
      userId: effectiveUserId,
      permissions,
    };
    return next();
  } catch (err) {
    return sendError(res, 500, `Authentication context failed: ${String(err?.message || err)}`);
  }
}

function sendOk(res, payload = {}) {
  return res.json({ ok: true, ...payload });
}

function sendError(res, statusCode, message, details = undefined) {
  const body = { ok: false, error: message };
  if (details !== undefined) {
    body.details = details;
  }
  return res.status(statusCode).json(body);
}

function withGuard(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      return sendError(res, 500, err?.message || 'MCP request failed');
    }
  };
}

function requireMcpKey(req, res) {
  if (checkSharedKey(req)) return true;
  sendError(res, 403, 'Forbidden MCP key');
  return false;
}

function resolveToolName(name, args) {
  const isAuto = name === 'auto';
  if (isAuto) {
    return decideToolFromQuery(args?.query || '').tool;
  }
  return name;
}

async function runToolCall({ name, args = {} }) {
  if (!name || typeof name !== 'string') {
    throw new Error('Missing tool name');
  }
  const selectedTool = resolveToolName(name, args);
  if (!registry.has(selectedTool)) {
    throw new Error(`MCP tool not found: ${selectedTool}`);
  }

  const normalizedArgs = args && typeof args === 'object' ? { ...args } : {};
  if (Object.prototype.hasOwnProperty.call(normalizedArgs, 'authContext')) {
    delete normalizedArgs.authContext;
  }
  if (needsAuthSecurityContext(selectedTool) && args?.authContext?.permissions && args?.authContext?.jwtUser) {
    normalizedArgs.securityContext = {
      ...(normalizedArgs.securityContext && typeof normalizedArgs.securityContext === 'object'
        ? normalizedArgs.securityContext
        : {}),
      jwtUser: args.authContext.jwtUser,
      userPermissions: args.authContext.permissions,
    };
    if (!normalizedArgs.userId) {
      normalizedArgs.userId = String(args.authContext.userId || '').trim() || null;
    }
  }

  const started = Date.now();
  const result = await registry.call(selectedTool, normalizedArgs);
  totalCalls += 1;
  return {
    selectedTool,
    elapsedMs: elapsedMsSince(started),
    result,
  };
}

export async function startMcpHttpServer() {
  if (serverRef) {
    return { ok: true, host: MCP_HOST, port: MCP_PORT, started: false };
  }

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/mcp', attachMcpAuthenticatedUserContext);

  app.get('/mcp/health', (_req, res) => {
    return sendOk(res, {
      name: 'urban-ai-tools',
      version: '1.0.0',
      tools: registry.list().map((t) => t.name),
      uptimeMs: elapsedMsSince(startedAt),
      totalCalls,
    });
  });

  app.get('/mcp/tools', withGuard(async (req, res) => {
    return sendOk(res, { tools: registry.list() });
  }));

  app.post('/mcp/decide', withGuard(async (req, res) => {
    const { query = '' } = req.body || {};
    const decision = decideToolFromQuery(query);
    return sendOk(res, { decision });
  }));

  app.post('/mcp/route-call', withGuard(async (req, res) => {
    const { query = '', args = {} } = req.body || {};
    const decision = decideToolFromQuery(query);
    if (!registry.has(decision.tool)) {
      return sendError(res, 404, `Routed tool not found: ${decision.tool}`);
    }

    const mergedArgs = { ...args };
    if (mergedArgs.query == null) mergedArgs.query = query;

    const call = await runToolCall({ name: decision.tool, args: { ...mergedArgs, authContext: req.authContext || null } });
    return sendOk(res, { decision, selectedTool: call.selectedTool, elapsedMs: call.elapsedMs, result: call.result });
  }));

  app.post('/mcp/call', withGuard(async (req, res) => {
    const { name, args = {} } = req.body || {};
    if (!name || typeof name !== 'string') {
      return sendError(res, 400, 'Missing tool name');
    }

    try {
      const call = await runToolCall({ name, args: { ...args, authContext: req.authContext || null } });
      return sendOk(res, { selectedTool: call.selectedTool, elapsedMs: call.elapsedMs, result: call.result });
    } catch (err) {
      const msg = err?.message || 'MCP call failed';
      const notFound = msg.startsWith('MCP tool not found');
      const badArgs = msg.startsWith('Invalid arguments');
      if (notFound) return sendError(res, 404, msg);
      if (badArgs) return sendError(res, 400, msg);
      return sendError(res, 500, msg);
    }
  }));

  app.post('/mcp/call-batch', withGuard(async (req, res) => {
    const calls = Array.isArray(req.body?.calls) ? req.body.calls : [];
    if (calls.length === 0) {
      return sendError(res, 400, 'calls must be a non-empty array');
    }
    if (calls.length > MCP_BATCH_MAX_ITEMS) {
      return sendError(res, 400, `Batch size exceeded: max ${MCP_BATCH_MAX_ITEMS}`);
    }

    const started = Date.now();
    const results = await Promise.all(calls.map(async (entry, index) => {
      try {
        const call = await runToolCall({
          name: entry?.name,
          args: { ...(entry?.args || {}), authContext: req.authContext || null },
        });
        return {
          index,
          ok: true,
          selectedTool: call.selectedTool,
          elapsedMs: call.elapsedMs,
          result: call.result,
        };
      } catch (err) {
        return {
          index,
          ok: false,
          error: err?.message || 'Batch call failed',
        };
      }
    }));

    return sendOk(res, {
      total: results.length,
      elapsedMs: elapsedMsSince(started),
      results,
    });
  }));

  await new Promise((resolve, reject) => {
    const srv = app.listen(MCP_PORT, MCP_HOST, () => {
      serverRef = srv;
      resolve();
    });
    srv.on('error', reject);
  });

  return { ok: true, host: MCP_HOST, port: MCP_PORT, started: true };
}
