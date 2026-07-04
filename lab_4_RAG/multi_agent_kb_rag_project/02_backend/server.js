import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import { spawnSync } from 'child_process';
import 'dotenv/config';
import { ensureMemoriesTable, ensureActionsTable, ensureGovernmentRequestsTable, getActionById, createGovernmentRequest, getGovernmentRequestById, updateGovernmentRequestStatus, mapAgentToContext } from './agents/dbTools.js';
import { classifyQuery } from './agents/classifier_agent.js';
import { runSQLRAG } from './agents/sql_rag_agent.js';
import { runSemanticRAG, debugMatchAndRank } from './agents/semantic_rag_agent.js';
import { runQueryBuilderAgent } from './agents/query_builder_agent.js';
import { proposeAction, executeAction } from './agents/action_agent.js';
import { startIngestJob, getJobStatus, listJobs } from './ingest/ingest_controller.js';
import { supervise, supervisor } from './agents/supervisor.js';
import { runReactExecutionAgent } from './agents/reactExecutionAgent.js';
import { runSqlTool } from './agents/sqlTool.js';
import { runRagTool } from './agents/ragTool.js';
import { callTool as callMcpTool } from './mcp/client.js';
import { getConversationContext, memoryTool, remember } from './agents/memoryTool.js';
import { reflect } from './agents/reflectionAgent.js';
import { startMcpToolServer } from './mcp/toolServer.js';
import { enforceApiKey, requireAdmin, getActionPermissionContext, permissionSettings } from './config/permissions.js';
import { getAllowedPublicUris } from './mcp/server/tools/webPublicUris.js';
import { pool } from './config/db.js';
import { ingestLocalGovernmentWebToRag, getLocalGovernmentRagStats, resetLocalGovernmentRagData } from './making_operations/local_government/operations.js';
import { scheduleTelAvivAppointmentOfficial, MunicipalityApiUnavailableError, MunicipalityApiCallError } from './making_operations/local_government/official_appointment_api.js';
import { runDiscoverAPINode, getDiscoverApiNodeCatalog } from './making_operations/local_government/discover_api_node.js';
import { runSelfExtendingAgent, getAgentRun, listAgentRuns, healSelectorWithLLM } from './making_operations/local_government/self_extending_agent.js';
import {
  buildWorkflowQueue,
  buildWorkflowScheduler,
  deriveBookingDecision,
  mapBookingStatusToRequestStatus,
  normalizeBookingState,
  normalizeBookingSlotEntry,
  normalizeSelectedBookingSlot,
} from './making_operations/local_government/booking_workflow.js';
import {
  verifyJwtFromRequest,
  getUserPermissions,
  runSecureAgentSqlFlow,
  ensureDefenseInDepthSecurity,
  getAuthMetricsSummary,
} from './security/secure_sql_orchestrator.js';
import { sanitizeUserSystemPrompt } from './security/input_guards.js';
import {
  runTelAvivBrowserBooking,
  runTelAvivFullyAutomatedBooking,
  runTelAvivPaymentsBoundaryAssist,
  startAttendedBookingSession,
  getAttendedBookingSessionStatus,
  resumeAttendedBookingSession,
  approveAttendedBookingSubmit,
  submitAttendedBookingSession,
  callAttendedSessionInternalEndpoint,
  stopAttendedBookingSession,
  saveBookingCredentials,
  loadBookingCredentials,
  clearBookingCredentials,
  getBookingCredentialsMeta,
  inspectBookingSiteNetwork,
} from './making_operations/local_government/browser_appointment_agent.js';
import {
  normalizeManualPaymentBoundaryEvidence,
  analyzePaymentProviderBoundary,
  savePaymentBoundaryEvidence,
  getLatestPaymentBoundaryEvidence,
  buildPaymentBoundaryUiSummary,
} from './making_operations/local_government/payment_provider_adapters.js';
import { runManagerAgentOperation, getManagerAccessDecision } from './agents/manager_agent.js';
import { runAgentManagerFlow } from './agents/agent_manager.js';
import { runLangGraphRetrieval, compareBaselineVsLangGraph } from './agents/langgraph_retrieval_agent.js';
import { runFrozenRagasRecordsEvaluation } from './scripts/eval_frozen_ragas_records.js';
import agentManagerRoutes from './routes/agent_manager.js';
import agentStatsRoutes from './routes/agent_stats.js';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const APP_HOST = process.env.APP_HOST || '127.0.0.1';
const MAX_EXECUTION_STEPS = parseInt(process.env.MAX_EXECUTION_STEPS || '6', 10);
const ASK_TIMEOUT_MS = Math.max(5000, parseInt(process.env.ASK_TIMEOUT_MS || '70000', 10));
const ASK_FALLBACK_BUDGET_MS = Math.max(3000, parseInt(process.env.ASK_FALLBACK_BUDGET_MS || '12000', 10));
const ASK_ORCHESTRATION_TIMEOUT_MS = Math.max(5000, ASK_TIMEOUT_MS - ASK_FALLBACK_BUDGET_MS);
const ASK_USE_QUERY_BUILDER = String(process.env.ASK_USE_QUERY_BUILDER || 'false').toLowerCase() === 'true';
const ASK_QUERY_BUILDER_STRATEGY = String(process.env.ASK_QUERY_BUILDER_STRATEGY || 'both').toLowerCase();
// Robust JWT enforcement: configurable for dev/prod via env var. Default: enforced. Set JWT_GLOBAL_ENFORCED=false to disable for local/dev.
const JWT_GLOBAL_ENFORCED = String(process.env.JWT_GLOBAL_ENFORCED || 'true').toLowerCase() !== 'false';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENT_PERMISSION_STORE = path.resolve(process.cwd(), 'tmp', 'agent-booking-permissions.json');
const API_DISCOVERY_STORE = path.resolve(process.cwd(), 'tmp', 'discovered-appointment-apis.json');
const APPOINTMENT_PERMISSION_ENFORCED = String(process.env.APPOINTMENT_PERMISSION_ENFORCED || 'true').toLowerCase() !== 'false';
const SCIENTIFIC_PIPELINE_SCRIPT = path.resolve(process.cwd(), '02_backend', 'scripts', 'run_rag_bootstrap_and_report.js');
const HTML_RAG_BOOKING_BOOSTER_SCRIPT = path.resolve(process.cwd(), '02_backend', 'scripts', 'run_html_rag_booking_booster.js');

const ROUTER_PROMPT = `
You are a strict router.

You have 4 tools:
1. read_agent → SELECT queries
2. write_agent → INSERT/UPDATE/DELETE
3. stats_agent → aggregations (COUNT, AVG, GROUP BY)
4. agent_manager → create/delete users

Rules:
- NEVER call stats after write
- If question is about statistics → use stats_agent
- If question is about creating/deleting users → use agent_manager
- If question is data retrieval → use read_agent

Goal:
- Route to the safest valid tool path with least privilege.

How and when to use tools:
- read_agent: only read-only retrieval and plain SELECT intent.
- write_agent: explicit write intent (INSERT/UPDATE/DELETE) and only with authorization.
- stats_agent: aggregate/analytics intent (COUNT, AVG, GROUP BY, dashboard summaries).
- agent_manager: user lifecycle and permission administration requests.

Few-shot routing examples:
- "How many active users logged in this month?" -> stats_agent
- "Show me nodes where type is regulation" -> read_agent
- "Update request 42 status to approved" -> write_agent
- "Create user dana_levi" -> agent_manager

Chain-of-thought mechanism:
- Think step-by-step privately.
- Return only final routing decision; do not expose private reasoning.

Security rules:
- JWT must be verified before routing; never bypass auth.
- Respect pool separation (read/statistics/write).
- Respect guard-agent and SQL AST guard decisions.
- Enforce single-statement, bounded execution, and explicit limits for broad SELECT paths.
- Enforce privileges, users, and permissions from role/user permission layers.
`;

function routeSecureAgentByIntent({ query = '', requestedAgent = '' } = {}) {
  const direct = String(requestedAgent || '').trim().toLowerCase();
  if (direct) return direct;

  const q = String(query || '').toLowerCase();
  if (/\b(create|add|new|delete|remove|deactivate)\b.*\b(user|users|account|accounts)\b|\b(user|users|account|accounts)\b.*\b(create|add|new|delete|remove|deactivate)\b/.test(q)) {
    return 'manager_agent';
  }
  if (/\b(stat|stats|statistics|aggregate|aggregation|dashboard|summary|count|avg|average|group by|how many|number of)\b/.test(q)) {
    return 'statistics_agent';
  }
  if (/\b(insert|update|delete|upsert|create|approve|reject|close|schedule|book)\b/.test(q)) {
    return 'sql_rag_agent';
  }
  return 'GAR_agent';
}

const REQUIRED_APPLICANT_FIELDS = [
  { key: 'firstName', label: 'First name', prompt: 'Enter your first name' },
  { key: 'lastName', label: 'Last name', prompt: 'Enter your last name' },
  { key: 'phone', label: 'Phone', prompt: 'Enter your phone number' },
  { key: 'email', label: 'Email', prompt: 'Enter your email address' },
  { key: 'address', label: 'Address', prompt: 'Enter your full address' },
];

function mergeApplicantWithSavedProfile(incoming = {}, saved = {}) {
  const left = saved && typeof saved === 'object' ? saved : {};
  const right = incoming && typeof incoming === 'object' ? incoming : {};
  const firstName = String(right.firstName || left.firstName || '').trim();
  const lastName = String(right.lastName || left.lastName || '').trim();
  const fullName = String(right.fullName || left.fullName || [firstName, lastName].filter(Boolean).join(' ')).trim();
  return {
    ...left,
    ...right,
    firstName,
    lastName,
    fullName,
    phone: String(right.phone || left.phone || '').trim(),
    email: String(right.email || left.email || '').trim(),
    address: String(right.address || left.address || '').trim(),
  };
}

function getMissingApplicantFields(applicant = {}) {
  const profile = applicant && typeof applicant === 'object' ? applicant : {};
  return REQUIRED_APPLICANT_FIELDS
    .map((field) => field.key)
    .filter((key) => !String(profile[key] || '').trim());
}

function buildApplicantProfileQuestionnaire(applicant = {}) {
  const profile = applicant && typeof applicant === 'object' ? applicant : {};
  return REQUIRED_APPLICANT_FIELDS.map((field) => ({
    key: field.key,
    label: field.label,
    prompt: field.prompt,
    required: true,
    hasValue: Boolean(String(profile[field.key] || '').trim()),
  }));
}

async function ensureBookingApplicantProfilesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS booking_applicant_profiles (
      user_id TEXT PRIMARY KEY,
      profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getBookingApplicantProfileFromDb(userId = '') {
  const normalizedUserId = String(userId || '').trim() || 'default-user';
  const result = await pool.query(
    `SELECT profile_json, updated_at FROM booking_applicant_profiles WHERE user_id = $1 LIMIT 1`,
    [normalizedUserId]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0] || {};
  const profileJson = row.profile_json && typeof row.profile_json === 'object' ? row.profile_json : {};
  return {
    userId: normalizedUserId,
    profile: profileJson,
    updatedAt: row.updated_at || null,
  };
}

async function upsertBookingApplicantProfileToDb({ userId = '', applicantProfile = {} } = {}) {
  const normalizedUserId = String(userId || '').trim() || 'default-user';
  const normalizedProfile = applicantProfile && typeof applicantProfile === 'object' ? applicantProfile : {};
  await pool.query(
    `
      INSERT INTO booking_applicant_profiles (user_id, profile_json, created_at, updated_at)
      VALUES ($1, $2::jsonb, NOW(), NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        profile_json = COALESCE(booking_applicant_profiles.profile_json, '{}'::jsonb) || EXCLUDED.profile_json,
        updated_at = NOW()
      RETURNING user_id, profile_json, updated_at
    `,
    [normalizedUserId, JSON.stringify(normalizedProfile)]
  );
}

function normalizeManagerAction(action = '') {
  const normalized = String(action || '').trim().toUpperCase();
  if (normalized === 'CREATE_USER') return 'create_user';
  if (normalized === 'DELETE_USER') return 'delete_user';
  if (normalized === 'ASSIGN_PERMISSION') return 'assign_permission';
  return String(action || '').trim().toLowerCase();
}

await ensureMemoriesTable();
await ensureActionsTable();
await ensureGovernmentRequestsTable();
await ensureBookingApplicantProfilesTable();
await ensureDefenseInDepthSecurity().catch((err) => {
  console.warn('[defense-in-depth:init] failed:', err?.message || String(err));
});
await startMcpToolServer();

const staticPath = path.resolve(__dirname, '../01_fronted');
app.use(express.json());
app.use(express.static(staticPath));

function isPublicJwtPath(req) {
  const p = String(req.path || '').toLowerCase();
  return p === '/health';
}

async function attachAuthenticatedUserContext(req, res, next) {
  if (!JWT_GLOBAL_ENFORCED || isPublicJwtPath(req)) {
    return next();
  }

  const jwtValidation = verifyJwtFromRequest(req);
  if (!jwtValidation.ok) {
    return res.status(401).json({
      ok: false,
      error: `JWT verification failed: ${jwtValidation.reason}`,
    });
  }

  try {
    const authHeader = String(req.headers?.authorization || '').trim();
    const jwtToken = /^bearer\s+/i.test(authHeader) ? authHeader.replace(/^bearer\s+/i, '').trim() : '';
    const requestedUserId = String(req.body?.userId || req.query?.userId || '').trim();
    const effectiveUserId = requestedUserId || String(jwtValidation.user.userId || '').trim();
    const permissions = await getUserPermissions(effectiveUserId, jwtValidation.user.role, {
      includeTablePermissions: false,
      source: `api:${String(req.path || '')}`,
    });
    if (!permissions.ok) {
      return res.status(403).json({
        ok: false,
        error: `Permission loading failed: ${permissions.reason || 'unknown'}`,
      });
    }

    if (String(process.env.AUTH_METRICS_LOG_ENABLED || 'false').toLowerCase() === 'true') {
      const stage = String(permissions?.permissionResolution?.stage || permissions?.resolutionStage || 'unknown');
      const cacheHit = Boolean(permissions?.permissionResolution?.cacheHit);
      console.info('[auth-metric]', JSON.stringify({
        event: 'api_auth_context_loaded',
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
      jwtToken,
    };
    return next();
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: `Authentication context failed: ${String(err?.message || err)}`,
    });
  }
}

app.use('/api', enforceApiKey, attachAuthenticatedUserContext);

// Homework 11.3: Agent manager and stats routes for privileged DB operations
app.use('/api/agent-manager', agentManagerRoutes);
app.use('/api/agent-stats', agentStatsRoutes);

function extractAllowedUrisFromText(text) {
  const q = String(text || '');
  const allowed = getAllowedPublicUris();
  return allowed.filter((u) => q.includes(u));
}

function extractRequestStatusIdFromText(text) {
  const q = String(text || '').toLowerCase();
  const m = q.match(/request\s*status\s*[:#-]?\s*(\d+)/) || q.match(/status\s*[:#-]?\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

function isLikelyDbQuestion(text) {
  const q = String(text || '').toLowerCase();
  return /\b(table|tables|column|columns|row|rows|database|db|sql|count|how many|number of|node|nodes|relationship|relationships|attribute|attributes|district|city|program|programs|programms|plan|plans|building|buildings|infrastructure|infra|transport|transit|road|roads|utility|utilities|water|sewage|electric|electricity|fk|foreign key|cosine|similarity|nearest|neighbor|graph|traversal)\b/.test(q);
}

function wantsSemanticContext(text) {
  const q = String(text || '').toLowerCase();
  return /\b(explain|summarize|semantic|rag|document|policy|unstructured|context)\b/.test(q);
}

function detectQueryNature(text) {
  const q = String(text || '').toLowerCase();
  const sqlSignals = /\b(table|tables|column|columns|row|rows|database|db|sql|count|how many|number of|node|nodes|relationship|relationships|attribute|attributes|district|city|program|programs|programms|plan|plans|building|buildings|infrastructure|infra|transport|transit|road|roads|utility|utilities|water|sewage|electric|electricity|taba|join|foreign key|fk|cosine|similarity|nearest|neighbor|graph|traversal)\b/.test(q);
  const semanticSignals = /\b(explain|summarize|summary|semantic|rag|document|policy|context|meaning|about|why|how does|unstructured|narrative|insight)\b/.test(q);
  const explicitHybrid = /\b(hybrid|combine|both|structured and unstructured|sql and semantic)\b/.test(q);

  if (explicitHybrid || (sqlSignals && semanticSignals)) {
    return {
      type: 'hybrid',
      primaryPlan: [{ tool: 'hybrid_query' }],
      fallbackPlan: [{ tool: 'sql_rag_query' }, { tool: 'semantic_rag_query' }],
    };
  }

  if (sqlSignals) {
    return {
      type: 'sql',
      primaryPlan: [{ tool: 'sql_rag_query' }],
      fallbackPlan: [{ tool: 'sql_rag_query' }],
    };
  }

  return {
    type: 'semantic',
    primaryPlan: [{ tool: 'semantic_rag_query' }],
    fallbackPlan: [{ tool: 'semantic_rag_query' }],
  };
}

function isGovernmentRequestValidationError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('description is required')
    || msg.includes('id must be a positive integer')
    || msg.includes('status is required')
    || msg.includes('status must be one of');
}

function deriveContextForTool(toolName) {
  const tool = String(toolName || '');
  if (tool === 'sql_query' || tool === 'sql_rag_query') {
    return mapAgentToContext?.agent_1 || null;
  }
  if (tool === 'rag_search' || tool === 'semantic_rag_query' || tool === 'hybrid_query') {
    return mapAgentToContext?.agent_2 || null;
  }
  return null;
}

function applyMappedAgentContextToPlan(plan = []) {
  if (!Array.isArray(plan)) return [];
  return plan.map((step) => {
    const context = deriveContextForTool(step?.tool);
    if (!context || !context.table) return step;

    const params = step?.params && typeof step.params === 'object' ? { ...step.params } : {};
    if (!params.contextTable) {
      params.contextTable = context.table;
    }
    return {
      ...step,
      params,
    };
  });
}

function isSqlFamilyTool(toolName = '') {
  const tool = String(toolName || '');
  return tool === 'sql_query' || tool === 'sql_rag_query' || tool === 'hybrid_query';
}

function isMcpSecuredDataTool(toolName = '') {
  const tool = String(toolName || '');
  return isSqlFamilyTool(tool) || tool === 'rag_search' || tool === 'semantic_rag_query' || tool === 'auto';
}

function isSemanticFamilyTool(toolName = '') {
  const tool = String(toolName || '');
  return tool === 'rag_search' || tool === 'semantic_rag_query';
}

function normalizeAskQueryBuilderStrategy(v = '') {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'replace') return 'replace';
  if (s === 'both') return 'both';
  return 'preserve';
}

function toComparableQueryKey(v = '') {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildAskExecutionQueries({ originalQuery = '', queryBuilderQuery = '', strategy = 'preserve' } = {}) {
  const normalizedStrategy = normalizeAskQueryBuilderStrategy(strategy);
  const original = String(originalQuery || '').trim();
  const rewritten = String(queryBuilderQuery || '').trim();

  if (!original && !rewritten) return [];
  if (!rewritten) return [{ query: original, source: 'user' }];

  const same = toComparableQueryKey(original) === toComparableQueryKey(rewritten);
  if (same) return [{ query: original || rewritten, source: 'user' }];

  if (normalizedStrategy === 'replace') {
    return [{ query: rewritten, source: 'query_builder' }];
  }
  if (normalizedStrategy === 'both') {
    return [
      { query: original, source: 'user' },
      { query: rewritten, source: 'query_builder' },
    ];
  }
  return [{ query: original, source: 'user' }];
}

function applyAskQueryBuilderToPlan({
  plan = [],
  fallbackQuery = '',
  strategy = 'preserve',
  queryBuilderHints = null,
} = {}) {
  if (!Array.isArray(plan)) return [];

  const normalizedStrategy = normalizeAskQueryBuilderStrategy(strategy);
  if (normalizedStrategy === 'preserve') return plan;

  const topSql = String(queryBuilderHints?.sqlTop || '').trim();
  const topSemantic = String(queryBuilderHints?.semanticTop || '').trim();
  if (!topSql && !topSemantic) return plan;

  const nextPlan = [];
  for (const step of plan) {
    const tool = String(step?.tool || '');
    const params = step?.params && typeof step.params === 'object' ? { ...step.params } : {};
    const originalStepQuery = String(params.query || fallbackQuery || '').trim();

    let candidateQuery = '';
    if (isSqlFamilyTool(tool)) {
      candidateQuery = topSql;
    } else if (isSemanticFamilyTool(tool)) {
      candidateQuery = topSemantic || topSql;
    }

    const candidateKey = toComparableQueryKey(candidateQuery);
    const originalKey = toComparableQueryKey(originalStepQuery);
    const hasCandidate = Boolean(candidateQuery);
    const isSame = hasCandidate && candidateKey === originalKey;

    if (!hasCandidate || isSame) {
      nextPlan.push(step);
      continue;
    }

    if (normalizedStrategy === 'replace') {
      nextPlan.push({
        ...step,
        params: {
          ...params,
          query: candidateQuery,
          querySource: 'query_builder',
          originalUserQuery: originalStepQuery || fallbackQuery || '',
        },
      });
      continue;
    }

    nextPlan.push({
      ...step,
      params: {
        ...params,
        ...(originalStepQuery ? { query: originalStepQuery } : {}),
        querySource: 'user',
      },
    });

    nextPlan.push({
      ...step,
      params: {
        ...params,
        query: candidateQuery,
        querySource: 'query_builder',
        originalUserQuery: originalStepQuery || fallbackQuery || '',
      },
    });
  }

  return nextPlan;
}

function chooseAskRequestedAgent({ toolName = '', query = '' } = {}) {
  const tool = String(toolName || '');
  const text = String(query || '').toLowerCase();
  const isStatsLike = /stat|aggregate|dashboard|summary|group by|count\(|\bhow many\b|\bnumber of\b|\bcount\b/.test(text);

  if (tool === 'hybrid_query') {
    if (isStatsLike) return 'statistics_agent';
    return 'GAR_agent';
  }

  if (/insert|update|delete|book|schedule|create|approve|reject|close/.test(text)) return 'sql_rag_agent';
  if (isStatsLike) return 'statistics_agent';
  if (/read|list|show|find|get|search|who|which|what|count/.test(text)) return 'GAR_agent';
  return 'GAR_agent';
}

function applyAskSecurityContextToPlan(plan = [], authContext = null, fallbackQuery = '') {
  if (!Array.isArray(plan) || !authContext?.permissions) return Array.isArray(plan) ? plan : [];

  return plan.map((step) => {
    const tool = String(step?.tool || '');
    if (!isMcpSecuredDataTool(tool)) return step;

    const params = step?.params && typeof step.params === 'object' ? { ...step.params } : {};
    const stepQuery = String(params.query || fallbackQuery || '');
    const requestedAgent = isSqlFamilyTool(tool)
      ? String(params.requestedAgent || chooseAskRequestedAgent({ toolName: tool, query: stepQuery }) || '').trim()
      : '';

    params.securityContext = {
      requestedAgent,
      permissionKey: String(params.permissionKey || '').trim(),
      jwtUser: authContext.jwtUser,
      userPermissions: authContext.permissions,
      jwtToken: String(authContext.jwtToken || '').trim(),
    };

    return {
      ...step,
      params,
    };
  });
}

function mapSecureSqlResultToToolOutput(secureResult = {}, query = '') {
  const generatedSql = String(secureResult?.generated?.sql || '').trim();
  const fields = Array.isArray(secureResult?.result?.fields) ? secureResult.result.fields : [];
  const rows = Array.isArray(secureResult?.result?.rows) ? secureResult.result.rows : [];
  const objectRows = rows.map((row) => {
    if (!Array.isArray(row)) return row;
    const mapped = {};
    for (let i = 0; i < fields.length; i += 1) {
      mapped[fields[i]] = row[i];
    }
    return mapped;
  });

  return {
    sql: generatedSql,
    rows: objectRows,
    answer: `Secure SQL flow executed via ${String(secureResult?.selectedAgent || 'unknown-agent')}`,
    meta: {
      query,
      selectedAgent: secureResult?.selectedAgent || null,
      poolName: secureResult?.poolName || null,
      rowCount: Number(secureResult?.result?.rowCount || objectRows.length || 0),
    },
  };
}

function resolveSystemPromptFromRequest(rawSystemPrompt, source) {
  const decision = sanitizeUserSystemPrompt(rawSystemPrompt, { source });
  if (decision.rejected) {
    const err = new Error(`Rejected unsafe systemPrompt: ${decision.reason}`);
    err.statusCode = 400;
    throw err;
  }
  return decision.value;
}

function runScientificPipelineFromServer({ query, skipBootstrap = false, topK = 8, output = './tmp/rag-scientific-report.json' } = {}) {
  const args = [SCIENTIFIC_PIPELINE_SCRIPT, '--mode', 'all', '--output', String(output || './tmp/rag-scientific-report.json')];
  if (skipBootstrap) args.push('--skip-bootstrap');
  if (query) args.push('--query', String(query));
  if (Number.isFinite(Number(topK))) args.push('--top-k', String(Math.max(1, Number(topK) || 8)));

  const child = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: Math.max(120000, Number(process.env.SCIENTIFIC_PIPELINE_TIMEOUT_MS || 240000) || 240000),
    maxBuffer: 12 * 1024 * 1024,
  });

  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error((child.stderr || child.stdout || `scientific pipeline exited with code ${child.status}`).trim());
  }

  const stdout = String(child.stdout || '').trim();
  const parsed = stdout ? JSON.parse(stdout) : {};
  return {
    ...parsed,
    output: path.resolve(process.cwd(), parsed?.output || output || './tmp/rag-scientific-report.json'),
  };
}

function runHtmlRagBookingBoosterFromServer({
  query = '',
  topK = 8,
  urls = [],
  replaceExisting = true,
  chunkSize = 900,
  chunkOverlap = 120,
  maxChunksPerUrl = 45,
  minRelevanceScore = 1,
  fetchTimeoutMs = 20000,
  enableSqlStage = false,
  forceSqlStage = false,
  enableLangGraphStage = false,
  forceLangGraphStage = false,
  enableQualityGate = false,
} = {}) {
  const args = [HTML_RAG_BOOKING_BOOSTER_SCRIPT];
  if (query) args.push('--query', String(query));
  if (Number.isFinite(Number(topK))) args.push('--top-k', String(Math.max(1, Number(topK) || 8)));
  if (replaceExisting) args.push('--replace-existing');
  if (Number.isFinite(Number(chunkSize))) args.push('--chunk-size', String(Math.max(200, Number(chunkSize) || 900)));
  if (Number.isFinite(Number(chunkOverlap))) args.push('--chunk-overlap', String(Math.max(0, Number(chunkOverlap) || 120)));
  if (Number.isFinite(Number(maxChunksPerUrl))) args.push('--max-chunks-per-url', String(Math.max(1, Number(maxChunksPerUrl) || 45)));
  if (Number.isFinite(Number(minRelevanceScore))) args.push('--min-relevance-score', String(Math.max(0, Number(minRelevanceScore) || 1)));
  if (Number.isFinite(Number(fetchTimeoutMs))) args.push('--fetch-timeout-ms', String(Math.max(1000, Number(fetchTimeoutMs) || 20000)));
  if (enableSqlStage) args.push('--enable-sql-stage');
  if (forceSqlStage) args.push('--force-sql-stage');
  if (enableLangGraphStage) args.push('--enable-langgraph-stage');
  if (forceLangGraphStage) args.push('--force-langgraph-stage');
  if (enableQualityGate) args.push('--quality-gate');

  const normalizedUrls = Array.isArray(urls)
    ? urls.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (normalizedUrls.length > 0) {
    args.push('--urls', normalizedUrls.join(','));
  }

  const child = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: Math.max(120000, Number(process.env.HTML_RAG_BOOKING_BOOSTER_TIMEOUT_MS || 300000) || 300000),
    maxBuffer: 12 * 1024 * 1024,
  });

  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error((child.stderr || child.stdout || `html rag booking booster exited with code ${child.status}`).trim());
  }

  const stdout = String(child.stdout || '').trim();
  return stdout ? JSON.parse(stdout) : { ok: true };
}

async function runAskSqlWithSecurity({ query, userId = null, sqlOptions = {}, systemPrompt = '', authContext = null, requestedAgent = '' } = {}) {
  const safeSystemPrompt = resolveSystemPromptFromRequest(systemPrompt, 'runAskSqlWithSecurity');
  const securePermissions = authContext?.permissions;
  const jwtUser = authContext?.jwtUser;
  if (!securePermissions || !jwtUser) {
    return runSqlTool({ userQuery: query, userId, sqlOptions, systemPrompt: safeSystemPrompt });
  }

  const secureResult = await runSecureAgentSqlFlow({
    userRequest: query,
    jwtUser,
    userPermissions: securePermissions,
    requestedAgent,
    permissionKey: '',
  });

  if (!secureResult?.ok) {
    const reason = String(secureResult?.guard?.reason || 'secure-sql-denied');
    return {
      sql: null,
      rows: [],
      answer: 'Structured SQL retrieval was denied by security policy.',
      degraded: true,
      error: reason,
    };
  }

  return mapSecureSqlResultToToolOutput(secureResult, query);
}

async function readPermissionStore() {
  try {
    const raw = await fs.readFile(AGENT_PERMISSION_STORE, 'utf8');
    const parsed = JSON.parse(raw);
    const tokens = Array.isArray(parsed?.tokens) ? parsed.tokens : [];
    return { tokens };
  } catch {
    return { tokens: [] };
  }
}

async function writePermissionStore(store) {
  await fs.mkdir(path.dirname(AGENT_PERMISSION_STORE), { recursive: true });
  await fs.writeFile(AGENT_PERMISSION_STORE, JSON.stringify(store, null, 2), 'utf8');
}

async function readApiDiscoveryStore() {
  try {
    const raw = await fs.readFile(API_DISCOVERY_STORE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      discoveredAt: parsed?.discoveredAt || null,
      apis: Array.isArray(parsed?.apis) ? parsed.apis : [],
    };
  } catch {
    return { discoveredAt: null, apis: [] };
  }
}

async function writeApiDiscoveryStore(store = {}) {
  await fs.mkdir(path.dirname(API_DISCOVERY_STORE), { recursive: true });
  await fs.writeFile(API_DISCOVERY_STORE, JSON.stringify({
    discoveredAt: store?.discoveredAt || new Date().toISOString(),
    apis: Array.isArray(store?.apis) ? store.apis : [],
  }, null, 2), 'utf8');
}

function classifyDiscoveredApi(method = 'GET', url = '') {
  const m = String(method || 'GET').toUpperCase();
  const u = String(url || '').toLowerCase();
  const pathPart = (() => {
    try { return new URL(url).pathname.toLowerCase(); } catch { return u; }
  })();

  let kind = 'unknown';
  let score = 0;

  if (/slot|appointment|calendar|avail|schedule|book|reserve|queue|meeting|\btor\b|תור|זימון/.test(u)) score += 25;
  if (/\/api\//.test(u)) score += 18;
  if (/\.svc\//.test(u) || /_vti_bin/.test(u)) score += 14;
  if (/analytics|clarity|tiktok|facebook|google-analytics|hotjar/.test(u)) score -= 40;

  if (/slot|avail|calendar|free|times?/.test(pathPart) && m === 'GET') {
    kind = 'slots';
    score += 20;
  }
  if (/schedule|book|reserve|submit|create|appointment/.test(pathPart) && ['POST', 'PUT', 'PATCH'].includes(m)) {
    kind = 'schedule';
    score += 20;
  }
  if (kind === 'unknown' && /list|items|search|lookup/.test(pathPart) && m === 'GET') {
    kind = 'slots';
    score += 8;
  }

  return { kind, score };
}

function toApiCandidate(entry = {}) {
  const url = String(entry?.url || '').trim();
  const method = String(entry?.method || 'GET').toUpperCase();
  const status = Number(entry?.status || 0);
  if (!url || !method) return null;
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null;
  if (status >= 400) return null;

  let host = '';
  let pathName = '';
  try {
    const parsed = new URL(url);
    host = parsed.host;
    pathName = parsed.pathname;
  } catch {
    return null;
  }

  const { kind, score } = classifyDiscoveredApi(method, url);
  if (score < 10) return null;

  return {
    id: randomUUID(),
    key: `${method}|${url}`,
    method,
    url,
    host,
    path: pathName,
    kind,
    score,
    lastStatus: status || null,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    hits: 1,
  };
}

function mergeApiCatalog(existingApis = [], discoveredApis = []) {
  const merged = new Map();
  for (const api of existingApis || []) {
    if (!api?.key) continue;
    merged.set(api.key, { ...api });
  }
  for (const api of discoveredApis || []) {
    if (!api?.key) continue;
    if (merged.has(api.key)) {
      const prev = merged.get(api.key);
      merged.set(api.key, {
        ...prev,
        score: Math.max(Number(prev.score || 0), Number(api.score || 0)),
        kind: api.kind === 'unknown' ? (prev.kind || 'unknown') : api.kind,
        lastStatus: api.lastStatus ?? prev.lastStatus,
        lastSeenAt: api.lastSeenAt,
        hits: Number(prev.hits || 1) + 1,
      });
    } else {
      merged.set(api.key, api);
    }
  }
  return Array.from(merged.values()).sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}

function chooseCatalogApi(catalog = [], action = 'slots') {
  const actionType = String(action || '').toLowerCase();
  const scoped = (catalog || []).filter((x) => x && x.url && x.method);
  if (scoped.length === 0) return null;

  const isSlots = actionType === 'slots';
  const preferredKind = isSlots ? 'slots' : 'schedule';
  const preferredMethod = isSlots ? 'GET' : 'POST';

  const sorted = scoped
    .map((item) => {
      let boost = 0;
      if (String(item.kind || '').toLowerCase() === preferredKind) boost += 30;
      if (String(item.method || '').toUpperCase() === preferredMethod) boost += 20;
      if (isSlots && /slot|avail|calendar|list|items|times?/.test(String(item.path || '').toLowerCase())) boost += 12;
      if (!isSlots && /schedule|book|reserve|submit|create/.test(String(item.path || '').toLowerCase())) boost += 12;
      return { ...item, finalScore: Number(item.score || 0) + boost };
    })
    .sort((a, b) => b.finalScore - a.finalScore);

  return sorted[0] || null;
}

async function executeDiscoveredApi({ endpoint, action = 'slots', payload = null, headers = {} } = {}) {
  const ep = endpoint || null;
  if (!ep || !ep.url) {
    return { ok: false, error: 'No endpoint selected' };
  }

  const actionType = String(action || '').toLowerCase();
  const methodByAction = actionType === 'schedule' ? 'POST' : 'GET';
  const method = String(methodByAction || ep.method || 'GET').toUpperCase();
  const requestHeaders = { accept: 'application/json, text/plain;q=0.9, */*;q=0.8', ...(headers || {}) };
  if (method !== 'GET') requestHeaders['content-type'] = requestHeaders['content-type'] || 'application/json';

  const resp = await fetch(ep.url, {
    method,
    headers: requestHeaders,
    body: method === 'GET' ? undefined : (payload == null ? undefined : (typeof payload === 'string' ? payload : JSON.stringify(payload))),
  });

  const text = await resp.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: String(text || '').slice(0, 4000) };
  }

  return {
    ok: resp.ok,
    status: resp.status,
    statusText: resp.statusText,
    method,
    url: ep.url,
    action,
    response: parsed,
  };
}

function extractPermissionTokenFromReq(req) {
  const auth = String(req.headers?.authorization || '').trim();
  const direct = String(req.headers?.['x-agent-booking-token'] || '').trim();
  if (direct) return direct;
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return '';
}

async function validatePermissionToken(token, { requiredScope = 'bookings' } = {}) {
  const now = Date.now();
  const store = await readPermissionStore();
  const found = (store.tokens || []).find((t) => t?.token === token && !t?.revokedAt);
  if (!found) return { ok: false, reason: 'token-not-found' };
  if (found.expiresAtMs && Number(found.expiresAtMs) > 0 && Number(found.expiresAtMs) < now) {
    return { ok: false, reason: 'token-expired', tokenMeta: found };
  }
  const scopes = Array.isArray(found.scopes) ? found.scopes : [];
  if (requiredScope && !scopes.includes(requiredScope)) {
    return { ok: false, reason: 'scope-missing', tokenMeta: found };
  }
  return { ok: true, tokenMeta: found };
}

async function requireAgentBookingPermission(req, res, next) {
  if (!APPOINTMENT_PERMISSION_ENFORCED) return next();

  const token = extractPermissionTokenFromReq(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'Agent permission token required. Call /api/government/agent-permission/grant first.',
      code: 'agent-permission-missing-token',
    });
  }

  const validation = await validatePermissionToken(token, { requiredScope: 'bookings' });
  if (!validation.ok) {
    return res.status(403).json({
      ok: false,
      error: `Agent permission denied: ${validation.reason}`,
      code: 'agent-permission-invalid-token',
    });
  }

  req.agentPermission = validation.tokenMeta;
  return next();
}

const appointmentMonitors = new Map();

function normalizeMonitorSlotEntry(slot, index = 0) {
  return normalizeBookingSlotEntry(slot, index);
}

function normalizeMonitorSelectedSlot(slot) {
  return normalizeSelectedBookingSlot(slot);
}

function buildMonitorBookingState(monitor, result = null, overrides = {}) {
  const prior = monitor?.bookingState || {};
  const slotAvailable = Boolean(result?.slot?.available);
  const derivedSlots = Array.isArray(result?.availableSlots) && result.availableSlots.length
    ? result.availableSlots
    : slotAvailable
    ? [{
      label: result?.pageTitle || 'Possible available slot',
      value: result?.finalUrl || result?.checkedAt || `slot-${Date.now()}`,
      confidence: Number(result?.slot?.confidence || 0),
      source: 'page-signal',
    }]
    : [];
  const availableSlots = derivedSlots.map(normalizeMonitorSlotEntry);
  const selectedSlot = normalizeMonitorSelectedSlot(monitor?.selectedSlot)
    || normalizeMonitorSelectedSlot(prior?.selected_slot)
    || availableSlots[0]
    || null;

  const decision = deriveBookingDecision({
    availableSlots,
    selectedSlot,
    preferredSlot: overrides.preferredSlot ?? monitor?.preferredSlot ?? prior?.preferred_slot ?? '',
    preferredDate: overrides.preferredDate ?? monitor?.preferredDate ?? prior?.preferred_date ?? '',
    preferredTimeRanges: overrides.preferredTimeRanges ?? monitor?.preferredTimeRanges ?? prior?.preferred_time_ranges ?? [],
    preferredTimeWindow: overrides.preferredTimeWindow ?? monitor?.preferredTimeWindow ?? null,
    autoBook: Boolean(monitor?.autoBook),
    confirmationGranted: Boolean(overrides.confirmationGranted ?? monitor?.confirmationGranted),
    slotCheckFailed: Boolean(result?.error || (result?.ok === false && !result?.slot)),
    pollIntervalMs: monitor?.intervalMs,
    timeZone: monitor?.slotTimeZone || prior?.slot_timezone || prior?.timezone,
  });

  const nextCheckAt = overrides.nextCheckAt !== undefined
    ? overrides.nextCheckAt
    : (decision.shouldWait && monitor?.running
      ? new Date(Date.now() + Math.max(1000, Number(monitor?.intervalMs) || 60000)).toISOString()
      : null);

  return normalizeBookingState({
    priorState: prior,
    availableSlots,
    selectedSlot: overrides.selectedSlot || decision.selectedSlot || selectedSlot,
    bookingStatus: overrides.bookingStatus || decision.bookingStatus,
    lastChecked: overrides.lastChecked || result?.checkedAt || new Date().toISOString(),
    userConfirmation: Boolean(monitor?.userConfirmation),
    autoBook: Boolean(monitor?.autoBook),
    decision: overrides.decision || decision.decision,
    nextCheckAt,
    notification: overrides.notification || prior.notification || null,
    queue: buildWorkflowQueue({ name: monitor?.queueName || 'appointment-monitor', inFlight: monitor?.inFlight }),
    scheduler: buildWorkflowScheduler({ intervalMs: monitor?.intervalMs, cronExpression: monitor?.cronExpression, mode: monitor?.scheduleMode, timeZone: monitor?.slotTimeZone || prior?.slot_timezone || prior?.timezone }),
    session: overrides.session || monitor?.lastBookingAttempt || prior.session || null,
    confirmationGranted: Boolean(overrides.confirmationGranted ?? monitor?.confirmationGranted),
    requiresHumanGate: Boolean(overrides.requiresHumanGate ?? decision.requiresHumanGate),
    preferredSlot: overrides.preferredSlot ?? monitor?.preferredSlot ?? prior?.preferred_slot ?? '',
    preferredDate: overrides.preferredDate ?? monitor?.preferredDate ?? prior?.preferred_date ?? '',
    preferredTimeRanges: overrides.preferredTimeRanges ?? monitor?.preferredTimeRanges ?? prior?.preferred_time_ranges ?? [],
    preferredTimeWindow: overrides.preferredTimeWindow ?? monitor?.preferredTimeWindow ?? null,
    retry: decision.retryStrategy,
    slotCheckFailed: Boolean(result?.error || (result?.ok === false && !result?.slot)),
    timeZone: monitor?.slotTimeZone || prior?.slot_timezone || prior?.timezone,
  });
}

async function persistMonitorBookingState(monitor, result, overrides = {}) {
  if (!monitor) return null;
  const bookingState = buildMonitorBookingState(monitor, result, overrides);
  monitor.bookingState = bookingState;

  const notes = {
    source: 'appointment-monitor',
    monitorId: monitor.id,
    intentText: monitor.intentText,
    bookingUrl: monitor.bookingUrl,
    bookingState,
    lastMonitorResult: result || null,
    scheduler: bookingState.scheduler,
    queue: bookingState.queue,
    lastBookingAttempt: monitor.lastBookingAttempt || null,
  };

  if (!monitor.linkedRequestId && bookingState.available_slots.length) {
    const created = await createGovernmentRequest({
      userId: monitor.userId || 'monitor-agent',
      description: `Appointment slot alert (${monitor.intentText})`,
      status: 'new',
      notes,
    }).catch(() => null);
    if (created?.id) {
      monitor.linkedRequestId = created.id;
    }
    return { request: created, bookingState };
  }

  if (!monitor.linkedRequestId) {
    return { request: null, bookingState };
  }

  return updateGovernmentRequestStatus({
    id: monitor.linkedRequestId,
    status: mapBookingStatusToRequestStatus(bookingState.booking_status),
    notes,
  }).catch(() => null).then((request) => ({ request, bookingState }));
}

function toMonitorPublicState(monitor) {
  if (!monitor) return null;
  return {
    id: monitor.id,
    userId: monitor.userId,
    intentText: monitor.intentText,
    bookingUrl: monitor.bookingUrl,
    intervalMs: monitor.intervalMs,
    autonomousBrowse: monitor.autonomousBrowse,
    maxAutonomousSteps: monitor.maxAutonomousSteps,
    running: monitor.running,
    startedAt: monitor.startedAt,
    stoppedAt: monitor.stoppedAt,
    checksCount: monitor.checksCount,
    alertsCount: monitor.alertsCount,
    linkedRequestId: monitor.linkedRequestId || null,
    selectedSlot: monitor.selectedSlot || null,
    userConfirmation: Boolean(monitor.userConfirmation),
    confirmationGranted: Boolean(monitor.confirmationGranted),
    autoBook: Boolean(monitor.autoBook),
    preferredSlot: monitor.preferredSlot || null,
    preferredDate: monitor.preferredDate || null,
    preferredTimeRanges: monitor.preferredTimeRanges || [],
    preferredTimeWindow: monitor.preferredTimeWindow || null,
    slotTimeZone: monitor.slotTimeZone || null,
    scheduleMode: monitor.scheduleMode,
    cronExpression: monitor.cronExpression || null,
    queueName: monitor.queueName || 'appointment-monitor',
    allowHumanIntervention: Boolean(monitor.allowHumanIntervention),
    bookingAttemptInFlight: Boolean(monitor.bookingAttemptInFlight),
    bookingState: monitor.bookingState || null,
    lastBookingAttempt: monitor.lastBookingAttempt || null,
    lastResult: monitor.lastResult,
    lastError: monitor.lastError,
    history: monitor.history,
  };
}

function detectSlotAvailability(inspection) {
  const pageBlob = `${inspection?.pageTitle || ''} ${inspection?.scrapeSignals?.textPreview || ''}`.toLowerCase();
  const positiveRules = [
    /available\s+slot/,
    /slots?\s+available/,
    /appointment\s+available/,
    /book\s+now/,
    /תור\s*פנוי/,
    /תורים\s*פנויים/,
    /זמינות/,
    /נותרו\s*תורים/,
    /נפתחו\s*תורים/,
  ];
  const negativeRules = [
    /no\s+available\s+appointments?/,
    /no\s+slots?\s+available/,
    /fully\s+booked/,
    /אין\s*תורים/,
    /לא\s*נמצאו\s*תורים/,
    /אין\s*זמינות/,
  ];

  const positiveHits = positiveRules.filter((r) => r.test(pageBlob)).length;
  const negativeHits = negativeRules.filter((r) => r.test(pageBlob)).length;

  const available = positiveHits > 0 && negativeHits === 0;
  const confidence = positiveHits === 0 ? 0 : Math.max(0, Math.min(1, (positiveHits - negativeHits) / 3));

  return {
    available,
    confidence,
    positiveHits,
    negativeHits,
  };
}

async function postMonitorWebhook(url, payload) {
  if (!url) return;
  try {
    await fetch(String(url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
  }
}

async function maybeExecuteMonitorBooking(monitor, result) {
  if (!monitor || monitor.bookingAttemptInFlight) return null;
  const bookingStatus = String(monitor.bookingState?.booking_status || '').trim().toLowerCase();
  if (!['auto_book_ready', 'booking_ready'].includes(bookingStatus)) return null;

  monitor.bookingAttemptInFlight = true;
  try {
    const selectedSlot = monitor.bookingState?.selected_slot || monitor.selectedSlot || null;
    const bookingAttempt = await runTelAvivFullyAutomatedBooking({
      requestId: monitor.linkedRequestId,
      bookingUrl: monitor.bookingUrl,
      applicant: {
        ...(monitor.applicant || {}),
        selectedSlot: selectedSlot?.raw || selectedSlot?.value || selectedSlot || null,
      },
      intentText: monitor.intentText,
      headless: Boolean(monitor.headlessBooking),
      timeoutMs: monitor.timeoutMs,
      pollIntervalMs: Math.min(Math.max(1000, Number(monitor.intervalMs) || 60000), 5000),
      keepSessionOnFailure: true,
      allowHumanIntervention: Boolean(monitor.allowHumanIntervention),
    });

    monitor.lastBookingAttempt = bookingAttempt;

    const submitted = Boolean(bookingAttempt?.submitted || bookingAttempt?.session?.submitted);
    const requiresHuman = Boolean(bookingAttempt?.requiresHuman);
    const bookingState = (await persistMonitorBookingState(monitor, {
      ...(result || {}),
      bookingAttempt,
    }, {
      bookingStatus: submitted ? 'submitted' : (requiresHuman ? 'awaiting_user_confirmation' : (bookingAttempt?.ok ? 'booking_in_progress' : 'booking_failed')),
      decision: monitor.bookingState?.decision || (monitor.autoBook ? 'auto_book' : 'book_confirmed_slot'),
      confirmationGranted: monitor.confirmationGranted,
      requiresHumanGate: requiresHuman,
      notification: submitted ? {
        type: 'booking_submitted',
        notifiedAt: new Date().toISOString(),
      } : monitor.bookingState?.notification,
      session: bookingAttempt?.session || bookingAttempt || null,
      nextCheckAt: submitted ? null : new Date(Date.now() + Math.max(1000, Number(monitor.intervalMs) || 60000)).toISOString(),
    }))?.bookingState || monitor.bookingState;

    if (submitted) {
      monitor.running = false;
      monitor.stoppedAt = new Date().toISOString();
      if (monitor.timer) {
        clearInterval(monitor.timer);
        monitor.timer = null;
      }
    }

    return { bookingAttempt, bookingState };
  } finally {
    monitor.bookingAttemptInFlight = false;
  }
}

async function runAppointmentMonitorCycle(monitor, { manual = false } = {}) {
  if (!monitor || !monitor.running) return null;
  if (monitor.inFlight) return monitor.lastResult || null;
  monitor.inFlight = true;

  try {
    const inspection = await inspectBookingSiteNetwork({
      bookingUrl: monitor.bookingUrl,
      intentText: monitor.intentText,
      applicant: monitor.applicant || {},
      autonomousBrowse: monitor.autonomousBrowse,
      maxAutonomousSteps: monitor.maxAutonomousSteps,
      maxNetworkEntries: monitor.maxNetworkEntries,
      timeoutMs: monitor.timeoutMs,
    });

    const slot = detectSlotAvailability(inspection || {});
    const result = {
      checkedAt: new Date().toISOString(),
      manual,
      ok: Boolean(inspection?.ok),
      finalUrl: inspection?.finalUrl || null,
      pageTitle: inspection?.pageTitle || null,
      networkCount: inspection?.networkCount || 0,
      traversal: inspection?.traversal || null,
      slot,
    };

    monitor.checksCount += 1;
    monitor.lastResult = result;
    monitor.lastError = null;
    const persisted = await persistMonitorBookingState(monitor, result);
    result.bookingState = persisted?.bookingState || monitor.bookingState;
    monitor.history.push(result);
    if (monitor.history.length > monitor.maxHistory) {
      monitor.history.splice(0, monitor.history.length - monitor.maxHistory);
    }

    let bookingExecution = null;
    if (slot.available && ['auto_book_ready', 'booking_ready'].includes(String(monitor.bookingState?.booking_status || ''))) {
      bookingExecution = await maybeExecuteMonitorBooking(monitor, result);
      if (bookingExecution?.bookingAttempt) {
        result.bookingAttempt = bookingExecution.bookingAttempt;
        result.bookingState = bookingExecution.bookingState || monitor.bookingState;
      }
    }

    if (slot.available) {
      monitor.alertsCount += 1;
      const alertPayload = {
        type: 'appointment-slot-available',
        monitorId: monitor.id,
        userId: monitor.userId,
        checkedAt: result.checkedAt,
        bookingUrl: monitor.bookingUrl,
        finalUrl: result.finalUrl,
        pageTitle: result.pageTitle,
        confidence: slot.confidence,
        bookingState: result.bookingState || monitor.bookingState,
        bookingAttempt: result.bookingAttempt || null,
      };

      await postMonitorWebhook(monitor.alertWebhookUrl, alertPayload);
    }

    return result;
  } catch (err) {
    const errorResult = {
      checkedAt: new Date().toISOString(),
      manual,
      ok: false,
      error: err?.message || String(err),
    };
    monitor.lastError = errorResult;
    const persisted = await persistMonitorBookingState(monitor, errorResult);
    errorResult.bookingState = persisted?.bookingState || monitor.bookingState;
    monitor.history.push(errorResult);
    if (monitor.history.length > monitor.maxHistory) {
      monitor.history.splice(0, monitor.history.length - monitor.maxHistory);
    }
    return errorResult;
  } finally {
    monitor.inFlight = false;
  }
}

const HYBRID_TABLES = ['nodes', 'relationships', 'attributes'];

function isSafeSqlIdentifier(name) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(name || ''));
}

function summarizeResultForMemory(result = []) {
  if (!Array.isArray(result)) return [];
  return result.slice(0, 6).map((item) => {
    const sql = String(item?.sql || '');
    const rows = Array.isArray(item?.rows) ? item.rows.length : undefined;
    const docs = Array.isArray(item?.docs) ? item.docs.length : undefined;
    const answer = typeof item?.answer === 'string' ? item.answer.slice(0, 500) : undefined;
    const error = item?.error ? String(item.error).slice(0, 300) : undefined;

    return {
      mode: item?.mode || (sql ? 'sql' : (docs !== undefined ? 'semantic' : 'generic')),
      degraded: Boolean(item?.degraded),
      sql: sql ? sql.slice(0, 600) : null,
      rowCount: rows,
      docsCount: docs,
      answer,
      error,
    };
  });
}

function normalizeLayerMode(item = {}) {
  const mode = String(item?.mode || '').trim();
  if (mode) return mode;
  if (item?.result?.sql) return 'sql-rag';
  if (Array.isArray(item?.result?.docs)) return 'semantic-rag';
  return 'unknown';
}

function extractReferenceEntitiesFromRows(rows = []) {
  if (!Array.isArray(rows)) return [];
  const entities = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (typeof row.program_name === 'string' && row.program_name.trim()) {
      entities.push({
        kind: 'program',
        name: row.program_name.trim(),
        reference: row.program_reference || row.node_id || null,
      });
    }
    if (typeof row.infrastructure_name === 'string' && row.infrastructure_name.trim()) {
      entities.push({
        kind: 'infrastructure',
        name: row.infrastructure_name.trim(),
        reference: row.infrastructure_reference || row.node_id || null,
      });
    }
  }

  const dedup = new Map();
  for (const entity of entities) {
    const key = `${entity.kind}|${entity.name}|${entity.reference || ''}`;
    if (!dedup.has(key)) dedup.set(key, entity);
  }
  return Array.from(dedup.values());
}

function scoreLayerConfidence(layer = {}, decisionRoute = '') {
  const route = String(decisionRoute || '').toLowerCase();
  const mode = String(layer?.mode || 'unknown').toLowerCase();

  let score = 0.15;
  if (layer?.answer) score += 0.35;
  if (Number(layer?.rowCount || 0) > 0) score += Math.min(0.25, 0.05 * Math.min(Number(layer.rowCount), 5));
  if (Number(layer?.docsCount || 0) > 0) score += Math.min(0.20, 0.04 * Math.min(Number(layer.docsCount), 5));
  if (Array.isArray(layer?.entities) && layer.entities.length > 0) score += Math.min(0.20, 0.06 * Math.min(layer.entities.length, 3));
  if (layer?.error) score -= 0.45;
  if (layer?.degraded) score -= 0.25;

  const routeMatchesSql = route.includes('sql');
  const routeMatchesRag = route.includes('rag') || route.includes('semantic');
  if (routeMatchesSql && mode.includes('sql')) score += 0.12;
  if (routeMatchesRag && mode.includes('semantic')) score += 0.12;
  if (route === 'multi_step' && (mode.includes('sql') || mode.includes('semantic') || mode.includes('hybrid'))) score += 0.08;

  const normalized = Math.max(0, Math.min(1, score));
  const level = normalized >= 0.8
    ? 'high'
    : (normalized >= 0.55 ? 'medium' : 'low');

  return {
    score: Number(normalized.toFixed(3)),
    level,
  };
}

function buildLayerIntersection(rankedLayers = []) {
  const layers = Array.isArray(rankedLayers) ? rankedLayers : [];
  const usedModes = Array.from(new Set(layers.map((l) => String(l?.mode || '').trim()).filter(Boolean)));
  const totalLayers = usedModes.length;

  const supportMap = new Map();
  for (const layer of layers) {
    const mode = String(layer?.mode || '').trim() || 'unknown';
    const entities = Array.isArray(layer?.entities) ? layer.entities : [];
    for (const entity of entities) {
      const kind = String(entity?.kind || '').trim() || 'entity';
      const name = String(entity?.name || '').trim();
      const reference = entity?.reference ? String(entity.reference).trim() : null;
      if (!name) continue;

      const key = `${kind}|${name.toLowerCase()}|${(reference || '').toLowerCase()}`;
      if (!supportMap.has(key)) {
        supportMap.set(key, {
          kind,
          name,
          reference,
          agreeingLayers: new Set(),
        });
      }
      supportMap.get(key).agreeingLayers.add(mode);
    }
  }

  const entitySupport = Array.from(supportMap.values()).map((item) => {
    const agreeingLayers = Array.from(item.agreeingLayers);
    const supportRatio = totalLayers > 0 ? agreeingLayers.length / totalLayers : 0;
    return {
      kind: item.kind,
      name: item.name,
      reference: item.reference,
      agreeingLayers,
      supportRatio: Number(supportRatio.toFixed(3)),
    };
  }).sort((a, b) => {
    if (b.supportRatio !== a.supportRatio) return b.supportRatio - a.supportRatio;
    return a.name.localeCompare(b.name);
  });

  const strictIntersection = entitySupport.filter((e) => totalLayers > 1 && e.agreeingLayers.length === totalLayers);
  const commonEntities = entitySupport.filter((e) => e.agreeingLayers.length >= 2);

  const agreementScore = totalLayers <= 1
    ? (entitySupport.length > 0 ? 1 : 0)
    : (entitySupport.length > 0
      ? Number((entitySupport.reduce((sum, e) => sum + e.supportRatio, 0) / entitySupport.length).toFixed(3))
      : 0);

  return {
    totalLayers,
    minLayersForCommon: 2,
    agreementScore,
    strictIntersection,
    commonEntities,
    entitySupport,
  };
}

function buildFinalAggregatedAnswer({ result = [], decision = {}, degraded = false } = {}) {
  const layers = Array.isArray(result) ? result.map((item) => {
    const payload = item?.result && typeof item.result === 'object' ? item.result : item;
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    return {
      mode: normalizeLayerMode(item),
      answer: typeof payload?.answer === 'string' && payload.answer.trim() ? payload.answer.trim() : null,
      rowCount: rows.length,
      docsCount: Array.isArray(payload?.docs) ? payload.docs.length : 0,
      entities: extractReferenceEntitiesFromRows(rows),
      degraded: Boolean(item?.degraded || payload?.degraded),
      error: item?.error || payload?.error || null,
    };
  }) : [];

  const rankedLayers = layers
    .map((layer) => ({
      ...layer,
      confidence: scoreLayerConfidence(layer, decision?.route || ''),
    }))
    .sort((a, b) => Number(b?.confidence?.score || 0) - Number(a?.confidence?.score || 0));

  const answerParts = [];
  const seenAnswer = new Set();
  for (const layer of rankedLayers) {
    if (!layer.answer) continue;
    const key = layer.answer.toLowerCase();
    if (seenAnswer.has(key)) continue;
    seenAnswer.add(key);
    answerParts.push(layer.answer);
  }

  const allEntities = rankedLayers.flatMap((layer) => layer.entities || []);
  const uniqueEntities = [];
  const seenEntity = new Set();
  for (const entity of allEntities) {
    const key = `${entity.kind}|${entity.name}|${entity.reference || ''}`;
    if (seenEntity.has(key)) continue;
    seenEntity.add(key);
    uniqueEntities.push(entity);
  }

  if (uniqueEntities.length > 0) {
    const entityPreview = uniqueEntities.slice(0, 12).map((e) => {
      if (e.reference) return `${e.name} (reference: ${e.reference})`;
      return e.name;
    }).join(', ');
    answerParts.push(`Matched entities: ${entityPreview}.`);
  }

  const usedLayers = Array.from(new Set(rankedLayers.map((l) => l.mode).filter(Boolean)));
  const intersection = buildLayerIntersection(rankedLayers);
  const primaryLayer = rankedLayers.length > 0 ? {
    mode: rankedLayers[0].mode,
    confidence: rankedLayers[0].confidence,
  } : null;
  const defaultAnswer = degraded
    ? 'Partial answer generated from available layers. Use references to verify exact records.'
    : 'Answer generated from executed layers.';

  return {
    text: answerParts.length > 0 ? answerParts.join(' ') : defaultAnswer,
    usedLayers,
    primaryLayer,
    rankedLayers,
    intersection,
    decisionRoute: decision?.route || null,
    entities: uniqueEntities,
    layers: rankedLayers,
  };
}

function buildCompactResultSummary(result = []) {
  if (!Array.isArray(result)) return [];
  return result.map((item) => {
    const payload = item?.result && typeof item.result === 'object' ? item.result : item;
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    const docs = Array.isArray(payload?.docs) ? payload.docs : [];
    return {
      mode: normalizeLayerMode(item),
      query: item?.query || null,
      querySource: item?.querySource || null,
      answer: typeof payload?.answer === 'string' ? payload.answer : null,
      rowCount: rows.length,
      docsCount: docs.length,
      degraded: Boolean(item?.degraded || payload?.degraded),
      error: item?.error || payload?.error || null,
    };
  });
}

function enrichAskPayload(payload = {}) {
  const finalAnswer = buildFinalAggregatedAnswer({
    result: payload?.result || [],
    decision: payload?.decision || {},
    degraded: Boolean(payload?.degraded),
  });
  const requestProfile = payload?.requestProfile && typeof payload.requestProfile === 'object'
    ? payload.requestProfile
    : ((payload?.meta?.requestProfile && typeof payload.meta.requestProfile === 'object') ? payload.meta.requestProfile : null);
  const workflow = {
    orchestration: 'supervisor -> planner -> tool-calling-executor -> reflection',
    executor: 'runReactExecutionAgent',
    toolCallingAgent: 'reactAgent',
    langGraphConsidered: true,
    route: payload?.decision?.route || null,
    planSteps: Array.isArray(payload?.plan) ? payload.plan.length : 0,
  };
  return {
    ...payload,
    answer: finalAnswer.text,
    finalAnswer,
    resultSummary: buildCompactResultSummary(payload?.result || []),
    workflow,
    requestProfile,
  };
}

function withTimeout(promise, timeoutMs, label = 'operation') {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function buildDefaultLayeredSqlOptions(baseTimeoutMs = ASK_TIMEOUT_MS) {
  return {
    sqlRewriterEnabled: true,
    useGraph: true,
    multiAnchorEnabled: true,
    recursiveSqlEnabled: true,
    recursiveSqlMaxDepth: 2,
    proxyIndexLayerEnabled: true,
    semanticSimilarityInferenceEnabled: true,
    sqlIngestLayerEnabled: true,
    sqlRewriteWithGraphTraversal: true,
    executionTimeoutMs: Math.max(8000, Math.floor(baseTimeoutMs * 0.5)),
  };
}

function normalizeAskSqlOptions(source = {}, baseTimeoutMs = ASK_TIMEOUT_MS) {
  const defaults = buildDefaultLayeredSqlOptions(baseTimeoutMs);
  const input = source && typeof source === 'object' ? source : {};
  const parsedDepth = Number(input.recursiveSqlMaxDepth);
  const parsedTimeout = Number(input.executionTimeoutMs);

  return {
    ...defaults,
    sqlRewriterEnabled: typeof input.sqlRewriterEnabled === 'boolean' ? input.sqlRewriterEnabled : defaults.sqlRewriterEnabled,
    useGraph: typeof input.useGraph === 'boolean' ? input.useGraph : defaults.useGraph,
    multiAnchorEnabled: typeof input.multiAnchorEnabled === 'boolean' ? input.multiAnchorEnabled : defaults.multiAnchorEnabled,
    recursiveSqlEnabled: typeof input.recursiveSqlEnabled === 'boolean' ? input.recursiveSqlEnabled : defaults.recursiveSqlEnabled,
    recursiveSqlMaxDepth: Number.isFinite(parsedDepth) ? Math.max(0, parsedDepth) : defaults.recursiveSqlMaxDepth,
    proxyIndexLayerEnabled: typeof input.proxyIndexLayerEnabled === 'boolean' ? input.proxyIndexLayerEnabled : defaults.proxyIndexLayerEnabled,
    semanticSimilarityInferenceEnabled: typeof input.semanticSimilarityInferenceEnabled === 'boolean' ? input.semanticSimilarityInferenceEnabled : defaults.semanticSimilarityInferenceEnabled,
    sqlIngestLayerEnabled: typeof input.sqlIngestLayerEnabled === 'boolean' ? input.sqlIngestLayerEnabled : defaults.sqlIngestLayerEnabled,
    sqlRewriteWithGraphTraversal: typeof input.sqlRewriteWithGraphTraversal === 'boolean' ? input.sqlRewriteWithGraphTraversal : defaults.sqlRewriteWithGraphTraversal,
    executionTimeoutMs: Number.isFinite(parsedTimeout) ? Math.max(3000, parsedTimeout) : defaults.executionTimeoutMs,
  };
}

function applyLayeredSqlOptionsToPlan(plan = [], sqlOptions = {}) {
  if (!Array.isArray(plan)) return [];

  const layered = sqlOptions && typeof sqlOptions === 'object' ? { ...sqlOptions } : {};
  if (Object.keys(layered).length === 0) return plan;

  return plan.map((step) => {
    const tool = String(step?.tool || '');
    if (!['sql_query', 'sql_rag_query', 'rag_search', 'semantic_rag_query', 'hybrid_query'].includes(tool)) {
      return step;
    }

    const params = step?.params && typeof step.params === 'object' ? { ...step.params } : {};
    const existingSqlOptions = params.sqlOptions && typeof params.sqlOptions === 'object' ? params.sqlOptions : {};
    return {
      ...step,
      params: {
        ...params,
        sqlOptions: {
          ...layered,
          ...existingSqlOptions,
        },
      },
    };
  });
}

async function persistConversationTurn({ userId = null, query = '', decision = {}, plan = [], result = [], reflection = {}, meta = {} } = {}) {
  await remember({
    userId,
    agent: 'orchestrator-ask',
    query,
    response: {
      decision,
      plan: Array.isArray(plan) ? plan.map((s) => ({ tool: s?.tool, params: s?.params || {} })) : [],
      result: summarizeResultForMemory(result),
      reflection,
      meta,
    },
  });
}

async function buildTimeoutFallbackPayload({ query, userId = null, timeoutMessage = '', totalTimeoutMs = ASK_TIMEOUT_MS, context = {}, authContext = null } = {}) {
  const dbLike = isLikelyDbQuestion(query);
  const fallbackTool = dbLike ? 'sql_rag_query' : 'semantic_rag_query';
  const fallbackPlan = [{ tool: fallbackTool }];
  const fallbackTimeoutMs = Math.max(3000, Math.floor(ASK_FALLBACK_BUDGET_MS * 0.8));
  const effectiveAskSqlOptions = normalizeAskSqlOptions(context?.sqlOptions, fallbackTimeoutMs);
  const requestProfile = { sqlOptions: effectiveAskSqlOptions };

  let fallbackResult;
  try {
    if (dbLike) {
      const sqlResult = await withTimeout(
        runAskSqlWithSecurity({
          query,
          userId,
          authContext,
          requestedAgent: chooseAskRequestedAgent({ toolName: 'sql_rag_query', query }),
          sqlOptions: {
            ...effectiveAskSqlOptions,
            executionTimeoutMs: Math.max(3000, Math.floor(fallbackTimeoutMs * 0.8)),
          },
        }),
        fallbackTimeoutMs,
        'ask-timeout-fallback-sql',
      );
      fallbackResult = [{ mode: 'sql-rag', query, result: sqlResult, degraded: true }];
    } else {
      const ragResult = await withTimeout(
        runRagTool({ query, topK: 5, useRerank: false, userId, sqlOptions: effectiveAskSqlOptions }),
        fallbackTimeoutMs,
        'ask-timeout-fallback-rag',
      );
      fallbackResult = [{ mode: 'semantic-rag', query, result: ragResult, degraded: true }];
    }
  } catch (fallbackErr) {
    fallbackResult = [{
      mode: 'fallback',
      query,
      degraded: true,
      error: `Fallback failed: ${String(fallbackErr?.message || fallbackErr)}`,
      answer: 'Unable to complete full orchestration in time. Try a narrower question or use the SQL/RAG direct tool buttons.',
    }];
  }

  const payload = {
    degraded: true,
    timeout: {
      message: timeoutMessage,
      totalMs: totalTimeoutMs,
      orchestrationMs: ASK_ORCHESTRATION_TIMEOUT_MS,
      fallbackBudgetMs: ASK_FALLBACK_BUDGET_MS,
    },
    decision: {
      route: 'timeout-fallback',
      reason: timeoutMessage || 'ask-orchestration-timeout',
    },
    plan: fallbackPlan,
    result: fallbackResult,
    reflection: { quality: 'degraded', feedback: 'Returned fallback result after orchestration timeout.' },
    recommendation: 'Try a narrower question or use /api/tools/sql or /api/tools/rag directly.',
    requestProfile,
  };

  await persistConversationTurn({
    userId,
    query,
    decision: payload.decision,
    plan: payload.plan,
    result: payload.result,
    reflection: payload.reflection,
    meta: {
      phase: 'ask-timeout-fallback',
      degraded: true,
      timeoutMessage,
      totalTimeoutMs,
      orchestrationTimeoutMs: ASK_ORCHESTRATION_TIMEOUT_MS,
      fallbackBudgetMs: ASK_FALLBACK_BUDGET_MS,
      requestProfile,
    },
  });

  return enrichAskPayload(payload);
}

// Full orchestration route: supervisor -> planner -> react execution -> MCP tools -> reflection.
app.post('/ask', attachAuthenticatedUserContext, async (req, res) => {
  const { query, userId = null, context = {} } = req.body || {};
  // Default useRerank to true if USE_RERANKER=true in .env, unless overridden by request/context
  const ENV_USE_RERANKER = String(process.env.USE_RERANKER || '').toLowerCase() === 'true';
  let effectiveUseRerank = ENV_USE_RERANKER;
  if (context && typeof context === 'object' && Object.prototype.hasOwnProperty.call(context, 'useRerank')) {
    effectiveUseRerank = Boolean(context.useRerank);
  }
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid query' });
  }

  try {
    const payload = await withTimeout((async () => {
    const conversationContext = await getConversationContext({
      userId,
      limit: parseInt(process.env.ORCHESTRATOR_MEMORY_CONTEXT_LIMIT || '6', 10),
    });
    const effectiveAskSqlOptions = normalizeAskSqlOptions(context?.sqlOptions, ASK_TIMEOUT_MS);

    // Per-request QB overrides: context.queryBuilder.enabled / .strategy from the request body
    // take precedence over the global env flags, allowing the UI to toggle QB per call.
    const reqQb = context?.queryBuilder && typeof context.queryBuilder === 'object' ? context.queryBuilder : null;
    const effectiveUseQueryBuilder = reqQb?.enabled != null ? Boolean(reqQb.enabled) : ASK_USE_QUERY_BUILDER;
    const effectiveQbStrategy = reqQb?.strategy ? String(reqQb.strategy) : ASK_QUERY_BUILDER_STRATEGY;
    const queryBuilderStrategy = normalizeAskQueryBuilderStrategy(effectiveQbStrategy);

    let queryBuilderHints = null;
    if (effectiveUseQueryBuilder) {
      try {
        const qbResult = await runQueryBuilderAgent({
          query,
          userId,
          mode: 'auto',
          execute: false,
          executionMode: 'mcp',
          sqlRewriterEnabled: Boolean(effectiveAskSqlOptions?.sqlRewriterEnabled),
          recursiveSqlEnabled: Boolean(effectiveAskSqlOptions?.recursiveSqlEnabled),
          recursiveSqlMaxDepth: Number(effectiveAskSqlOptions?.recursiveSqlMaxDepth || 0),
          proxyIndexLayerEnabled: Boolean(effectiveAskSqlOptions?.proxyIndexLayerEnabled),
          semanticSimilarityInferenceEnabled: Boolean(effectiveAskSqlOptions?.semanticSimilarityInferenceEnabled),
          sqlIngestLayerEnabled: Boolean(effectiveAskSqlOptions?.sqlIngestLayerEnabled),
        });

        queryBuilderHints = {
          sqlTop: String(qbResult?.sqlRagQueries?.[0] || '').trim(),
          semanticTop: String(qbResult?.semanticRagQueries?.[0] || '').trim(),
          mode: String(qbResult?.mode || 'auto'),
        };
      } catch (qbErr) {
        queryBuilderHints = {
          error: String(qbErr?.message || qbErr),
          sqlTop: '',
          semanticTop: '',
          mode: 'auto',
        };
      }
    }

    const requestProfile = {
      sqlOptions: effectiveAskSqlOptions,
      queryBuilder: {
        enabled: effectiveUseQueryBuilder,
        strategy: queryBuilderStrategy,
        sqlTop: String(queryBuilderHints?.sqlTop || ''),
        semanticTop: String(queryBuilderHints?.semanticTop || ''),
        error: queryBuilderHints?.error || null,
      },
    };
    const orchestrationContext = {
      ...(context || {}),
      sqlOptions: effectiveAskSqlOptions,
      recentConversation: conversationContext,
      useRerank: effectiveUseRerank,
    };
    const runAskPlan = async (planToRun = []) => {
      const queryBuilderAwarePlan = applyAskQueryBuilderToPlan({
        plan: planToRun,
        fallbackQuery: query,
        strategy: queryBuilderStrategy,
        queryBuilderHints,
      });
      const securedRuntimePlan = applyAskSecurityContextToPlan(queryBuilderAwarePlan, req.authContext, query);
      return runReactExecutionAgent({ plan: securedRuntimePlan, userQuery: query, userId });
    };

    const statusId = extractRequestStatusIdFromText(query);
    if (statusId) {
      const decision = { route: 'request_status', reason: 'matched-request-status-intent' };
      const plan = [{ tool: 'get_request_status', params: { id: statusId } }];
      const contextualPlan = applyMappedAgentContextToPlan(plan);
      const result = await runAskPlan(contextualPlan);
      const reflection = await reflect(query, JSON.stringify(result), { userId });
      await persistConversationTurn({ userId, query, decision, plan: contextualPlan, result, reflection, meta: { phase: 'request-status', requestProfile } });
      return enrichAskPayload({ decision, plan: contextualPlan, result, reflection, requestProfile });
    }

    const qLower = String(query || '').toLowerCase();
    if (qLower.includes('schedule an appointment') || qLower.includes('new request for goverment') || qLower.includes('new request for government')) {
      const decision = { route: 'request_create', reason: 'matched-create-request-intent' };
      const plan = [{
        tool: 'new_request_for_government',
        params: {
          userId,
          description: query,
        },
      }];
      const contextualPlan = applyMappedAgentContextToPlan(plan);
      const result = await runAskPlan(contextualPlan);
      const reflection = await reflect(query, JSON.stringify(result), { userId });
      await persistConversationTurn({ userId, query, decision, plan: contextualPlan, result, reflection, meta: { phase: 'request-create', requestProfile } });
      return enrichAskPayload({ decision, plan: contextualPlan, result, reflection, requestProfile });
    }

    const matchedUris = extractAllowedUrisFromText(query);
    if (matchedUris.length > 0) {
      const decision = { route: 'web_query', reason: 'matched-approved-uri' };
      const plan = matchedUris.length === 1
        ? [{ tool: 'fetch_public_uri_json', params: { url: matchedUris[0], maxChars: 5000 } }]
        : [{ tool: 'fetch_public_uris_json', params: { urls: matchedUris, maxChars: 2500 } }];
      const contextualPlan = applyMappedAgentContextToPlan(plan);
      const result = await runAskPlan(contextualPlan);
      const reflection = await reflect(query, JSON.stringify(result), { userId });
      await persistConversationTurn({ userId, query, decision, plan: contextualPlan, result, reflection, meta: { phase: 'web-query', matchedUris: matchedUris.length, requestProfile } });
      return enrichAskPayload({ decision, plan: contextualPlan, result, reflection, requestProfile });
    }

    // Fast-path for clearly structured database questions to avoid slow semantic-only fallback loops.
    if (isLikelyDbQuestion(query) && !wantsSemanticContext(query)) {
      const decision = { route: 'sql_query_fastpath', reason: 'matched-db-keywords' };
      const plan = applyMappedAgentContextToPlan([{ tool: 'sql_rag_query' }]);
      let result = [];
      try {
        const fastPathQueries = buildAskExecutionQueries({
          originalQuery: query,
          queryBuilderQuery: queryBuilderHints?.sqlTop || '',
          strategy: queryBuilderStrategy,
        });
        const totalFastPathBudgetMs = Math.max(10000, Math.floor(ASK_TIMEOUT_MS * 0.45));
        const perQueryBudgetMs = Math.max(5000, Math.floor(totalFastPathBudgetMs / Math.max(1, fastPathQueries.length || 1)));

        for (const qItem of fastPathQueries) {
          const effectiveQuery = String(qItem?.query || '').trim();
          if (!effectiveQuery) continue;
          try {
            const sqlResult = await withTimeout(
              runAskSqlWithSecurity({
                query: effectiveQuery,
                userId,
                authContext: req.authContext,
                requestedAgent: chooseAskRequestedAgent({ toolName: 'sql_rag_query', query: effectiveQuery }),
                sqlOptions: {
                  ...effectiveAskSqlOptions,
                  executionTimeoutMs: Math.max(8000, Math.floor(ASK_TIMEOUT_MS * 0.35)),
                },
              }),
              perQueryBudgetMs,
              'ask-sql-fastpath',
            );
            result.push({ mode: 'sql-rag', query: effectiveQuery, querySource: qItem.source || 'user', result: sqlResult });
          } catch (innerErr) {
            result.push({
              mode: 'sql-rag',
              query: effectiveQuery,
              querySource: qItem.source || 'user',
              degraded: true,
              error: `SQL fast-path failed: ${String(innerErr?.message || innerErr)}`,
            });
          }
        }

        if (result.length === 0) {
          throw new Error('No valid fast-path queries produced');
        }
      } catch (sqlErr) {
        result = [{
          mode: 'fallback',
          query,
          degraded: true,
          error: `SQL fast-path failed: ${String(sqlErr?.message || sqlErr)}`,
          answer: 'Unable to answer quickly for this query right now. Try /api/tools/sql directly with a narrower query.',
        }];
      }
      const hasDegraded = Array.isArray(result) && result.some((r) => r && (r.degraded || String(r.error || '').toLowerCase().includes('429') || String(r.error || '').toLowerCase().includes('timed out')));
      const reflection = hasDegraded
        ? { quality: 'improve', feedback: 'Reflection skipped due degraded upstream/tooling state.' }
        : await reflect(query, JSON.stringify(result), { userId });
      await persistConversationTurn({ userId, query, decision, plan, result, reflection, meta: { phase: 'sql-fastpath', degraded: hasDegraded, requestProfile } });
      return enrichAskPayload({ decision, plan, result, reflection, requestProfile });
    }

    const decision = await supervisor(query, { userId, context: orchestrationContext });
    const queryNature = detectQueryNature(query);

    let plan = [];
    if (decision.route === 'multi_step') {
      const sup = await supervise({ userQuery: query, context: orchestrationContext, userId });
      plan = (sup.plan || []).map((step) => ({
        ...step,
        tool:
          step.tool
          || (step.type === 'sql'
            ? 'sql_query'
            : step.type === 'rag'
              ? 'rag_search'
              : step.type === 'web'
                ? 'fetch_public_uri_json'
              : step.type === 'action'
                ? 'sql_action'
                : step.type === 'memory'
                  ? 'store_memory'
                  : undefined),
      })).filter((s) => s.tool === 'sql_query'
        || s.tool === 'sql_rag_query'
        || s.tool === 'rag_search'
        || s.tool === 'semantic_rag_query'
        || s.tool === 'hybrid_query'
        || s.tool === 'langgraph_retrieval_query'
        || s.tool === 'retrieval_compare'
        || s.tool === 'retrieval_compare_eval'
        || s.tool === 'fetch_public_uri_json'
        || s.tool === 'fetch_public_uris_json'
        || s.tool === 'new_request_for_goverment'
        || s.tool === 'new_request_for_government'
        || s.tool === 'get_request_status'
        || s.tool === 'update_request_status'
        || s.tool === 'ingest_municipality_web_to_rag'
        || s.tool === 'ingest_sql_corpus_to_rag'
        || s.tool === 'sql_action'
        || s.tool === 'store_memory');
      if (plan.length === 0) {
        plan = queryNature.primaryPlan;
      }
    }

    if (decision.route === 'sql_query') plan = [{ tool: 'sql_rag_query' }];
    if (decision.route === 'rag_query') {
      plan = queryNature.primaryPlan;
    }

    const safePlan = Array.isArray(plan) ? plan.slice(0, Math.max(1, MAX_EXECUTION_STEPS)) : [];
    const layeredPlan = applyLayeredSqlOptionsToPlan(safePlan, effectiveAskSqlOptions);
    const contextualPlan = applyMappedAgentContextToPlan(layeredPlan);
    let result = await runAskPlan(contextualPlan);

    // Nature-aware fallback: retry using SQL-RAG or semantic-RAG (or both) based on query intent.
    const degradedResults = Array.isArray(result)
      && result.length > 0
      && result.every((r) => r && (r.degraded || String(r.error || '').toLowerCase().includes('429')));
    if (degradedResults) {
      result = await runAskPlan(applyMappedAgentContextToPlan(applyLayeredSqlOptionsToPlan(queryNature.fallbackPlan, effectiveAskSqlOptions)));
    }

    const hasDegraded = Array.isArray(result) && result.some((r) => r && (r.degraded || String(r.error || '').toLowerCase().includes('429')));
    const reflection = hasDegraded
      ? { quality: 'improve', feedback: 'Reflection skipped due degraded upstream/tooling state.' }
      : await reflect(query, JSON.stringify(result), { userId });

    await persistConversationTurn({
      userId,
      query,
      decision,
      plan: contextualPlan,
      result,
      reflection,
      meta: {
        queryNature: queryNature.type,
        degraded: hasDegraded,
        memoryContextSize: Array.isArray(conversationContext) ? conversationContext.length : 0,
        memoryContextQueries: Array.isArray(conversationContext)
          ? conversationContext.slice(0, 3).map((m) => m.query)
          : [],
        maxExecutionSteps: MAX_EXECUTION_STEPS,
        plannerProduced: Array.isArray(plan) ? plan.length : 0,
        executed: contextualPlan.length,
        requestProfile,
      },
    });

    return enrichAskPayload({
      decision,
      plan: contextualPlan,
      result,
      reflection,
      requestProfile,
      boundaries: {
        maxExecutionSteps: MAX_EXECUTION_STEPS,
        plannerProduced: Array.isArray(plan) ? plan.length : 0,
        executed: contextualPlan.length,
      },
    });
    })(), ASK_ORCHESTRATION_TIMEOUT_MS, 'ask-orchestration');

    return res.json(payload);
  } catch (err) {
    const msg = String(err?.message || 'Unknown ask failure');
    if (msg.includes('timed out')) {
      const degradedPayload = await buildTimeoutFallbackPayload({
        query,
        userId,
        timeoutMessage: msg,
        totalTimeoutMs: ASK_TIMEOUT_MS,
        context,
        authContext: req.authContext,
      });
      return res.json(degradedPayload);
    }
    return res.status(500).json({ error: msg });
  }
});

app.post('/api/classify', async (req, res) => {
  const { query, userId = null } = req.body;
  try {
    const kind = await classifyQuery(query, { userId });
    res.json({ kind });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agents/semantic-rag', async (req, res) => {
  const { query, topK = undefined, useRerank = false, systemPrompt = '', userId = null, sqlOptions = {} } = req.body;
  try {
    const safeSystemPrompt = resolveSystemPromptFromRequest(systemPrompt, '/api/agents/semantic-rag');
    const result = await runSemanticRAG({
      query,
      topK: topK == null ? undefined : topK,
      useRerank,
      systemPrompt: safeSystemPrompt,
      userId,
      sqlOptions,
    });
    res.json(result);
  } catch (err) {
    res.status(err?.statusCode || 500).json({ error: err.message });
  }
});

app.post('/api/agents/sql-rag', async (req, res) => {
  const { query, systemPrompt = '', userId = null, sqlOptions = {} } = req.body;
  try {
    const safeSystemPrompt = resolveSystemPromptFromRequest(systemPrompt, '/api/agents/sql-rag');
    const result = await runSQLRAG({ userQuery: query, systemPrompt: safeSystemPrompt, userId, sqlOptions });
    res.json(result);
  } catch (err) {
    res.status(err?.statusCode || 500).json({ error: err.message });
  }
});

app.post('/api/agents/langgraph-retrieval', async (req, res) => {
  const {
    query,
    userId = null,
    sessionId = null,
    threadId = null,
    evalMode = false,
    sqlOptions = {},
  } = req.body || {};

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid query' });
  }

  try {
    const result = await runLangGraphRetrieval({
      query,
      userId,
      sessionId,
      threadId,
      evalMode: Boolean(evalMode),
      sqlOptions,
    });
    return res.json(result);
  } catch (err) {
    return res.status(err?.statusCode || 500).json({ error: err.message });
  }
});

app.post('/api/eval/retrieval-compare', async (req, res) => {
  const { query, userId = null, evalMode = true, sqlOptions = {} } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid query' });
  }

  try {
    const result = await compareBaselineVsLangGraph({ query, userId, evalMode: Boolean(evalMode), sqlOptions });
    return res.json(result);
  } catch (err) {
    return res.status(err?.statusCode || 500).json({ error: err.message });
  }
});

app.post('/api/pipeline/rag-scientific', async (req, res) => {
  const { query = '', skipBootstrap = false, topK = 8, output = './tmp/rag-scientific-report.json', includeFrozenEval = false } = req.body || {};
  try {
    const execution = runScientificPipelineFromServer({ query, skipBootstrap: Boolean(skipBootstrap), topK, output });
    const artifactPath = execution.output;
    const artifactRaw = await fs.readFile(artifactPath, 'utf8');
    const artifact = JSON.parse(artifactRaw);
    const frozenEval = includeFrozenEval
      ? await runFrozenRagasRecordsEvaluation({ artifactPath })
      : null;
    return res.json({ ok: true, execution, artifact, frozenEval });
  } catch (err) {
    return res.status(err?.statusCode || 500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/pipeline/rag-html-booking-booster', async (req, res) => {
  const {
    query = '',
    topK = 8,
    urls = [],
    replaceExisting = true,
    chunkSize = 900,
    chunkOverlap = 120,
    maxChunksPerUrl = 45,
    minRelevanceScore = 1,
    fetchTimeoutMs = 20000,
    enableSqlStage = false,
    forceSqlStage = false,
    enableLangGraphStage = false,
    forceLangGraphStage = false,
    enableQualityGate = false,
  } = req.body || {};

  try {
    const result = runHtmlRagBookingBoosterFromServer({
      query,
      topK,
      urls,
      replaceExisting,
      chunkSize,
      chunkOverlap,
      maxChunksPerUrl,
      minRelevanceScore,
      fetchTimeoutMs,
      enableSqlStage,
      forceSqlStage,
      enableLangGraphStage,
      forceLangGraphStage,
      enableQualityGate,
    });
    return res.json({ ok: true, result });
  } catch (err) {
    return res.status(err?.statusCode || 500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/eval/ragas-frozen-records', async (req, res) => {
  const { artifactPath = './tmp/rag-scientific-report.json' } = req.body || {};
  try {
    const result = await runFrozenRagasRecordsEvaluation({ artifactPath });
    return res.json(result);
  } catch (err) {
    return res.status(err?.statusCode || 500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/agents/query-builder', async (req, res) => {
  const {
    query,
    userId = null,
    mode = 'auto',
    execute = false,
    // executionMode: 'mcp' | 'langgraph' | 'local-tools' | 'direct-agents' (or 'direct' alias)
    executionMode = 'mcp',
    useGraph = true,
    reasoningMode = 'explicit',
    multiAnchorEnabled = true,
    sqlRewriterEnabled = true,
    recursiveSqlEnabled = true,
    recursiveSqlMaxDepth = 2,
    proxyIndexLayerEnabled = true,
    semanticSimilarityInferenceEnabled = true,
    sqlIngestLayerEnabled = true,
    maxCycles,
    systemPrompt = '',
  } = req.body || {};

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid query' });
  }

  try {
    const safeSystemPrompt = resolveSystemPromptFromRequest(systemPrompt, '/api/agents/query-builder');
    const result = await runQueryBuilderAgent({
      query,
      userId,
      mode,
      execute,
      executionMode,
      useGraph,
      reasoningMode,
      multiAnchorEnabled,
      sqlRewriterEnabled,
      recursiveSqlEnabled,
      recursiveSqlMaxDepth,
      proxyIndexLayerEnabled,
      semanticSimilarityInferenceEnabled,
      sqlIngestLayerEnabled,
      maxCycles,
      systemPrompt: safeSystemPrompt,
    });
    res.json(result);
  } catch (err) {
    res.status(err?.statusCode || 500).json({ error: err.message });
  }
});

// Explicit tool endpoints for direct access to sql/rag/memory tools.
app.post('/api/tools/sql', async (req, res) => {
  const { query, systemPrompt = '', userId = null, sqlOptions = {} } = req.body;
  try {
    const safeSystemPrompt = resolveSystemPromptFromRequest(systemPrompt, '/api/tools/sql');
    const result = await runSqlTool({ userQuery: query, systemPrompt: safeSystemPrompt, userId, sqlOptions });
    res.json(result);
  } catch (err) {
    res.status(err?.statusCode || 500).json({ error: err.message });
  }
});

// Defense-in-depth secure SQL route:
// User -> API -> JWT verify -> load permissions -> orchestrator -> guard(AST) -> pool(read/write/stats) -> execute -> return
app.post('/api/secure-agent/query', async (req, res) => {
  const {
    query,
    requestedAgent = '',
    userId = null,
    permissionKey = '',
    managerAction = '',
    managerPayload = {},
  } = req.body || {};
  const routedAgent = routeSecureAgentByIntent({ query, requestedAgent });
  const isManagerRequest = routedAgent === 'manager_agent';

  if (!isManagerRequest && (!query || typeof query !== 'string')) {
    return res.status(400).json({ ok: false, mode: 'secure-agent', error: 'Missing or invalid query' });
  }
  if (isManagerRequest && !managerAction && (!query || typeof query !== 'string')) {
    return res.status(400).json({ ok: false, mode: 'secure-agent', error: 'Manager request requires query or managerAction' });
  }

  const authContext = req.authContext || null;
  const jwtValidation = authContext
    ? { ok: true, user: authContext.jwtUser }
    : verifyJwtFromRequest(req);

  if (!jwtValidation.ok) {
    return res.status(401).json({
      ok: false,
      mode: 'secure-agent',
      error: `JWT verification failed: ${jwtValidation.reason}`,
      expectedFlow: ['Authorization Bearer JWT', 'JWT verify', 'load user + role', 'load permissions', 'orchestrator', 'agent guard + AST', 'pool selection', 'execute query'],
    });
  }

  try {
    const effectiveUserId = String(authContext?.userId || userId || jwtValidation.user.userId || '').trim();
    const permissions = authContext?.permissions || await getUserPermissions(effectiveUserId, jwtValidation.user.role, {
      includeTablePermissions: false,
      source: 'api:/api/secure-agent/query',
    });
    if (!permissions.ok) {
      return res.status(403).json({
        ok: false,
        mode: 'secure-agent',
        error: `Permission loading failed: ${permissions.reason || 'unknown'}`,
      });
    }

    if (isManagerRequest) {
      const managerRole = String(permissions?.user?.roleName || jwtValidation.user.role || '').trim().toLowerCase();
      const managerAccess = getManagerAccessDecision({ role: managerRole, permissions });
      if (!managerAccess.allowed) {
        return res.status(403).json({
          ok: false,
          mode: 'secure-agent',
          error: 'manager_agent requires admin role or write permissions',
          accessVia: managerAccess.via,
        });
      }

      let effectiveAction = String(managerAction || '').trim().toLowerCase();
      let effectivePayload = (managerPayload && typeof managerPayload === 'object') ? { ...managerPayload } : {};

      if (!effectiveAction && query) {
        const planner = await runAgentManagerFlow({ userRequest: query, context: { routerPrompt: ROUTER_PROMPT } });
        if (!planner?.ok) {
          return res.status(400).json({
            ok: false,
            mode: 'secure-agent',
            error: 'manager_agent could not parse action from query',
            planner,
          });
        }
        effectiveAction = normalizeManagerAction(planner?.action || planner?.params?.action || '');
        effectivePayload = {
          ...effectivePayload,
          ...(planner?.params && typeof planner.params === 'object' ? planner.params : {}),
        };
      }

      const managerResult = await runManagerAgentOperation({
        action: effectiveAction,
        payload: effectivePayload,
        actorUserId: effectiveUserId,
        actorUsername: effectiveUserId,
        role: managerRole,
        permissions,
      });

      const statusCode = managerResult?.ok ? 200 : (managerResult?.reason === 'forbidden' ? 403 : 400);
      return res.status(statusCode).json({
        ok: Boolean(managerResult?.ok),
        mode: 'secure-agent',
        flow: [
          'User request',
          'HTTP Authorization Bearer JWT',
          'JWT verify',
          'Load user + role',
          'Load permissions',
          'Orchestrator Agent',
          'Manager Agent',
          'Write operation',
          'Return result',
        ],
        orchestrator: {
          requestedAgent: requestedAgent || null,
          routedByPrompt: 'manager_agent',
          selectedAgent: 'manager_agent',
          requiredPermissionKey: 'canWrite',
          routerPrompt: ROUTER_PROMPT.trim(),
        },
        manager: {
          action: String(effectiveAction || '').trim().toLowerCase(),
          accessVia: String(managerResult?.accessVia || managerAccess.via || 'unknown'),
        },
        permissions: {
          user: permissions.user,
          rolePermissions: permissions.rolePermissions,
        },
        ...managerResult,
      });
    }

    const orchestration = await runSecureAgentSqlFlow({
      userRequest: query,
      jwtUser: {
        userId: effectiveUserId,
        role: permissions.user?.roleName || jwtValidation.user.role,
      },
      userPermissions: permissions,
      requestedAgent: routedAgent,
      permissionKey,
    });

    const statusCode = orchestration?.ok ? 200 : 403;
    return res.status(statusCode).json({
      ok: Boolean(orchestration?.ok),
      mode: 'secure-agent',
      flow: [
        'User request',
        'HTTP Authorization Bearer JWT',
        'JWT verify',
        'Load user + role',
        'Load permissions',
        'Orchestrator Agent',
        'LLM generate SQL',
        'SQL AST parser',
        'Agent Guard validation',
        'Detect query type',
        'Choose pool',
        'Execute query',
        'Log query',
        'Return result',
      ],
      orchestrator: {
        requestedAgent: requestedAgent || null,
        routedByPrompt: routedAgent,
        routerPrompt: ROUTER_PROMPT.trim(),
        selectedAgent: orchestration?.selectedAgent || null,
        requiredPermissionKey: orchestration?.requiredPermissionKey ?? (permissionKey ? String(permissionKey).toLowerCase() : null),
      },
      pools: {
        read: 'DB_READ_USER / readPool',
        write: 'DB_WRITE_USER / writePool',
        statistics: 'DB_STATS_USER / statisticsPool',
        chosen: orchestration?.poolName || null,
      },
      permissions: {
        user: permissions.user,
        rolePermissions: orchestration?.rolePermissions || permissions.rolePermissions,
      },
      ...orchestration,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, mode: 'secure-agent', error: err?.message || String(err) });
  }
});

app.post('/api/tools/sql-via-mcp', async (req, res) => {
  const { query, userId = null, sqlOptions = {} } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid query' });
  }

  try {
    const result = await callMcpTool('sql_rag_query', { query, userId, sqlOptions }, { authorization: req.headers?.authorization || '' });
    res.json({ via: 'mcp', tool: 'sql_rag_query', result });
  } catch (err) {
    res.status(500).json({ error: err.message, via: 'mcp', tool: 'sql_rag_query' });
  }
});

app.post('/api/tools/rag-via-mcp', async (req, res) => {
  const { query, topK = 5, useRerank = false, systemPrompt = '', userId = null, sqlOptions = {} } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid query' });
  }

  try {
    const safeSystemPrompt = resolveSystemPromptFromRequest(systemPrompt, '/api/tools/rag-via-mcp');
    const result = await callMcpTool('semantic_rag_query', {
      query,
      topK,
      useRerank,
      systemPrompt: safeSystemPrompt,
      userId,
      sqlOptions,
    }, { authorization: req.headers?.authorization || '' });
    res.json({ via: 'mcp', tool: 'semantic_rag_query', result });
  } catch (err) {
    res.status(500).json({ error: err.message, via: 'mcp', tool: 'semantic_rag_query' });
  }
});

app.post('/api/tools/langgraph-via-mcp', async (req, res) => {
  const { query, userId = null, sessionId = null, threadId = null, evalMode = false, sqlOptions = {} } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid query' });
  }

  try {
    const result = await callMcpTool('langgraph_retrieval_query', {
      query,
      userId,
      sessionId,
      threadId,
      evalMode: Boolean(evalMode),
      sqlOptions,
    }, { authorization: req.headers?.authorization || '' });
    res.json({ via: 'mcp', tool: 'langgraph_retrieval_query', result });
  } catch (err) {
    res.status(500).json({ error: err.message, via: 'mcp', tool: 'langgraph_retrieval_query' });
  }
});

app.post('/api/tools/rag', async (req, res) => {
  const { query, topK = 5, useRerank = false, systemPrompt = '', userId = null, sqlOptions = {} } = req.body;
  try {
    const safeSystemPrompt = resolveSystemPromptFromRequest(systemPrompt, '/api/tools/rag');
    const result = await runRagTool({ query, topK, useRerank, systemPrompt: safeSystemPrompt, userId, sqlOptions });
    res.json(result);
  } catch (err) {
    res.status(err?.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/tools/memory', async (req, res) => {
  const userId = req.query.userId || null;
  const agent = req.query.agent || 'semantic-rag';
  const limit = parseInt(req.query.limit || '5', 10);
  try {
    const result = memoryTool({ agent, userId, limit });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tables', async (req, res) => {
  try {
    const query = `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `;
    const result = await pool.query(query);
    res.json(result.rows.map((r) => r.table_name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tables/:name', async (req, res) => {
  const tableName = req.params.name;
  if (!isSafeSqlIdentifier(tableName)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }

  try {
    const rows = await pool.query(`SELECT * FROM ${tableName} LIMIT 100`);
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/schema/hybrid', async (req, res) => {
  try {
    const columnsQuery = `
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position;
    `;

    const foreignKeysQuery = `
      SELECT
        tc.table_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name,
        tc.constraint_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = ANY($1::text[])
      ORDER BY tc.table_name, tc.constraint_name;
    `;

    const [columnsRes, fkRes] = await Promise.all([
      pool.query(columnsQuery, [HYBRID_TABLES]),
      pool.query(foreignKeysQuery, [HYBRID_TABLES]),
    ]);

    const tables = HYBRID_TABLES.map((name) => ({ tableName: name, columns: [], embeddings: [] }));
    const tableMap = new Map(tables.map((t) => [t.tableName, t]));

    for (const row of columnsRes.rows) {
      const target = tableMap.get(row.table_name);
      if (!target) continue;
      const col = {
        columnName: row.column_name,
        dataType: row.data_type,
        isEmbedding: String(row.column_name).toLowerCase().includes('embedding'),
      };
      target.columns.push(col);
      if (col.isEmbedding) target.embeddings.push(col.columnName);
    }

    res.json({
      sourceSqlFile: 'sql/hybrid_schema.sql',
      tables,
      foreignKeys: fkRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Optional client endpoints exposing DB-backed local government requests.
app.post('/api/government/requests', async (req, res) => {
  const { description, userId = null, notes = null } = req.body || {};
  try {
    const request = await createGovernmentRequest({ userId, description, notes, status: 'new' });
    res.json({ ok: true, request });
  } catch (err) {
    const statusCode = isGovernmentRequestValidationError(err) ? 400 : 500;
    res.status(statusCode).json({ ok: false, error: err.message });
  }
});

app.get('/api/government/requests/:id', async (req, res) => {
  try {
    const request = await getGovernmentRequestById(req.params.id);
    if (!request) return res.status(404).json({ ok: false, error: 'Request not found' });
    res.json({ ok: true, request });
  } catch (err) {
    const statusCode = isGovernmentRequestValidationError(err) ? 400 : 500;
    res.status(statusCode).json({ ok: false, error: err.message });
  }
});

app.post('/api/government/agent-permission/grant', async (req, res) => {
  const {
    userId = 'ui-user',
    approvedBy = 'user',
    ttlDays = 90,
    scopes = ['bookings'],
    notes = '',
  } = req.body || {};

  const now = Date.now();
  const expiresAtMs = now + Math.max(1, Number(ttlDays) || 90) * 24 * 60 * 60 * 1000;
  const token = `agt_${randomUUID().replace(/-/g, '')}`;

  const store = await readPermissionStore();
  const entry = {
    id: randomUUID(),
    token,
    userId: String(userId || 'ui-user'),
    approvedBy: String(approvedBy || 'user'),
    scopes: Array.isArray(scopes) && scopes.length ? scopes : ['bookings'],
    notes: String(notes || '').trim() || null,
    createdAt: new Date(now).toISOString(),
    createdAtMs: now,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
    revokedAt: null,
  };

  store.tokens.push(entry);
  await writePermissionStore(store);

  res.json({
    ok: true,
    mode: 'agent-permission',
    permission: {
      token,
      userId: entry.userId,
      approvedBy: entry.approvedBy,
      scopes: entry.scopes,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    },
  });
});

app.get('/api/government/agent-permission/status', async (req, res) => {
  const token = extractPermissionTokenFromReq(req);
  if (!token) {
    return res.status(400).json({ ok: false, mode: 'agent-permission', error: 'Missing token in Authorization bearer or x-agent-booking-token' });
  }

  const validation = await validatePermissionToken(token, { requiredScope: 'bookings' });
  if (!validation.ok) {
    return res.status(403).json({ ok: false, mode: 'agent-permission', valid: false, reason: validation.reason });
  }

  const meta = validation.tokenMeta || {};
  res.json({
    ok: true,
    mode: 'agent-permission',
    valid: true,
    permission: {
      userId: meta.userId,
      approvedBy: meta.approvedBy,
      scopes: meta.scopes,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt,
    },
  });
});

app.post('/api/government/agent-permission/revoke', async (req, res) => {
  const { reason = '' } = req.body || {};
  const token = extractPermissionTokenFromReq(req);
  if (!token) {
    return res.status(400).json({ ok: false, mode: 'agent-permission', error: 'Missing token in Authorization bearer or x-agent-booking-token' });
  }

  const store = await readPermissionStore();
  const idx = (store.tokens || []).findIndex((t) => t?.token === token && !t?.revokedAt);
  if (idx < 0) {
    return res.status(404).json({ ok: false, mode: 'agent-permission', error: 'Active token not found' });
  }

  store.tokens[idx].revokedAt = new Date().toISOString();
  store.tokens[idx].revokedReason = String(reason || '').trim() || null;
  await writePermissionStore(store);

  res.json({ ok: true, mode: 'agent-permission', revoked: true, revokedAt: store.tokens[idx].revokedAt });
});

app.post('/api/government/requests/:id/status', async (req, res) => {
  const { status, notes = null } = req.body || {};
  try {
    const request = await updateGovernmentRequestStatus({ id: req.params.id, status, notes });
    if (!request) return res.status(404).json({ ok: false, error: 'Request not found' });
    res.json({ ok: true, request });
  } catch (err) {
    const statusCode = isGovernmentRequestValidationError(err) ? 400 : 500;
    res.status(statusCode).json({ ok: false, error: err.message });
  }
});

app.post('/api/government/appointments/schedule', requireAgentBookingPermission, async (req, res) => {
  const { description, userId = null, notes = null, category = 'arnona', officialApiConfig = null } = req.body || {};
  try {
    const trackedRequest = await createGovernmentRequest({ userId, description, notes, status: 'new' });

    const scheduling = await scheduleTelAvivAppointmentOfficial({ userId, description, notes, category, officialApiConfig });
    const confirmed = !!scheduling?.appointment?.confirmed;
    const nextStatus = confirmed ? 'approved' : 'in_progress';
    const statusNote = confirmed
      ? `Official API confirmed appointment. Ref: ${scheduling?.appointment?.externalRequestId || 'n/a'}`
      : `Official API accepted request; pending confirmation. Ref: ${scheduling?.appointment?.externalRequestId || 'n/a'}`;

    const request = await updateGovernmentRequestStatus({
      id: trackedRequest.id,
      status: nextStatus,
      notes: statusNote,
    });

    res.json({
      ok: true,
      mode: 'official-api',
      request,
      scheduling,
    });
  } catch (err) {
    if (err instanceof MunicipalityApiUnavailableError) {
      return res.status(501).json({
        ok: false,
        mode: 'official-api',
        error: err.message,
        details: err.details,
      });
    }
    if (err instanceof MunicipalityApiCallError) {
      return res.status(err.statusCode || 502).json({
        ok: false,
        mode: 'official-api',
        error: err.message,
        details: err.details,
      });
    }
    const statusCode = isGovernmentRequestValidationError(err) ? 400 : 500;
    res.status(statusCode).json({ ok: false, mode: 'official-api', error: err.message });
  }
});

app.post('/api/government/appointments/browser-run', requireAgentBookingPermission, async (req, res) => {
  const {
    description,
    userId = null,
    notes = null,
    applicant = {},
    dryRun = true,
    confirmedSubmit = false,
    headless = false,
    timeoutMs = 90000,
  } = req.body || {};

  try {
    const trackedRequest = await createGovernmentRequest({ userId, description, notes, status: 'new' });

    const browserResult = await runTelAvivBrowserBooking({
      applicant,
      intentText: description,
      dryRun,
      confirmedSubmit,
      headless,
      timeoutMs,
    });

    let nextStatus = 'in_progress';
    let statusNote = `Browser stage: ${browserResult.stage}; requiresHuman=${Boolean(browserResult.requiresHuman)}`;
    if (browserResult.submitted && !browserResult.requiresHuman) {
      nextStatus = 'approved';
      statusNote = `Browser booking submitted. finalUrl=${browserResult.finalUrl || 'n/a'}`;
    }

    const request = await updateGovernmentRequestStatus({
      id: trackedRequest.id,
      status: nextStatus,
      notes: statusNote,
    });

    res.json({
      ok: true,
      mode: 'browser-agent',
      request,
      browserResult,
    });
  } catch (err) {
    const statusCode = isGovernmentRequestValidationError(err) ? 400 : 500;
    res.status(statusCode).json({ ok: false, mode: 'browser-agent', error: err.message });
  }
});

app.post('/api/government/appointments/fully-automated', requireAgentBookingPermission, async (req, res) => {
  const {
    description,
    userId = null,
    notes = null,
    category = 'arnona',
    officialApiConfig = null,
    applicant = {},
    useOfficialApiFirst = true,
    allowBrowserFallback = true,
    headless = true,
    timeoutMs = 90000,
    maxRuntimeMs = 240000,
    pollIntervalMs = 2500,
    keepSessionOnFailure = true,
  } = req.body || {};

  try {
    const trackedRequest = await createGovernmentRequest({ userId, description, notes, status: 'new' });
    const attempts = [];

    if (useOfficialApiFirst) {
      try {
        const scheduling = await scheduleTelAvivAppointmentOfficial({ userId, description, notes, category, officialApiConfig });
        const confirmed = !!scheduling?.appointment?.confirmed;
        const request = await updateGovernmentRequestStatus({
          id: trackedRequest.id,
          status: confirmed ? 'approved' : 'in_progress',
          notes: confirmed
            ? `Official API confirmed appointment. Ref: ${scheduling?.appointment?.externalRequestId || 'n/a'}`
            : `Official API accepted request; pending confirmation. Ref: ${scheduling?.appointment?.externalRequestId || 'n/a'}`,
        });

        attempts.push({ channel: 'official-api', ok: true, confirmed, scheduling });

        return res.json({
          ok: true,
          mode: 'fully-automated',
          channel: 'official-api',
          request,
          attempts,
        });
      } catch (err) {
        const known = (err instanceof MunicipalityApiUnavailableError) || (err instanceof MunicipalityApiCallError);
        attempts.push({
          channel: 'official-api',
          ok: false,
          knownError: known,
          error: err?.message || String(err),
          details: err?.details || null,
        });
        if (!allowBrowserFallback) {
          const request = await updateGovernmentRequestStatus({
            id: trackedRequest.id,
            status: 'in_progress',
            notes: `Official API failed and fallback disabled: ${err?.message || 'unknown error'}`,
          });
          return res.status(502).json({
            ok: false,
            mode: 'fully-automated',
            channel: 'official-api',
            request,
            attempts,
          });
        }
      }
    }

    const browserResult = await runTelAvivFullyAutomatedBooking({
      requestId: trackedRequest.id,
      applicant,
      intentText: description,
      headless,
      timeoutMs,
      maxRuntimeMs,
      pollIntervalMs,
      keepSessionOnFailure,
    });

    const submitted = !!browserResult?.submitted;
    const requiresHuman = !!browserResult?.requiresHuman;
    const nextStatus = submitted && !requiresHuman ? 'approved' : 'in_progress';
    const request = await updateGovernmentRequestStatus({
      id: trackedRequest.id,
      status: nextStatus,
      notes: submitted
        ? `Autonomous browser submitted successfully. finalState=${browserResult?.session?.state || 'submitted'}`
        : `Autonomous browser incomplete. reason=${browserResult?.reason || browserResult?.error || 'unknown'}`,
    });

    attempts.push({
      channel: 'browser-autonomous',
      ok: !!browserResult?.ok,
      submitted,
      requiresHuman,
      reason: browserResult?.reason || null,
    });

    res.status(submitted ? 200 : 202).json({
      ok: true,
      mode: 'fully-automated',
      channel: 'browser-autonomous',
      request,
      attempts,
      browserResult,
    });
  } catch (err) {
    const statusCode = isGovernmentRequestValidationError(err) ? 400 : 500;
    res.status(statusCode).json({ ok: false, mode: 'fully-automated', error: err.message });
  }
});

// ─── Credential endpoints ─────────────────────────────────────────────────────

app.post('/api/government/appointments/credentials/save', async (req, res) => {
  const {
    userId = '',
    loginUsername = '',
    loginPassword = '',
    otpCode = '',
    otpPolicy = 'static',
    totpSecret = '',
    applicantProfile = null,
  } = req.body || {};
  const hasCreds = Boolean(String(loginUsername || '').trim() || String(loginPassword || '').trim() || String(otpCode || '').trim() || String(totpSecret || '').trim());
  const hasApplicantProfile = applicantProfile && typeof applicantProfile === 'object' && Boolean(
    String(applicantProfile.firstName || '').trim()
    || String(applicantProfile.lastName || '').trim()
    || String(applicantProfile.fullName || '').trim()
    || String(applicantProfile.idNumber || '').trim()
    || String(applicantProfile.phone || '').trim()
    || String(applicantProfile.email || '').trim()
    || String(applicantProfile.address || '').trim()
    || String(applicantProfile.city || '').trim()
    || String(applicantProfile.street || '').trim()
    || String(applicantProfile.houseNumber || '').trim()
    || String(applicantProfile.apartment || '').trim()
    || String(applicantProfile.zipCode || '').trim()
    || String(applicantProfile.notes || '').trim()
  );
  if (!hasCreds && !hasApplicantProfile) {
    return res.status(400).json({ ok: false, error: 'Provide at least one credential or applicantProfile field' });
  }
  try {
    const existing = await loadBookingCredentials();
    const normalizedUserId = String(userId || req.body?.userId || '').trim() || 'ui-user';
    const dbProfileEntry = await getBookingApplicantProfileFromDb(normalizedUserId).catch(() => null);
    const dbApplicantProfile = dbProfileEntry?.profile && typeof dbProfileEntry.profile === 'object'
      ? dbProfileEntry.profile
      : {};
    const incomingProfile = applicantProfile && typeof applicantProfile === 'object' ? applicantProfile : {};
    const mergedApplicantProfile = {
      ...dbApplicantProfile,
      ...(existing?.applicantProfile || {}),
    };
    for (const [key, rawValue] of Object.entries(incomingProfile)) {
      if (key === 'extraFields' && rawValue && typeof rawValue === 'object') {
        const mergedExtra = { ...((existing?.applicantProfile?.extraFields && typeof existing.applicantProfile.extraFields === 'object') ? existing.applicantProfile.extraFields : {}) };
        for (const [extraKey, extraRawValue] of Object.entries(rawValue)) {
          const normalizedExtraKey = String(extraKey || '').trim();
          const normalizedExtraValue = String(extraRawValue ?? '').trim();
          if (normalizedExtraKey && normalizedExtraValue) {
            mergedExtra[normalizedExtraKey] = normalizedExtraValue;
          }
        }
        mergedApplicantProfile.extraFields = mergedExtra;
        continue;
      }

      const normalizedValue = String(rawValue ?? '').trim();
      if (normalizedValue) {
        mergedApplicantProfile[key] = normalizedValue;
      }
    }

    const result = await saveBookingCredentials({
      loginUsername: String(loginUsername || existing?.loginUsername || '').trim(),
      loginPassword: String(loginPassword || existing?.loginPassword || '').trim(),
      otpCode: String(otpCode || existing?.otpCode || '').trim(),
      otpPolicy,
      totpSecret: String(totpSecret || existing?.totpSecret || '').trim(),
      applicantProfile: mergedApplicantProfile,
    });
    await upsertBookingApplicantProfileToDb({
      userId: normalizedUserId,
      applicantProfile: mergedApplicantProfile,
    }).catch(() => null);
    const missingApplicantFields = getMissingApplicantFields(mergedApplicantProfile);
    const requiredApplicantQuestions = buildApplicantProfileQuestionnaire(mergedApplicantProfile);
    res.json({
      ok: true,
      ...result,
      persistence: {
        longTermMemory: 'tmp/booking-creds.json',
        dbTable: 'booking_applicant_profiles',
        profileUserId: normalizedUserId,
      },
      requiredApplicantQuestions,
      missingApplicantFields,
      applicantProfileComplete: missingApplicantFields.length === 0,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/government/appointments/credentials/status', async (req, res) => {
  try {
    const normalizedUserId = String(req.query?.userId || '').trim() || 'ui-user';
    const meta = await getBookingCredentialsMeta();
    const creds = await loadBookingCredentials();
    const dbProfileEntry = await getBookingApplicantProfileFromDb(normalizedUserId).catch(() => null);
    const dbApplicantProfile = dbProfileEntry?.profile && typeof dbProfileEntry.profile === 'object'
      ? dbProfileEntry.profile
      : {};
    const fileApplicantProfile = creds?.applicantProfile && typeof creds.applicantProfile === 'object'
      ? creds.applicantProfile
      : {};
    const applicantProfile = mergeApplicantWithSavedProfile(fileApplicantProfile, dbApplicantProfile);
    const missingApplicantFields = getMissingApplicantFields(applicantProfile);
    const requiredApplicantQuestions = buildApplicantProfileQuestionnaire(applicantProfile);
    res.json({
      ok: true,
      ...meta,
      requiredApplicantQuestions,
      missingApplicantFields,
      applicantProfileComplete: missingApplicantFields.length === 0,
      persistence: {
        longTermMemory: 'tmp/booking-creds.json',
        dbTable: 'booking_applicant_profiles',
        profileUserId: normalizedUserId,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/government/booking-profile/questions', async (req, res) => {
  try {
    const normalizedUserId = String(req.query?.userId || '').trim() || 'ui-user';
    const creds = await loadBookingCredentials();
    const dbProfileEntry = await getBookingApplicantProfileFromDb(normalizedUserId).catch(() => null);
    const dbApplicantProfile = dbProfileEntry?.profile && typeof dbProfileEntry.profile === 'object'
      ? dbProfileEntry.profile
      : {};
    const fileApplicantProfile = creds?.applicantProfile && typeof creds.applicantProfile === 'object'
      ? creds.applicantProfile
      : {};
    const applicantProfile = mergeApplicantWithSavedProfile(fileApplicantProfile, dbApplicantProfile);
    const missingApplicantFields = getMissingApplicantFields(applicantProfile);
    const requiredApplicantQuestions = buildApplicantProfileQuestionnaire(applicantProfile);
    res.json({
      ok: true,
      requiredApplicantQuestions,
      missingApplicantFields,
      applicantProfileComplete: missingApplicantFields.length === 0,
      persistence: {
        longTermMemory: 'tmp/booking-creds.json',
        dbTable: 'booking_applicant_profiles',
        profileUserId: normalizedUserId,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/government/appointments/credentials', async (_req, res) => {
  try {
    const result = await clearBookingCredentials();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Probe endpoint (API check + cached data + browser scrape + network) ──────

app.post('/api/government/appointments/probe', requireAgentBookingPermission, async (req, res) => {
  const {
    intentText = 'arnona property tax appointment',
    applicant = {},
    bookingUrl = null,
    officialApiConfig = null,
    includeNetworkInspection = true,
    runBrowserScrape = true,
    autonomousBrowserScrape = true,
    autonomousMaxSteps = 4,
    telAvivUrls = ['https://www.tel-aviv.gov.il/Residents/Arnona/Pages/ArnonaSwitching.aspx',
      'https://www.tel-aviv.gov.il/Contact/Pages/Appointments.aspx'],
  } = req.body || {};

  const report = {
    probedAt: new Date().toISOString(),
    steps: {},
  };

  // Step 1: check official API config
  const { getTelAvivOfficialAppointmentApiConfig } = await import('./making_operations/local_government/official_appointment_api.js');
  const apiConfig = getTelAvivOfficialAppointmentApiConfig(officialApiConfig || {});
  report.steps.officialApi = {
    configured: apiConfig.configured,
    provider: apiConfig.provider,
    publicBookingUrl: apiConfig.publicBookingUrl,
    missingEnvVars: apiConfig.configured ? [] : ['TEL_AVIV_APPOINTMENT_API_BASE_URL (required)', 'TEL_AVIV_APPOINTMENT_API_KEY or TEL_AVIV_APPOINTMENT_API_BEARER_TOKEN (optional)'],
  };

  // Step 2: check cached data in RAG DB
  try {
    const { getLocalGovernmentRagStats } = await import('./making_operations/local_government/operations.js');
    const stats = await getLocalGovernmentRagStats();
    report.steps.cachedData = { ok: true, totalDocs: stats.totalDocs, distinctSources: stats.distinctSources, sources: stats.sources?.slice(0, 10) };
  } catch (err) {
    report.steps.cachedData = { ok: false, error: err.message };
  }

  // Step 3: browser scrape (ingest to RAG)
  if (runBrowserScrape) {
    try {
      const { ingestLocalGovernmentWebToRag } = await import('./making_operations/local_government/operations.js');
      let urlsToIngest = Array.isArray(telAvivUrls) ? telAvivUrls : [];
      let discovery = null;

      if (autonomousBrowserScrape) {
        const inspectUrl = bookingUrl || 'https://www.tel-aviv.gov.il/Contact/Pages/Appointments.aspx';
        discovery = await inspectBookingSiteNetwork({
          bookingUrl: inspectUrl,
          intentText,
          applicant,
          autonomousBrowse: true,
          maxAutonomousSteps: Math.max(1, Number(autonomousMaxSteps) || 4),
          maxNetworkEntries: 80,
        });

        const discoveredUrls = Array.isArray(discovery?.traversal?.visited)
          ? discovery.traversal.visited.map((v) => String(v?.url || '').trim()).filter(Boolean)
          : [];
        urlsToIngest = Array.from(new Set([...(urlsToIngest || []), ...discoveredUrls]));
      }

      const scrapeResult = await ingestLocalGovernmentWebToRag({ urls: urlsToIngest, replaceExisting: true, maxChunksPerUrl: 30 });
      report.steps.browserScrape = {
        ok: scrapeResult.ok,
        autonomousBrowserScrape: Boolean(autonomousBrowserScrape),
        urlsIngested: urlsToIngest,
        discoveredCount: Array.isArray(discovery?.traversal?.visited) ? discovery.traversal.visited.length : 0,
        discovery: discovery ? {
          ok: discovery.ok,
          finalUrl: discovery.finalUrl,
          pageTitle: discovery.pageTitle,
          traversal: discovery.traversal,
        } : null,
        inserted: scrapeResult.inserted,
        pages: scrapeResult.pages,
      };
    } catch (err) {
      report.steps.browserScrape = { ok: false, error: err.message };
    }
  }

  // Step 4: network inspection
  if (includeNetworkInspection) {
    try {
      const inspectUrl = bookingUrl || 'https://www.tel-aviv.gov.il/Contact/Pages/Appointments.aspx';
      const networkResult = await inspectBookingSiteNetwork({
        bookingUrl: inspectUrl,
        intentText,
        applicant,
        autonomousBrowse: Boolean(autonomousBrowserScrape),
        maxAutonomousSteps: Math.max(1, Number(autonomousMaxSteps) || 4),
      });
      report.steps.networkInspection = networkResult;
    } catch (err) {
      report.steps.networkInspection = { ok: false, error: err.message };
    }
  }

  // Step 5: store probe results as a government request
  try {
    const savedRequest = await createGovernmentRequest({
      userId: 'probe-system',
      description: `Site probe: ${intentText}`,
      status: 'new',
      notes: `Probe results: officialApi.configured=${report.steps.officialApi?.configured}; cachedDocs=${report.steps.cachedData?.totalDocs ?? 'n/a'}; scraped.inserted=${report.steps.browserScrape?.inserted ?? 'skipped'}; networkRequests=${report.steps.networkInspection?.networkCount ?? 'skipped'}`,
    });
    report.savedRequestId = savedRequest.id;
  } catch (err) {
    report.saveError = err.message;
  }

  res.json({ ok: true, ...report });
});

app.post('/api/government/appointments/monitor/start', requireAgentBookingPermission, async (req, res) => {
  const {
    userId = 'monitor-user',
    requestId = null,
    intentText = 'arnona appointment',
    bookingUrl = process.env.TEL_AVIV_APPOINTMENT_PUBLIC_URL || 'https://www.tel-aviv.gov.il/Contact/Pages/Appointments.aspx',
    intervalMs = 60000,
    autonomousBrowse = true,
    maxAutonomousSteps = 4,
    timeoutMs = 90000,
    maxNetworkEntries = 120,
    maxHistory = 100,
    applicant = {},
    alertWebhookUrl = '',
    selectedSlot = null,
    userConfirmation = false,
    autoBook = false,
    confirmationGranted = false,
    allowHumanIntervention = true,
    headlessBooking = true,
    queueName = 'appointment-monitor',
    scheduleMode = 'interval',
    cronExpression = '',
    preferredSlot = '',
    preferredDate = '',
    preferredTimeRanges = [],
    preferredTimeWindow = null,
    slotTimeZone = 'Asia/Jerusalem',
  } = req.body || {};

  const savedCreds = await loadBookingCredentials().catch(() => null);
  const dbProfileEntry = await getBookingApplicantProfileFromDb(userId).catch(() => null);
  const dbApplicantProfile = dbProfileEntry?.profile && typeof dbProfileEntry.profile === 'object'
    ? dbProfileEntry.profile
    : {};
  const savedApplicantProfile = savedCreds?.applicantProfile && typeof savedCreds.applicantProfile === 'object'
    ? savedCreds.applicantProfile
    : {};
  const mergedSavedProfile = mergeApplicantWithSavedProfile(savedApplicantProfile, dbApplicantProfile);
  const effectiveApplicant = mergeApplicantWithSavedProfile(applicant, mergedSavedProfile);
  const missingApplicantFields = getMissingApplicantFields(effectiveApplicant);
  const effectiveAutoBook = Boolean(autoBook) && missingApplicantFields.length === 0;
  const profileGateActive = missingApplicantFields.length > 0;

  const parsedIntervalMs = Math.max(15000, Number(intervalMs) || 60000);
  const scheduler = buildWorkflowScheduler({ intervalMs: parsedIntervalMs, cronExpression, mode: scheduleMode, timeZone: slotTimeZone });
  if (scheduler.cron_expression && !scheduler.cron_valid) {
    return res.status(400).json({
      ok: false,
      mode: 'appointment-monitor',
      error: scheduler.cron_error || 'Invalid cron expression',
      scheduler,
    });
  }
  const monitor = {
    id: randomUUID(),
    userId,
    intentText: String(intentText || 'appointment').trim(),
    bookingUrl: String(bookingUrl || '').trim(),
    intervalMs: parsedIntervalMs,
    autonomousBrowse: Boolean(autonomousBrowse),
    maxAutonomousSteps: Math.max(1, Math.min(8, Number(maxAutonomousSteps) || 4)),
    timeoutMs: Math.max(10000, Number(timeoutMs) || 90000),
    maxNetworkEntries: Math.max(20, Number(maxNetworkEntries) || 120),
    maxHistory: Math.max(10, Math.min(500, Number(maxHistory) || 100)),
    applicant: effectiveApplicant,
    alertWebhookUrl: String(alertWebhookUrl || '').trim(),
    linkedRequestId: Number.isInteger(Number(requestId)) && Number(requestId) > 0 ? Number(requestId) : null,
    selectedSlot: normalizeMonitorSelectedSlot(selectedSlot),
    userConfirmation: Boolean(userConfirmation),
    autoBook: effectiveAutoBook,
    missingApplicantFields,
    confirmationGranted: Boolean(confirmationGranted),
    preferredSlot: String(preferredSlot || '').trim(),
    preferredDate: String(preferredDate || '').trim(),
    preferredTimeRanges: Array.isArray(preferredTimeRanges) ? preferredTimeRanges : [],
    preferredTimeWindow: preferredTimeWindow && typeof preferredTimeWindow === 'object' ? preferredTimeWindow : null,
    slotTimeZone: scheduler.timezone,
    allowHumanIntervention: Boolean(allowHumanIntervention),
    headlessBooking: Boolean(headlessBooking),
    queueName: String(queueName || 'appointment-monitor').trim() || 'appointment-monitor',
    scheduleMode: scheduler.mode,
    cronExpression: scheduler.cron_expression || '',
    bookingState: normalizeBookingState({
      availableSlots: [],
      selectedSlot: normalizeMonitorSelectedSlot(selectedSlot),
      bookingStatus: 'monitoring',
      lastChecked: null,
      userConfirmation: Boolean(userConfirmation),
      autoBook: effectiveAutoBook,
      decision: profileGateActive ? 'await_profile_completion_hitl' : 'wait_and_recheck',
      nextCheckAt: null,
      queue: buildWorkflowQueue({ name: queueName, inFlight: false }),
      scheduler,
      confirmationGranted: Boolean(confirmationGranted),
      requiresHumanGate: Boolean(profileGateActive || !effectiveAutoBook || !confirmationGranted),
      missingApplicantFields,
      preferredSlot: String(preferredSlot || '').trim(),
      preferredDate: String(preferredDate || '').trim(),
      preferredTimeRanges: Array.isArray(preferredTimeRanges) ? preferredTimeRanges : [],
      preferredTimeWindow: preferredTimeWindow && typeof preferredTimeWindow === 'object' ? preferredTimeWindow : null,
      timeZone: scheduler.timezone,
    }),
    running: true,
    inFlight: false,
    bookingAttemptInFlight: false,
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    checksCount: 0,
    alertsCount: 0,
    lastBookingAttempt: null,
    lastResult: null,
    lastError: null,
    history: [],
    timer: null,
  };

  monitor.timer = setInterval(() => {
    runAppointmentMonitorCycle(monitor).catch(() => null);
  }, monitor.intervalMs);

  appointmentMonitors.set(monitor.id, monitor);

  const firstResult = await runAppointmentMonitorCycle(monitor, { manual: true }).catch(() => null);

  return res.json({
    ok: true,
    mode: 'appointment-monitor',
    monitor: toMonitorPublicState(monitor),
    firstResult,
  });
});

app.get('/api/government/appointments/monitor/list', requireAgentBookingPermission, async (_req, res) => {
  const monitors = Array.from(appointmentMonitors.values()).map((m) => toMonitorPublicState(m));
  res.json({ ok: true, mode: 'appointment-monitor', monitors, total: monitors.length });
});

app.get('/api/government/appointments/monitor/:id/status', requireAgentBookingPermission, async (req, res) => {
  const monitor = appointmentMonitors.get(String(req.params.id || ''));
  if (!monitor) return res.status(404).json({ ok: false, mode: 'appointment-monitor', error: 'Monitor not found' });
  return res.json({ ok: true, mode: 'appointment-monitor', monitor: toMonitorPublicState(monitor) });
});

app.post('/api/government/appointments/monitor/:id/check-now', requireAgentBookingPermission, async (req, res) => {
  const monitor = appointmentMonitors.get(String(req.params.id || ''));
  if (!monitor) return res.status(404).json({ ok: false, mode: 'appointment-monitor', error: 'Monitor not found' });
  if (!monitor.running) return res.status(400).json({ ok: false, mode: 'appointment-monitor', error: 'Monitor is not running' });

  const result = await runAppointmentMonitorCycle(monitor, { manual: true });
  return res.json({ ok: true, mode: 'appointment-monitor', monitor: toMonitorPublicState(monitor), result });
});

app.post('/api/government/appointments/monitor/:id/confirm', requireAgentBookingPermission, async (req, res) => {
  const monitor = appointmentMonitors.get(String(req.params.id || ''));
  if (!monitor) return res.status(404).json({ ok: false, mode: 'appointment-monitor', error: 'Monitor not found' });

  const { selectedSlot = null, confirmationGranted = true, checkNow = true } = req.body || {};
  if (selectedSlot) {
    monitor.selectedSlot = normalizeMonitorSelectedSlot(selectedSlot);
  }
  monitor.confirmationGranted = Boolean(confirmationGranted);

  const persisted = await persistMonitorBookingState(monitor, monitor.lastResult || { checkedAt: new Date().toISOString(), ok: true }, {
    selectedSlot: monitor.selectedSlot,
    confirmationGranted: monitor.confirmationGranted,
    bookingStatus: monitor.confirmationGranted ? 'booking_ready' : (monitor.bookingState?.booking_status || 'awaiting_user_confirmation'),
    decision: monitor.confirmationGranted ? 'book_confirmed_slot' : (monitor.bookingState?.decision || 'notify_and_wait_for_confirmation'),
    requiresHumanGate: !monitor.confirmationGranted,
  });

  let result = null;
  if (checkNow && monitor.running) {
    result = await runAppointmentMonitorCycle(monitor, { manual: true });
  }

  return res.json({
    ok: true,
    mode: 'appointment-monitor',
    bookingState: persisted?.bookingState || monitor.bookingState,
    monitor: toMonitorPublicState(monitor),
    result,
  });
});

app.post('/api/government/appointments/monitor/:id/stop', requireAgentBookingPermission, async (req, res) => {
  const monitor = appointmentMonitors.get(String(req.params.id || ''));
  if (!monitor) return res.status(404).json({ ok: false, mode: 'appointment-monitor', error: 'Monitor not found' });

  monitor.running = false;
  monitor.stoppedAt = new Date().toISOString();
  if (monitor.timer) {
    clearInterval(monitor.timer);
    monitor.timer = null;
  }

  return res.json({ ok: true, mode: 'appointment-monitor', monitor: toMonitorPublicState(monitor) });
});

app.post('/api/government/appointments/api-discovery/run', requireAgentBookingPermission, async (req, res) => {
  const {
    bookingUrl = process.env.TEL_AVIV_APPOINTMENT_PUBLIC_URL || 'https://www.tel-aviv.gov.il/Contact/Pages/Appointments.aspx',
    intentText = 'arnona appointment',
    autonomousBrowse = true,
    maxAutonomousSteps = 4,
    timeoutMs = 90000,
    maxNetworkEntries = 250,
    persist = true,
  } = req.body || {};

  try {
    const inspection = await inspectBookingSiteNetwork({
      bookingUrl,
      intentText,
      autonomousBrowse: Boolean(autonomousBrowse),
      maxAutonomousSteps: Math.max(1, Math.min(8, Number(maxAutonomousSteps) || 4)),
      timeoutMs: Math.max(10000, Number(timeoutMs) || 90000),
      maxNetworkEntries: Math.max(50, Number(maxNetworkEntries) || 250),
    });

    const candidates = Array.from(new Set((inspection?.networkRequests || [])
      .map((entry) => toApiCandidate(entry))
      .filter(Boolean)
      .map((x) => JSON.stringify(x)))).map((x) => JSON.parse(x));

    const existing = await readApiDiscoveryStore();
    const mergedApis = mergeApiCatalog(existing.apis || [], candidates);
    const discoveredAt = new Date().toISOString();

    if (persist) {
      await writeApiDiscoveryStore({ discoveredAt, apis: mergedApis });
    }

    res.json({
      ok: true,
      mode: 'api-discovery',
      discoveredAt,
      bookingUrl,
      inspection: {
        finalUrl: inspection?.finalUrl || null,
        pageTitle: inspection?.pageTitle || null,
        networkCount: inspection?.networkCount || 0,
        traversal: inspection?.traversal || null,
      },
      discoveredApis: candidates,
      catalog: mergedApis,
      persisted: Boolean(persist),
    });
  } catch (err) {
    res.status(500).json({ ok: false, mode: 'api-discovery', error: err.message });
  }
});

app.get('/api/government/appointments/api-discovery/catalog', requireAgentBookingPermission, async (req, res) => {
  const action = String(req.query.action || '').toLowerCase();
  const store = await readApiDiscoveryStore();
  const allApis = Array.isArray(store.apis) ? store.apis : [];
  const apis = action && ['slots', 'schedule'].includes(action)
    ? allApis.filter((x) => String(x.kind || '').toLowerCase() === action)
    : allApis;

  res.json({
    ok: true,
    mode: 'api-discovery',
    discoveredAt: store.discoveredAt,
    total: allApis.length,
    apis,
  });
});

app.post('/api/government/appointments/api-discovery/execute', requireAgentBookingPermission, async (req, res) => {
  const {
    action = 'slots',
    endpointId = '',
    payload = null,
    headers = {},
    fallbackHost = '',
  } = req.body || {};

  const actionType = String(action || '').toLowerCase();
  if (!['slots', 'schedule'].includes(actionType)) {
    return res.status(400).json({ ok: false, mode: 'api-discovery', error: 'action must be slots or schedule' });
  }

  const store = await readApiDiscoveryStore();
  const catalog = Array.isArray(store.apis) ? store.apis : [];
  let endpoint = null;

  if (endpointId) {
    endpoint = catalog.find((x) => x.id === endpointId || x.key === endpointId) || null;
  }
  if (!endpoint) {
    endpoint = chooseCatalogApi(catalog, actionType);
  }

  if (!endpoint && fallbackHost) {
    const host = String(fallbackHost || '').replace(/\/+$/, '');
    endpoint = {
      id: 'fallback-synthesized',
      method: actionType === 'slots' ? 'GET' : 'POST',
      url: `${host}${actionType === 'slots' ? '/slots' : '/schedule'}`,
      kind: actionType,
      score: 0,
    };
  }

  if (!endpoint) {
    return res.status(404).json({ ok: false, mode: 'api-discovery', error: 'No suitable discovered API found. Run discovery first.' });
  }

  try {
    const execResult = await executeDiscoveredApi({ endpoint, action: actionType, payload, headers });
    return res.status(execResult.ok ? 200 : 502).json({
      ok: execResult.ok,
      mode: 'api-discovery',
      action: actionType,
      selectedEndpoint: endpoint,
      execution: execResult,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, mode: 'api-discovery', action: actionType, selectedEndpoint: endpoint, error: err.message });
  }
});

app.post('/api/government/appointments/discover-api-node/run', requireAgentBookingPermission, async (req, res) => {
  const {
    websiteUrl,
    userRequest,
    payload = null,
    headers = {},
    executeAction = true,
    autonomousBrowse = true,
    maxAutonomousSteps = 4,
    maxNetworkEntries = 300,
    timeoutMs = 90000,
    endpointHarvesting = {},
    adaptiveLearning = true,
  } = req.body || {};

  try {
    const result = await runDiscoverAPINode({
      websiteUrl,
      userRequest,
      payload,
      headers,
      executeAction,
      autonomousBrowse,
      maxAutonomousSteps,
      maxNetworkEntries,
      timeoutMs,
      endpointHarvesting,
      adaptiveLearning,
    });

    const statusCode = result?.ok ? 200 : 400;
    return res.status(statusCode).json({
      ok: Boolean(result?.ok),
      mode: 'discover-api-node',
      node: 'DiscoverAPINode',
      ...result,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, mode: 'discover-api-node', node: 'DiscoverAPINode', error: err.message });
  }
});

app.get('/api/government/appointments/discover-api-node/catalog', requireAgentBookingPermission, async (req, res) => {
  try {
    const host = String(req.query.host || '').trim();
    const result = await getDiscoverApiNodeCatalog({ host });
    return res.json({
      ok: true,
      mode: 'discover-api-node',
      node: 'DiscoverAPINode',
      ...result,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, mode: 'discover-api-node', node: 'DiscoverAPINode', error: err.message });
  }
});

// ─── Self-Extending LangGraph Agent ──────────────────────────────────────────

/**
 * POST /api/government/appointments/self-extending-agent/run
 * Triggers the full LangGraph self-extending agent: discover → slots → book → OTP → retry.
 * Dynamic tools are created at runtime from discovered endpoints.
 */
app.post('/api/government/appointments/self-extending-agent/run', requireAgentBookingPermission, async (req, res) => {
  const {
    websiteUrl,
    requestText,
    userId = 'self-extending-agent',
    requestId = null,
    applicantPayload = null,
    headless = true,
    maxRetries = 3,
    endpointHarvesting = {},
    trackRequest = true,
  } = req.body || {};

  if (!websiteUrl) {
    return res.status(400).json({ ok: false, mode: 'self-extending-agent', error: 'websiteUrl is required' });
  }

  try {
    let trackedRequestId = Number.isInteger(Number(requestId)) && Number(requestId) > 0 ? Number(requestId) : null;
    if (!trackedRequestId && trackRequest) {
      const created = await createGovernmentRequest({
        userId,
        description: String(requestText || 'Autonomous appointment booking flow').trim(),
        status: 'new',
        notes: {
          source: 'self-extending-agent',
          websiteUrl,
          bookingState: {
            available_slots: [],
            selected_slot: applicantPayload?.selectedSlot || null,
            booking_status: 'discovering_api',
            last_checked: null,
            user_confirmation: Boolean(applicantPayload?.userConfirmation),
            auto_book: Boolean(applicantPayload?.autoBook),
          },
        },
      }).catch(() => null);
      trackedRequestId = created?.id || null;
    }

    const result = await runSelfExtendingAgent({
      websiteUrl,
      requestText,
      applicantPayload,
      requestId: trackedRequestId,
      headless: Boolean(headless),
      maxRetries: Math.max(1, Math.min(6, Number(maxRetries) || 3)),
      endpointHarvesting: endpointHarvesting || {},
    });

    let trackedRequest = null;
    if (trackedRequestId) {
      trackedRequest = await updateGovernmentRequestStatus({
        id: trackedRequestId,
        status: mapBookingStatusToRequestStatus(result?.bookingState?.booking_status),
        notes: {
          source: 'self-extending-agent',
          websiteUrl,
          bookingState: result?.bookingState || null,
          outcome: result?.outcome || null,
          runId: result?.runId || null,
        },
      }).catch(() => null);
    }

    return res.status(result?.ok ? 200 : 400).json({
      ok: Boolean(result?.ok),
      mode: 'self-extending-agent',
      trackedRequestId,
      trackedRequest,
      ...result,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, mode: 'self-extending-agent', error: err.message });
  }
});

/**
 * GET /api/government/appointments/self-extending-agent/runs
 * List recent agent run snapshots.
 */
app.get('/api/government/appointments/self-extending-agent/runs', requireAgentBookingPermission, async (req, res) => {
  try {
    const runs = await listAgentRuns();
    return res.json({ ok: true, mode: 'self-extending-agent', total: runs.length, runs });
  } catch (err) {
    return res.status(500).json({ ok: false, mode: 'self-extending-agent', error: err.message });
  }
});

/**
 * GET /api/government/appointments/self-extending-agent/run/:runId
 * Get a specific run snapshot by runId.
 */
app.get('/api/government/appointments/self-extending-agent/run/:runId', requireAgentBookingPermission, async (req, res) => {
  try {
    const runId = String(req.params.runId || '').trim();
    if (!runId) return res.status(400).json({ ok: false, error: 'runId is required' });
    const run = await getAgentRun(runId);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found', runId });
    return res.json({ ok: true, mode: 'self-extending-agent', run });
  } catch (err) {
    return res.status(500).json({ ok: false, mode: 'self-extending-agent', error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

function mapCheckpointToRequestStatus(checkpointState = '') {
  const s = String(checkpointState || '').toLowerCase();
  if (s === 'submitted') return 'approved';
  return 'in_progress';
}

function buildAttendedRequestNotes(session = {}, { event = '', message = '', extra = null } = {}) {
  return {
    attendedEvent: String(event || '').trim() || null,
    attendedMessage: String(message || '').trim() || null,
    attendedSessionToken: session?.token || null,
    bookingCheckpoint: session?.state || null,
    attendedCurrentUrl: session?.currentUrl || null,
    attendedApproval: {
      approved: Boolean(session?.approval?.approved),
      approvedAt: session?.approval?.approvedAt || null,
      approvedBy: session?.approval?.approvedBy || null,
      reason: session?.approval?.reason || null,
    },
    attendedReplay: session?.replay || null,
    attendedDomFailures: Array.isArray(session?.domFailures) ? session.domFailures.slice(-5) : null,
    attendedHitl: {
      required: Boolean(session?.hitlRequired),
      reason: session?.hitlReason || null,
    },
    ...(extra && typeof extra === 'object' ? extra : {}),
  };
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function runAttendedAutoContinue(token, {
  applicant = null,
  maxRuntimeMs = 240000,
  pollIntervalMs = 2500,
} = {}) {
  const startedAt = Date.now();
  let lastSession = null;
  let reason = 'max-runtime-exceeded';

  if (applicant && typeof applicant === 'object') {
    const resumed = await resumeAttendedBookingSession(token, { applicant });
    if (!resumed?.ok) return { ok: false, error: resumed?.error || 'Session not found' };
    lastSession = resumed;
  }

  while (Date.now() - startedAt < Math.max(10000, Number(maxRuntimeMs) || 240000)) {
    const status = await getAttendedBookingSessionStatus(token, { includeNetwork: false });
    if (!status?.ok) return { ok: false, error: status?.error || 'Session not found' };
    lastSession = status;

    const state = String(status?.state || '').toLowerCase();
    if (state === 'submitted') {
      return {
        ok: true,
        completed: true,
        submitted: true,
        requiresHuman: false,
        reason: null,
        session: status,
        elapsedMs: Date.now() - startedAt,
      };
    }

    if (state === 'awaiting_captcha') {
      reason = 'captcha-detected';
      break;
    }

    if (state === 'awaiting_login' || state === 'awaiting_otp') {
      if (applicant && typeof applicant === 'object') {
        const resumed = await resumeAttendedBookingSession(token, { applicant });
        if (!resumed?.ok) return { ok: false, error: resumed?.error || 'Session not found' };
        lastSession = resumed;
      } else {
        reason = state === 'awaiting_login' ? 'missing-login-input' : 'missing-otp-input';
        break;
      }
      await sleepMs(pollIntervalMs);
      continue;
    }

    if (state === 'ready_to_submit') {
      await approveAttendedBookingSubmit(token, { approvedBy: 'auto-continue', reason: 'auto-continue ready_to_submit' });
      const submit = await submitAttendedBookingSession(token);
      lastSession = submit;
      const postState = String(submit?.state || '').toLowerCase();
      if (postState === 'submitted') {
        return {
          ok: true,
          completed: true,
          submitted: true,
          requiresHuman: false,
          reason: null,
          session: submit,
          elapsedMs: Date.now() - startedAt,
        };
      }
    }

    await sleepMs(pollIntervalMs);
  }

  return {
    ok: true,
    completed: false,
    submitted: false,
    requiresHuman: true,
    reason,
    session: lastSession,
    elapsedMs: Date.now() - startedAt,
  };
}

app.post('/api/government/appointments/attended/start', requireAgentBookingPermission, async (req, res) => {
  const {
    description,
    userId = null,
    notes = null,
    bookingUrl,
    applicant = {},
    headless = false,
    timeoutMs = 90000,
  } = req.body || {};

  try {
    const savedCreds = await loadBookingCredentials().catch(() => null);
    const dbProfileEntry = await getBookingApplicantProfileFromDb(userId).catch(() => null);
    const dbApplicantProfile = dbProfileEntry?.profile && typeof dbProfileEntry.profile === 'object'
      ? dbProfileEntry.profile
      : {};
    const savedApplicantProfile = savedCreds?.applicantProfile && typeof savedCreds.applicantProfile === 'object'
      ? savedCreds.applicantProfile
      : {};
    const mergedSavedProfile = mergeApplicantWithSavedProfile(savedApplicantProfile, dbApplicantProfile);
    const effectiveApplicant = mergeApplicantWithSavedProfile(applicant, mergedSavedProfile);
    const missingApplicantFields = getMissingApplicantFields(effectiveApplicant);

    const trackedRequest = await createGovernmentRequest({ userId, description, notes, status: 'new' });
    const session = await startAttendedBookingSession({
      requestId: trackedRequest.id,
      bookingUrl,
      applicant: effectiveApplicant,
      intentText: description,
      headless,
      timeoutMs,
    });

    const request = await updateGovernmentRequestStatus({
      id: trackedRequest.id,
      status: mapCheckpointToRequestStatus(session?.state),
      notes: buildAttendedRequestNotes(session, {
        event: 'session-started',
        message: 'Attended session started.',
      }),
    });

    res.json({
      ok: true,
      mode: 'browser-attended',
      missingApplicantFields,
      request,
      session,
    });
  } catch (err) {
    const statusCode = isGovernmentRequestValidationError(err) ? 400 : 500;
    res.status(statusCode).json({ ok: false, mode: 'browser-attended', error: err.message });
  }
});

app.post('/api/government/appointments/payments/boundary/run', requireAgentBookingPermission, async (req, res) => {
  const {
    paymentUrl,
    intentText,
    headless = true,
    timeoutMs = 90000,
    screenshotRoot,
  } = req.body || {};

  try {
    const result = await runTelAvivPaymentsBoundaryAssist({
      paymentUrl,
      intentText,
      headless,
      timeoutMs,
      screenshotRoot,
    });
    res.json({
      ok: true,
      mode: 'payments-boundary-run',
      result,
      uiSummary: buildPaymentBoundaryUiSummary({
        paymentProvider: result?.paymentProvider,
        adapter: result?.adapter,
        evidence: {
          requests: new Array(Number(result?.evidenceSummary?.requestCount || 0)).fill(null),
          responses: new Array(Number(result?.evidenceSummary?.responseCount || 0)).fill(null),
          cookies: new Array(Number(result?.evidenceSummary?.cookieCount || 0)).fill(null),
        },
      }),
    });
  } catch (err) {
    res.status(500).json({ ok: false, mode: 'payments-boundary-run', error: err.message });
  }
});

app.get('/api/government/appointments/payments/boundary/latest', requireAgentBookingPermission, async (_req, res) => {
  try {
    const result = await getLatestPaymentBoundaryEvidence();
    if (!result?.ok) return res.status(404).json(result);
    res.json({
      ok: true,
      mode: 'payments-boundary-latest',
      ...result,
      uiSummary: buildPaymentBoundaryUiSummary(result?.record || {}),
    });
  } catch (err) {
    res.status(500).json({ ok: false, mode: 'payments-boundary-latest', error: err.message });
  }
});

app.post('/api/government/appointments/payments/boundary/manual', requireAgentBookingPermission, async (req, res) => {
  try {
    const normalized = normalizeManualPaymentBoundaryEvidence(req.body || {});
    const adapterAnalysis = analyzePaymentProviderBoundary({
      providerSummary: normalized.paymentProvider,
      evidence: normalized.evidence,
      intentText: normalized.intentText,
      handoff: normalized.handoff,
    });
    const saved = await savePaymentBoundaryEvidence({
      ...normalized,
      adapter: adapterAnalysis.adapter,
      adapterAnalysis,
      operatorInstructions: adapterAnalysis.operatorInstructions,
      validation: adapterAnalysis.validation || null,
    });
    res.json({
      ok: true,
      mode: 'payments-boundary-manual',
      saved,
      record: {
        ...normalized,
        adapter: adapterAnalysis.adapter,
      },
      adapterAnalysis,
      uiSummary: buildPaymentBoundaryUiSummary({
        ...normalized,
        adapter: adapterAnalysis.adapter,
        adapterAnalysis,
      }),
    });
  } catch (err) {
    res.status(400).json({ ok: false, mode: 'payments-boundary-manual', error: err.message });
  }
});

app.post('/api/government/appointments/payments/boundary/real-handoff', requireAgentBookingPermission, async (req, res) => {
  try {
    const normalized = normalizeManualPaymentBoundaryEvidence({
      ...(req.body || {}),
      mode: String(req.body?.mode || 'manual-real-handoff-capture').trim() || 'manual-real-handoff-capture',
    });
    const adapterAnalysis = analyzePaymentProviderBoundary({
      providerSummary: normalized.paymentProvider,
      evidence: normalized.evidence,
      intentText: normalized.intentText,
      handoff: normalized.handoff,
    });
    const saved = await savePaymentBoundaryEvidence({
      ...normalized,
      adapter: adapterAnalysis.adapter,
      adapterAnalysis,
      operatorInstructions: adapterAnalysis.operatorInstructions,
      validation: adapterAnalysis.validation || null,
    });
    res.json({
      ok: true,
      mode: 'payments-boundary-real-handoff',
      saved,
      record: {
        ...normalized,
        adapter: adapterAnalysis.adapter,
      },
      adapterAnalysis,
      uiSummary: buildPaymentBoundaryUiSummary({
        ...normalized,
        adapter: adapterAnalysis.adapter,
        adapterAnalysis,
      }),
    });
  } catch (err) {
    res.status(400).json({ ok: false, mode: 'payments-boundary-real-handoff', error: err.message });
  }
});

app.get('/api/government/appointments/attended/:token/status', requireAgentBookingPermission, async (req, res) => {
  try {
    const includeNetwork = ['1', 'true', 'yes'].includes(String(req.query.includeNetwork || '').toLowerCase());
    const networkLimit = Math.max(1, Number(req.query.networkLimit || 100));
    const session = await getAttendedBookingSessionStatus(req.params.token, { includeNetwork, networkLimit });
    if (!session?.ok) return res.status(404).json(session);
    res.json({ ok: true, mode: 'browser-attended', session });
  } catch (err) {
    res.status(500).json({ ok: false, mode: 'browser-attended', error: err.message });
  }
});

app.post('/api/government/appointments/attended/:token/resume', requireAgentBookingPermission, async (req, res) => {
  const { applicant = null } = req.body || {};
  try {
    const session = await resumeAttendedBookingSession(req.params.token, { applicant });
    if (!session?.ok) return res.status(404).json(session);
    if (session.requestId) {
      await updateGovernmentRequestStatus({
        id: session.requestId,
        status: mapCheckpointToRequestStatus(session?.state),
        notes: buildAttendedRequestNotes(session, {
          event: 'session-resumed',
          message: 'Attended session resumed.',
        }),
      });
    }
    res.json({ ok: true, mode: 'browser-attended', session });
  } catch (err) {
    res.status(500).json({ ok: false, mode: 'browser-attended', error: err.message });
  }
});

app.post('/api/government/appointments/attended/:token/auto-continue', requireAgentBookingPermission, async (req, res) => {
  const {
    applicant = null,
    maxRuntimeMs = 240000,
    pollIntervalMs = 2500,
  } = req.body || {};

  try {
    const result = await runAttendedAutoContinue(req.params.token, {
      applicant,
      maxRuntimeMs,
      pollIntervalMs,
    });

    if (!result?.ok) return res.status(404).json({ ok: false, mode: 'browser-attended', error: result?.error || 'Session not found' });

    const session = result?.session || null;
    if (session?.requestId) {
      await updateGovernmentRequestStatus({
        id: session.requestId,
        status: mapCheckpointToRequestStatus(session?.state),
        notes: buildAttendedRequestNotes(session, {
          event: result.completed ? 'auto-continue-completed' : 'auto-continue-incomplete',
          message: result.completed
            ? 'Attended auto-continue completed and submitted.'
            : `Attended auto-continue incomplete. reason=${result.reason || 'unknown'}; state=${session?.state || 'unknown'}`,
          extra: {
            attendedAutoContinue: {
              completed: Boolean(result.completed),
              submitted: Boolean(result.submitted),
              requiresHuman: Boolean(result.requiresHuman),
              reason: result.reason || null,
            },
          },
        }),
      });
    }

    res.status(result.completed ? 200 : 202).json({
      ok: true,
      mode: 'browser-attended-auto-continue',
      ...result,
    });
  } catch (err) {
    res.status(500).json({ ok: false, mode: 'browser-attended-auto-continue', error: err.message });
  }
});

app.post('/api/government/appointments/attended/:token/approve-submit', requireAgentBookingPermission, async (req, res) => {
  const { approvedBy = 'human', reason = '' } = req.body || {};
  try {
    const session = await approveAttendedBookingSubmit(req.params.token, { approvedBy, reason });
    if (!session?.ok) return res.status(404).json(session);
    if (session.requestId) {
      await updateGovernmentRequestStatus({
        id: session.requestId,
        status: mapCheckpointToRequestStatus(session?.state),
        notes: buildAttendedRequestNotes(session, {
          event: 'approval-granted',
          message: `Human approval granted by ${approvedBy}${reason ? `: ${reason}` : ''}`,
        }),
      });
    }
    res.json({ ok: true, mode: 'browser-attended', session });
  } catch (err) {
    res.status(500).json({ ok: false, mode: 'browser-attended', error: err.message });
  }
});

app.post('/api/government/appointments/attended/:token/submit', requireAgentBookingPermission, async (req, res) => {
  try {
    const session = await submitAttendedBookingSession(req.params.token);
    if (!session?.ok) return res.status(400).json(session);
    if (session.requestId) {
      await updateGovernmentRequestStatus({
        id: session.requestId,
        status: mapCheckpointToRequestStatus(session?.state),
        notes: buildAttendedRequestNotes(session, {
          event: session?.submitted ? 'submit-completed' : 'submit-requested',
          message: `Submit requested. state=${session?.state}; approved=${session?.approval?.approved}`,
        }),
      });
    }
    res.json({ ok: true, mode: 'browser-attended', session });
  } catch (err) {
    res.status(500).json({ ok: false, mode: 'browser-attended', error: err.message });
  }
});

app.post('/api/government/appointments/attended/:token/internal-call', requireAgentBookingPermission, async (req, res) => {
  const { url, method = 'GET', body = null, headers = {} } = req.body || {};
  try {
    const result = await callAttendedSessionInternalEndpoint(req.params.token, { url, method, body, headers });
    if (!result?.ok) return res.status(400).json(result);
    res.json({ ok: true, mode: 'browser-attended', result });
  } catch (err) {
    res.status(500).json({ ok: false, mode: 'browser-attended', error: err.message });
  }
});

app.post('/api/government/appointments/attended/:token/stop', requireAgentBookingPermission, async (req, res) => {
  const { reason = '' } = req.body || {};
  try {
    const result = await stopAttendedBookingSession(req.params.token, { reason });
    if (!result?.ok) return res.status(404).json(result);
    if (result.requestId) {
      await updateGovernmentRequestStatus({
        id: result.requestId,
        status: mapCheckpointToRequestStatus(result?.state),
        notes: buildAttendedRequestNotes(result, {
          event: 'session-stopped',
          message: `Attended session stopped${reason ? `: ${reason}` : ''}`,
        }),
      });
    }
    res.json({ ok: true, mode: 'browser-attended', result });
  } catch (err) {
    res.status(500).json({ ok: false, mode: 'browser-attended', error: err.message });
  }
});

app.post('/api/government/mcp/requests', async (req, res) => {
  const { description, userId = null, notes = null } = req.body || {};
  try {
    const result = await callMcpTool('new_request_for_government', { description, userId, notes }, { authorization: req.headers?.authorization || '' });
    res.json({ ok: true, via: 'mcp-tool', tool: 'new_request_for_government', ...(result && typeof result === 'object' ? result : { result }) });
  } catch (err) {
    const statusCode = isGovernmentRequestValidationError(err) ? 400 : 500;
    res.status(statusCode).json({ ok: false, via: 'mcp-tool', tool: 'new_request_for_government', error: err.message });
  }
});

app.get('/api/government/mcp/requests/:id', async (req, res) => {
  try {
    const result = await callMcpTool('get_request_status', { id: req.params.id }, { authorization: req.headers?.authorization || '' });
    if (result && result.ok === false) {
      return res.status(404).json({ ok: false, via: 'mcp-tool', tool: 'get_request_status', error: result.error || 'Request not found' });
    }
    res.json({ ok: true, via: 'mcp-tool', tool: 'get_request_status', ...(result && typeof result === 'object' ? result : { result }) });
  } catch (err) {
    const statusCode = isGovernmentRequestValidationError(err) ? 400 : 500;
    res.status(statusCode).json({ ok: false, via: 'mcp-tool', tool: 'get_request_status', error: err.message });
  }
});

app.post('/api/government/mcp/requests/:id/status', async (req, res) => {
  const { status, notes = null } = req.body || {};
  try {
    const result = await callMcpTool('update_request_status', { id: req.params.id, status, notes }, { authorization: req.headers?.authorization || '' });
    if (result && result.ok === false) {
      return res.status(404).json({ ok: false, via: 'mcp-tool', tool: 'update_request_status', error: result.error || 'Request not found' });
    }
    res.json({ ok: true, via: 'mcp-tool', tool: 'update_request_status', ...(result && typeof result === 'object' ? result : { result }) });
  } catch (err) {
    const statusCode = isGovernmentRequestValidationError(err) ? 400 : 500;
    res.status(statusCode).json({ ok: false, via: 'mcp-tool', tool: 'update_request_status', error: err.message });
  }
});

app.post('/api/government/rag/ingest', async (req, res) => {
  const {
    urls = [],
    replaceExisting = true,
    chunkSize = 900,
    chunkOverlap = 120,
    maxChunksPerUrl = 45,
    minRelevanceScore = 1,
    fetchTimeoutMs = 20000,
  } = req.body || {};

  try {
    const result = await ingestLocalGovernmentWebToRag({
      urls,
      replaceExisting,
      chunkSize,
      chunkOverlap,
      maxChunksPerUrl,
      minRelevanceScore,
      fetchTimeoutMs,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/government/rag/stats', async (_req, res) => {
  try {
    const stats = await getLocalGovernmentRagStats();
    res.json({ ok: true, stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/government/rag/reset', requireAdmin, async (_req, res) => {
  try {
    const result = await resetLocalGovernmentRagData();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// debug endpoint to inspect matching and ranking steps
app.post('/api/agents/semantic-rag/debug', async (req, res) => {
  const { query, topK } = req.body;
  try {
    const result = await debugMatchAndRank({ query, topK });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/actions/propose', async (req, res) => {
  const { userQuery, userId = null } = req.body;
  try {
    const result = await proposeAction({ userQuery, userId });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/actions/execute', async (req, res) => {
  const { actionId, mode = 'auto', confirmed = false, userId = null } = req.body;
  try {
    const permissionContext = getActionPermissionContext(req, { confirmed });
    const result = await executeAction({ actionId, mode, permissions: permissionContext, userId });
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/actions/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const action = await getActionById(id);
    res.json(action);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ingest', requireAdmin, async (req, res) => {
  const { source, path: p, truncate } = req.body;
  try {
    const jobId = await startIngestJob({ source, path: p, truncate });
    res.json({ jobId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ingest/:id', requireAdmin, (req, res) => {
  const job = getJobStatus(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.get('/api/ingest', requireAdmin, (req, res) => {
  res.json(listJobs());
});

// New supervisor/agent endpoint: plan + execute
app.post('/api/agent/execute', async (req, res) => {
  const { userQuery, context = {}, userId = null } = req.body;
  try {
    const sup = await supervise({ userQuery, context, userId });
    const plan = sup.plan || [];
    const results = await runReactExecutionAgent({ plan, userQuery, userId });
    res.json({ plan, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, permissions: permissionSettings }));

app.get('/api/debug/auth-metrics', (req, res) => {
  const summary = getAuthMetricsSummary();
  if (!summary.endpointEnabled) {
    return res.status(404).json({ error: 'Auth metrics endpoint is disabled. Set AUTH_METRICS_ENDPOINT_ENABLED=true to enable.' });
  }
  res.json(summary);
});

app.listen(PORT, APP_HOST, () => console.log(`Server listening http://${APP_HOST}:${PORT}`));
