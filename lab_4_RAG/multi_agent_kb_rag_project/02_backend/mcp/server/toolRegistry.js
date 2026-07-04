import { sqlQuery } from './tools/sqlQuery.js';
import { sqlAction } from './tools/sqlAction.js';
import { ragSearch } from './tools/ragSearch.js';
import { memoryStore } from './tools/memoryStore.js';
import { fetchPublicUriJson, fetchPublicUrisJson } from './tools/webPublicUris.js';
import { newRequestForGovernment, getRequestStatus, updateRequestStatus } from './tools/governmentRequests.js';
import { ingestMunicipalityWebToRag, ingestSqlCorpusToRag, getLocalGovernmentRagStats, resetLocalGovernmentRagData } from './tools/localGovRag.js';
import { actionPropose, actionGet, actionExecute } from './tools/actionAgent.js';
import { classifyQueryTool } from './tools/classifier.js';
import { runManagerAgentOperation } from '../../agents/manager_agent.js';
import { compareRetrievalPathways, langgraphRetrievalQuery, runRetrievalCompareEvaluation } from './tools/langgraphRetrieval.js';

const MCP_VALIDATE_ARGS = String(process.env.MCP_VALIDATE_ARGS || 'false').toLowerCase() === 'true';

function normalizeRegisterArgs(descriptionOrMeta, maybeHandler, maybeHandler2) {
  if (typeof descriptionOrMeta === 'string') {
    return {
      description: descriptionOrMeta,
      inputSchema: null,
      handler: maybeHandler,
    };
  }

  const meta = descriptionOrMeta && typeof descriptionOrMeta === 'object' ? descriptionOrMeta : {};
  const handler = typeof maybeHandler2 === 'function' ? maybeHandler2 : maybeHandler;
  return {
    description: meta.description || '',
    inputSchema: meta.inputSchema || null,
    handler,
  };
}

function isPrimitiveTypeMatch(value, expectedType) {
  if (expectedType === 'string') return typeof value === 'string';
  if (expectedType === 'boolean') return typeof value === 'boolean';
  if (expectedType === 'number' || expectedType === 'integer') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (expectedType === 'array') return Array.isArray(value);
  if (expectedType === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return true;
}

function validateArgsWithJsonSchema(args, inputSchema) {
  const errors = [];
  if (!inputSchema || typeof inputSchema !== 'object') {
    return { ok: true, errors };
  }

  const schemaType = inputSchema.type || 'object';
  if (schemaType !== 'object') {
    return { ok: true, errors };
  }

  const payload = args && typeof args === 'object' ? args : {};
  const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
  const properties = inputSchema.properties && typeof inputSchema.properties === 'object'
    ? inputSchema.properties
    : {};

  for (const key of required) {
    if (payload[key] === undefined || payload[key] === null) {
      errors.push(`Missing required argument: ${key}`);
    }
  }

  for (const [key, schema] of Object.entries(properties)) {
    if (payload[key] === undefined || payload[key] === null || !schema || typeof schema !== 'object') {
      continue;
    }

    if (Array.isArray(schema.type)) {
      const typeOk = schema.type.some((t) => isPrimitiveTypeMatch(payload[key], t));
      if (!typeOk) {
        errors.push(`Invalid type for argument '${key}': expected one of [${schema.type.join(', ')}]`);
      }
      continue;
    }

    if (schema.type && !isPrimitiveTypeMatch(payload[key], schema.type)) {
      errors.push(`Invalid type for argument '${key}': expected ${schema.type}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function normalizeQueryText(query) {
  return String(query || '').toLowerCase();
}

// MCP-side routing helper so tool selection can happen at the tool boundary.
export function decideToolFromQuery(query) {
  const q = normalizeQueryText(query);

  const hasRequestId = /\b(request|ticket|case)\s*(id|#)?\s*[:=-]?\s*\d+\b/.test(q)
    || /\b(id|#)\s*[:=-]?\s*\d+\b/.test(q);
  const wantsRequestUpdate = /\b(update request status|set request status|change request status|approve request|reject request|close request)\b/.test(q);
  const wantsRequestStatus = /\b(request status|status of request|check request status|track request)\b/.test(q)
    || (/\brequest\b/.test(q) && /\bstatus\b/.test(q));
  const wantsRequestCreate = /\b(service request|government request|new request|schedule an appointment|appointment)\b/.test(q);
  const wantsAction = /\b(insert|update|delete|create|drop|alter|set status)\b/.test(q);
  const wantsSql = /\b(sql|table|tables|row|rows|column|columns|count|how many|number of|database|db|nodes|relationships|attributes|city|district|program|plan|taba|join|foreign key|fk)\b/.test(q);
  const wantsSemantic = /\b(explain|summarize|summary|meaning|about|policy|document|semantic|rag|unstructured|text|context|insight|why|how does)\b/.test(q);
  const explicitHybrid = /\b(hybrid|combine|both|structured and unstructured|sql and semantic)\b/.test(q);
  const wantsClassification = /\b(classify|classification|route this query|which route)\b/.test(q);
  const wantsLangGraphCompare = /\b(compare|comparison|benchmark|evaluate|eval|report)\b/.test(q)
    && /\b(langgraph|baseline|ragas|retrieval)\b/.test(q);
  const wantsLangGraphBatchEval = /\b(dataset|batch|aggregate|sample)\b/.test(q)
    && /\b(langgraph|baseline|ragas|retrieval|eval|evaluation)\b/.test(q);
  const wantsLangGraph = /\b(langgraph|graph retrieval|retrieval layer)\b/.test(q);
  const wantsActionProposal = /\b(propose action|draft action|prepare action|preview action|suggest action sql)\b/.test(q);
  const wantsActionGet = /\b(get action|action status|show action)\b/.test(q) && hasRequestId;
  const wantsActionExecute = /\b(execute action|run action|apply action|confirm action)\b/.test(q) && hasRequestId;
  const wantsUserManagement = /\b(create|add|new|delete|remove|deactivate)\b.*\b(user|users|account|accounts)\b|\b(user|users|account|accounts)\b.*\b(create|add|new|delete|remove|deactivate)\b/.test(q);

  if (wantsClassification) return { tool: 'classify_query', reason: 'explicit classification intent' };
  if (wantsLangGraphBatchEval) return { tool: 'retrieval_compare_eval', reason: 'dataset-level retrieval evaluation intent' };
  if (wantsLangGraphCompare) return { tool: 'retrieval_compare', reason: 'langgraph vs baseline comparison intent' };
  if (wantsLangGraph) return { tool: 'langgraph_retrieval_query', reason: 'langgraph retrieval intent' };
  if (wantsActionProposal) return { tool: 'action_propose', reason: 'action proposal intent' };
  if (wantsActionGet) return { tool: 'action_get', reason: 'action retrieval intent' };
  if (wantsActionExecute) return { tool: 'action_execute', reason: 'action execution intent' };
  if (wantsUserManagement) return { tool: 'agent_manager', reason: 'user management intent' };

  if (wantsRequestUpdate && hasRequestId) return { tool: 'update_request_status', reason: 'government request status update intent' };
  if (wantsRequestStatus && hasRequestId) return { tool: 'get_request_status', reason: 'government request status lookup intent' };
  if (wantsRequestCreate || wantsRequestStatus || wantsRequestUpdate) return { tool: 'new_request_for_government', reason: 'government request workflow intent' };
  if (wantsAction) return { tool: 'sql_action', reason: 'mutation intent' };
  if (explicitHybrid || (wantsSql && wantsSemantic)) return { tool: 'hybrid_query', reason: 'hybrid structured + unstructured intent' };
  if (wantsSql) return { tool: 'sql_query', reason: 'structured SQL intent' };
  return { tool: 'semantic_rag_query', reason: 'semantic/unstructured intent' };
}

class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(name, descriptionOrMeta, handler) {
    const normalized = normalizeRegisterArgs(descriptionOrMeta, handler);
    if (typeof normalized.handler !== 'function') {
      throw new Error(`Tool '${name}' must provide a handler function`);
    }

    this.tools.set(name, {
      description: normalized.description,
      inputSchema: normalized.inputSchema,
      handler: normalized.handler,
    });
  }

  has(name) {
    return this.tools.has(name);
  }

  list() {
    return Array.from(this.tools.entries()).map(([name, def]) => ({
      name,
      description: def.description,
      inputSchema: def.inputSchema || { type: 'object', properties: {} },
    }));
  }

  async call(name, args = {}) {
    const def = this.tools.get(name);
    if (!def) throw new Error(`MCP tool not found: ${name}`);

    const validation = validateArgsWithJsonSchema(args, def.inputSchema);
    if (!validation.ok && MCP_VALIDATE_ARGS) {
      throw new Error(`Invalid arguments for '${name}': ${validation.errors.join('; ')}`);
    }

    return def.handler(args);
  }
}

export function buildDefaultRegistry() {
  const registry = new ToolRegistry();

  registry.register('sql_query', {
    description: 'Query structured urban planning data',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language query for SQL-RAG.' },
        userId: { type: ['string', 'null'], description: 'Optional user identifier.' },
        systemPrompt: { type: ['string', 'null'], description: 'Optional orchestrator system prompt.' },
        sqlOptions: {
          type: 'object',
          description: 'Optional SQL controls: recursiveEnabled, recursiveMaxDepth, sqlRewriterEnabled.',
        },
        securityContext: {
          type: 'object',
          description: 'Optional secure SQL execution context (jwt user + permissions + requestedAgent).',
        },
      },
      required: ['query'],
    },
  }, async ({ query, userId = null, sqlOptions = {}, systemPrompt = '', securityContext = null }) => {
    return sqlQuery(query, userId, sqlOptions, systemPrompt || '', securityContext);
  });

  registry.register('sql_rag_query', {
    description: 'Alias of sql_query for SQL-RAG over structured data',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language query for SQL-RAG.' },
        userId: { type: ['string', 'null'], description: 'Optional user identifier.' },
        systemPrompt: { type: ['string', 'null'], description: 'Optional orchestrator system prompt.' },
        sqlOptions: {
          type: 'object',
          description: 'Optional SQL controls: recursiveEnabled, recursiveMaxDepth, sqlRewriterEnabled.',
        },
        securityContext: {
          type: 'object',
          description: 'Optional secure SQL execution context (jwt user + permissions + requestedAgent).',
        },
      },
      required: ['query'],
    },
  }, async ({ query, userId = null, sqlOptions = {}, systemPrompt = '', securityContext = null }) => {
    return sqlQuery(query, userId, sqlOptions, systemPrompt || '', securityContext);
  });

  registry.register('sql_action', {
    description: 'Execute SQL mutation action',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'Mutation SQL statement (INSERT/UPDATE/DELETE).' },
        params: { type: 'array', description: 'Parameterized SQL values.' },
      },
      required: ['sql'],
    },
  }, async ({ sql, params = [] }) => {
    return sqlAction(sql, params);
  });

  registry.register('classify_query', {
    description: 'Classify a user query as sql | semantic | hybrid and mapped supervisor route',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'User query to classify.' },
        userId: { type: ['string', 'null'], description: 'Optional user identifier.' },
      },
      required: ['query'],
    },
  }, async ({ query, userId = null }) => {
    return classifyQueryTool({ query, userId });
  });

  registry.register('action_propose', {
    description: 'Propose a safe parameterized SQL action (human-in-the-loop pattern)',
    inputSchema: {
      type: 'object',
      properties: {
        userQuery: { type: 'string', description: 'Natural-language action request.' },
        userId: { type: ['string', 'null'], description: 'Optional user identifier.' },
      },
      required: ['userQuery'],
    },
  }, async ({ userQuery, userId = null }) => {
    return actionPropose({ userQuery, userId });
  });

  registry.register('action_get', {
    description: 'Fetch a proposed action record by action ID',
    inputSchema: {
      type: 'object',
      properties: {
        actionId: { type: ['integer', 'number', 'string'], description: 'Action ID.' },
      },
      required: ['actionId'],
    },
  }, async ({ actionId }) => {
    return actionGet({ actionId });
  });

  registry.register('action_execute', {
    description: 'Execute a previously proposed action with policy-aware permission checks',
    inputSchema: {
      type: 'object',
      properties: {
        actionId: { type: ['integer', 'number', 'string'], description: 'Action ID to execute.' },
        mode: { type: 'string', description: 'Execution mode: auto | sql | semantic.' },
        userId: { type: ['string', 'null'], description: 'Optional user identifier.' },
        confirmed: { type: 'boolean', description: 'Explicit mutation confirmation flag.' },
        allowMutations: { type: 'boolean', description: 'Allow SQL mutations when server policy permits.' },
      },
      required: ['actionId'],
    },
  }, async ({ actionId, mode = 'auto', userId = null, confirmed = false, allowMutations = false }) => {
    return actionExecute({ actionId, mode, userId, confirmed, allowMutations });
  });

  registry.register('agent_manager', {
    description: 'Manage users (create/delete) through privileged manager operation flow',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create_user', 'delete_user'] },
        firstName: { type: ['string', 'null'] },
        lastName: { type: ['string', 'null'] },
        password: { type: ['string', 'null'] },
        username: { type: ['string', 'null'] },
        userId: { type: ['number', 'string', 'null'] },
        securityContext: { type: 'object' },
      },
      required: ['action'],
    },
  }, async ({ action, firstName = null, lastName = null, password = null, username = null, userId = null, securityContext = null }) => {
    const jwtUser = securityContext && typeof securityContext === 'object' ? securityContext.jwtUser : null;
    const userPermissions = securityContext && typeof securityContext === 'object' ? securityContext.userPermissions : null;
    const normalizedAction = String(action || '').trim().toLowerCase();

    return runManagerAgentOperation({
      action: normalizedAction,
      payload: {
        firstName: firstName == null ? undefined : String(firstName),
        lastName: lastName == null ? undefined : String(lastName),
        password: password == null ? undefined : String(password),
        username: username == null ? undefined : String(username),
        userId: userId == null ? undefined : String(userId),
      },
      actorUserId: String(jwtUser?.userId || 'mcp-agent-manager').trim(),
      actorUsername: String(jwtUser?.userId || 'mcp-agent-manager').trim(),
      role: String(jwtUser?.role || '').trim().toLowerCase(),
      permissions: userPermissions,
    });
  });

  registry.register('rag_search', {
    description: 'Search planning documents (supports sqlOptions incl. sqlIngestLayerEnabled via ingestSqlTablesToRag bootstrap)',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Semantic query string.' },
        userId: { type: ['string', 'null'], description: 'Optional user identifier.' },
        topK: { type: ['integer', 'number', 'null'], description: 'Optional retrieval top-K override.' },
        useRerank: { type: ['boolean', 'null'], description: 'Optional semantic rerank toggle.' },
        systemPrompt: { type: ['string', 'null'], description: 'Optional orchestrator system prompt.' },
        sqlOptions: { type: 'object', description: 'Optional semantic/sql-ingest controls.' },
      },
      required: ['query'],
    },
  }, async ({ query, userId = null, topK = null, useRerank = null, systemPrompt = '', sqlOptions = {} }) => {
    return ragSearch(query, userId, systemPrompt || '', sqlOptions || {}, topK, useRerank);
  });

  registry.register('langgraph_retrieval_query', {
    description: 'Run the LangGraph retrieval layer on top of the existing retrieval agents',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'User query to run through the LangGraph retrieval layer.' },
        userId: { type: ['string', 'null'], description: 'Optional user identifier.' },
        sessionId: { type: ['string', 'null'], description: 'Optional session identifier.' },
        threadId: { type: ['string', 'null'], description: 'Optional thread identifier.' },
        evalMode: { type: 'boolean', description: 'Enable fair-evaluation isolation and cleanup.' },
        sqlOptions: { type: 'object', description: 'Optional retrieval-layer SQL and semantic controls.' },
      },
      required: ['query'],
    },
  }, async ({ query, userId = null, sessionId = null, threadId = null, evalMode = false, sqlOptions = {} }) => {
    return langgraphRetrievalQuery({ query, userId, sessionId, threadId, evalMode, sqlOptions });
  });

  registry.register('retrieval_compare', {
    description: 'Compare baseline retrieval against the LangGraph retrieval layer and return the live RAGAS-style report',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'User query to compare across retrieval pathways.' },
        userId: { type: ['string', 'null'], description: 'Optional user identifier.' },
        evalMode: { type: 'boolean', description: 'Enable fair-evaluation isolation and cleanup.' },
        sqlOptions: { type: 'object', description: 'Optional retrieval-layer SQL and semantic controls.' },
      },
      required: ['query'],
    },
  }, async ({ query, userId = null, evalMode = true, sqlOptions = {} }) => {
    return compareRetrievalPathways({ query, userId, evalMode, sqlOptions });
  });

  registry.register('retrieval_compare_eval', {
    description: 'Run the JavaScript dataset-level retrieval comparison evaluator and return the aggregated RAGAS-style report',
    inputSchema: {
      type: 'object',
      properties: {
        baseUrl: { type: ['string', 'null'], description: 'Backend base URL for the compare endpoint.' },
        dataset: { type: ['string', 'null'], description: 'Optional dataset path.' },
        output: { type: ['string', 'null'], description: 'Optional output JSON path.' },
        limit: { type: ['integer', 'number', 'null'], description: 'Optional dataset item limit.' },
        topK: { type: ['integer', 'number', 'null'], description: 'Optional retrieval top-K override.' },
      },
    },
  }, async ({ baseUrl = null, dataset = null, output = '', limit = 0, topK = null }) => {
    return runRetrievalCompareEvaluation({
      baseUrl: baseUrl || undefined,
      dataset: dataset || undefined,
      output: output || '',
      limit,
      topK: topK == null ? undefined : topK,
    });
  });

  registry.register('semantic_rag_query', {
    description: 'Alias of rag_search for semantic RAG over unstructured data, with sqlOptions support for ingestSqlTablesToRag bootstrap',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Semantic query string.' },
        userId: { type: ['string', 'null'], description: 'Optional user identifier.' },
        topK: { type: ['integer', 'number', 'null'], description: 'Optional retrieval top-K override.' },
        useRerank: { type: ['boolean', 'null'], description: 'Optional semantic rerank toggle.' },
        systemPrompt: { type: ['string', 'null'], description: 'Optional orchestrator system prompt.' },
        sqlOptions: { type: 'object', description: 'Optional semantic/sql-ingest controls.' },
      },
      required: ['query'],
    },
  }, async ({ query, userId = null, topK = null, useRerank = null, systemPrompt = '', sqlOptions = {} }) => {
    return ragSearch(query, userId, systemPrompt || '', sqlOptions || {}, topK, useRerank);
  });

  registry.register('hybrid_query', {
    description: 'Run SQL-RAG and semantic RAG together and return merged result (sqlOptions can enable ingestSqlTablesToRag-backed semantic bootstrap)',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Hybrid query string.' },
        userId: { type: ['string', 'null'], description: 'Optional user identifier.' },
        systemPrompt: { type: ['string', 'null'], description: 'Optional orchestrator system prompt.' },
        sqlOptions: { type: 'object', description: 'Optional SQL/semantic layer controls.' },
        securityContext: {
          type: 'object',
          description: 'Optional secure SQL execution context (jwt user + permissions + requestedAgent).',
        },
      },
      required: ['query'],
    },
  }, async ({ query, userId = null, systemPrompt = '', sqlOptions = {}, securityContext = null }) => {
    const [structured, unstructured] = await Promise.all([
      sqlQuery(query, userId, sqlOptions || {}, systemPrompt || '', securityContext),
      ragSearch(query, userId, systemPrompt || '', sqlOptions || {}),
    ]);

    return {
      mode: 'hybrid',
      query,
      structured,
      unstructured,
      summary: {
        sqlRows: Array.isArray(structured?.rows) ? structured.rows.length : 0,
        ragDocs: Array.isArray(unstructured?.docs) ? unstructured.docs.length : 0,
      },
    };
  });

  registry.register('store_memory', {
    description: 'Store user conversation memory',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: ['string', 'null'], description: 'User identifier.' },
        content: { type: 'string', description: 'Memory text to store.' },
      },
      required: ['content'],
    },
  }, async ({ userId, content }) => {
    return memoryStore(userId, content);
  });

  registry.register('fetch_public_uri_json', {
    description: 'Fetch one approved public URI and return JSON metadata + text extract',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'One approved public URL.' },
        maxChars: { type: 'integer', description: 'Max extracted characters.' },
      },
      required: ['url'],
    },
  }, async ({ url, maxChars = 4000 }) => {
    return fetchPublicUriJson({ url, maxChars });
  });

  registry.register('fetch_public_uris_json', {
    description: 'Fetch multiple approved public URIs and return JSON results',
    inputSchema: {
      type: 'object',
      properties: {
        urls: { type: 'array', description: 'Approved public URLs.' },
        maxChars: { type: 'integer', description: 'Max extracted characters per URL.' },
      },
      required: ['urls'],
    },
  }, async ({ urls = [], maxChars = 2500 }) => {
    return fetchPublicUrisJson({ urls, maxChars });
  });

  registry.register('new_request_for_goverment', {
    description: 'Create a local government service request in SQL DB',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Request description.' },
        userId: { type: ['string', 'null'], description: 'Optional user identifier.' },
        notes: { type: ['string', 'null'], description: 'Optional request notes.' },
      },
      required: ['description'],
    },
  }, async ({ description, userId = null, notes = null }) => {
    return newRequestForGovernment({ description, userId, notes });
  });

  // Backward-compatible typo alias kept for existing clients, with correct-spelling alias added.
  registry.register('new_request_for_government', {
    description: 'Alias of new_request_for_goverment',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Request description.' },
        userId: { type: ['string', 'null'], description: 'Optional user identifier.' },
        notes: { type: ['string', 'null'], description: 'Optional request notes.' },
      },
      required: ['description'],
    },
  }, async ({ description, userId = null, notes = null }) => {
    return newRequestForGovernment({ description, userId, notes });
  });

  registry.register('get_request_status', {
    description: 'Get local government request status by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'number', 'string'], description: 'Request ID.' },
      },
      required: ['id'],
    },
  }, async ({ id }) => {
    return getRequestStatus({ id });
  });

  registry.register('update_request_status', {
    description: 'Update local government request status by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'number', 'string'], description: 'Request ID.' },
        status: { type: 'string', description: 'New request status value (new|in_progress|approved|rejected|closed).' },
        notes: { type: ['string', 'null'], description: 'Optional notes for status update.' },
      },
      required: ['id', 'status'],
    },
  }, async ({ id, status, notes = null }) => {
    return updateRequestStatus({ id, status, notes });
  });

  registry.register('ingest_municipality_web_to_rag', {
    description: 'Fetch municipality web pages, chunk text, and store in RAG corpus',
    inputSchema: {
      type: 'object',
      properties: {
        urls: { type: 'array', description: 'Municipality URLs to ingest.' },
        truncate: { type: 'boolean', description: 'Truncate corpus before ingest.' },
        chunkSize: { type: 'integer', description: 'Chunk size in characters.' },
        chunkOverlap: { type: 'integer', description: 'Overlap between chunks.' },
        minRelevanceScore: { type: 'integer', description: 'Minimum relevance score for HTML blocks to keep.' },
      },
      required: [],
    },
  }, async ({ urls = [], truncate = false, chunkSize = 1000, chunkOverlap = 150, minRelevanceScore = 1 }) => {
    return ingestMunicipalityWebToRag({ urls, truncate, chunkSize, chunkOverlap, minRelevanceScore });
  });

  registry.register('local_gov_rag_stats', {
    description: 'Return stats for the local-government RAG corpus partition',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  }, async () => {
    return getLocalGovernmentRagStats();
  });

  registry.register('reset_local_gov_rag', {
    description: 'Delete only local-government RAG docs for efficient re-ingest',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  }, async () => {
    return resetLocalGovernmentRagData();
  });

  registry.register('ingest_sql_corpus_to_rag', {
    description: 'Load SQL files and ingest attributes/nodes/relationships into RAG corpus',
    inputSchema: {
      type: 'object',
      properties: {
        truncate: { type: 'boolean', description: 'Truncate corpus before ingest.' },
        tables: { type: 'array', description: 'Table names to ingest.' },
        sqlFiles: { type: 'array', description: 'Optional SQL file paths.' },
      },
      required: [],
    },
  }, async ({ truncate = false, tables = ['attributes', 'nodes', 'relationships'], sqlFiles = [] }) => {
    return ingestSqlCorpusToRag({ truncate, tables, sqlFiles });
  });

  return registry;
}
