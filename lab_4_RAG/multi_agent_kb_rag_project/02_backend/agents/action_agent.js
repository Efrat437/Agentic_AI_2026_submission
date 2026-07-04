import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient, saveProposedAction, updateActionStatus, loadSqlFilesToDb } from './dbTools.js';
import { classifyQuery } from './classifier_agent.js';
import OpenAI from 'openai';
import { appendBufferEntry } from './memoryBuffer.js';
import { buildAgentSecurityPromptFramework } from './prompt_security_framework.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create OpenAI client only if API key present to avoid startup crashes
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// System prompt for SQL proposal: schema context + safety rules + few-shot + chain-of-thought.
// This agent is the mutation governor — it proposes parameterized SQL for human review before
// execution. SELECT is also supported for ad-hoc data inspection.
const PROPOSE_SYSTEM_PROMPT = `You are a SQL proposal agent for a PostgreSQL knowledge-base system.

## Schema (relevant tables)
- nodes(id BIGSERIAL, type TEXT, name TEXT, description TEXT, metadata JSONB, created_at TIMESTAMPTZ)
- relationships(id BIGSERIAL, from_node_id BIGINT, to_node_id BIGINT, type TEXT, weight NUMERIC, metadata JSONB)
- attributes(id BIGSERIAL, node_id BIGINT, key TEXT, value TEXT, metadata JSONB)
- government_requests(id BIGSERIAL, user_id TEXT, description TEXT, status TEXT, notes TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
- memories(id BIGSERIAL, user_id TEXT, agent TEXT, query TEXT, response JSONB, created_at TIMESTAMPTZ)
- actions(id BIGSERIAL, agent TEXT, user_query TEXT, proposed_sql TEXT, params JSONB, status TEXT, result JSONB, created_at TIMESTAMPTZ, executed_at TIMESTAMPTZ)

## Rules
1. Think step-by-step (one sentence of reasoning) before writing the SQL.
2. Prefer SELECT unless the user explicitly requests a data change.
3. NEVER generate DROP, TRUNCATE, ALTER, or DDL statements.
4. Always use parameterized placeholders ($1, $2, …) for any user-supplied values — never interpolate strings directly.
5. Return ONLY valid JSON in this exact shape: {"reasoning":"...","sql":"...","params":[...]}
6. params must be a JSON array of scalar values (strings, numbers, nulls) matching the $N placeholders in order.
7. If the request is ambiguous or cannot be expressed as safe SQL, set sql to "" and explain in reasoning.

## Query mechanisms — advanced SQL patterns available in this schema
- M1 Cosine embedding similarity (pgvector): nodes, relationships, and attributes tables have an
  \`embedding\` column (VECTOR(384)). Use the pgvector <=> distance operator to find semantically
  similar rows. Only propose this pattern when the user explicitly asks for similarity search.
  Pattern: SELECT id, name, embedding <=> $1::vector AS dist FROM nodes ORDER BY dist LIMIT $2
- M4 Graph traversal: traverse the knowledge graph by JOINing nodes → relationships → nodes.
  Use when the query asks about connections, links, or entities related to another entity.
  Pattern: SELECT n2.id, n2.name, r.type AS link
          FROM nodes n1
          JOIN relationships r ON r.from_node_id = n1.id
          JOIN nodes n2 ON n2.id = r.to_node_id 
          WHERE n1.name = $1
- M5 Recursive SQL expansion: multi-hop graph traversal using a recursive CTE.
  Use when the query chains connections across more than one hop.
  Pattern: WITH RECURSIVE hops AS (
            SELECT to_node_id, 1 AS depth FROM relationships WHERE from_node_id = $1
            UNION ALL
            SELECT r.to_node_id, h.depth + 1
            FROM relationships r JOIN hops h ON r.from_node_id = h.to_node_id
            WHERE h.depth < $2
          ) SELECT n.* FROM nodes n JOIN hops h ON n.id = h.to_node_id
- Prefer M4/M5 patterns over multiple separate queries when traversing the knowledge graph.
- Never embed raw user strings directly in SQL — always use $N parameterized placeholders.

## Few-shot examples
User: Count how many nodes have type "regulation"
{"reasoning":"Counting rows by a field value — straightforward aggregate SELECT.","sql":"SELECT COUNT(*) FROM nodes WHERE type = $1","params":["regulation"]}

User: Add a new node with type "policy" and name "Data Retention Policy"
{"reasoning":"User explicitly asks to add, so INSERT is appropriate. No user-supplied id — rely on BIGSERIAL.","sql":"INSERT INTO nodes (type, name) VALUES ($1, $2) RETURNING id, type, name","params":["policy","Data Retention Policy"]}

User: Update government request 7 status to approved
{"reasoning":"Explicit status update on a specific row by id — safe UPDATE with parameterized id and value.","sql":"UPDATE government_requests SET status = $1, updated_at = now() WHERE id = $2 RETURNING id, status","params":["approved",7]}

User: List the 5 most recent memories for user alice
{"reasoning":"Read-only retrieval ordered by recency, limited to 5 rows.","sql":"SELECT id, agent, query, created_at FROM memories WHERE user_id = $1 ORDER BY id DESC LIMIT 5","params":["alice"]}
` + `

${buildAgentSecurityPromptFramework({
  agentName: 'action_agent',
  goal: 'Propose safe parameterized SQL actions for review and controlled execution.',
  tools: [
    'SQL proposal JSON output: reasoning, sql, params',
    'Classifier routing for execute mode',
  ],
  outputContract: 'Return ONLY valid JSON in shape {"reasoning":"...","sql":"...","params":[...]}.',
})}`;

function getSqlVerb(sql = '') {
  const m = String(sql).trim().match(/^([a-z]+)/i);
  return m ? m[1].toUpperCase() : '';
}

function isMutationVerb(verb) {
  return ['INSERT', 'UPDATE', 'DELETE'].includes(verb);
}

// Propose an action (generate parameterized SQL but DO NOT execute)
export async function proposeAction({ userQuery, userId = null }) {
  if (!openai) {
    throw new Error('OPENAI_API_KEY not set — proposeAction requires an OpenAI key. Set OPENAI_API_KEY in your environment to enable LLM-based action proposals.');
  }

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: PROPOSE_SYSTEM_PROMPT },
      { role: 'user', content: userQuery },
    ],
    max_tokens: 500,
    temperature: 0,
  });

  const raw = resp.choices?.[0]?.message?.content?.trim() ?? '';
  // Strip optional ```json ... ``` code fences the model sometimes wraps around the response
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Could not parse SQL proposal from model. Raw response: ${raw.slice(0, 200)}`);
  }

  if (!json.sql) {
    throw new Error(`Model declined to produce SQL. Reasoning: ${json.reasoning || '(none)'}`);
  }

  const id = await saveProposedAction({ agent: 'action-agent', user_query: userQuery, proposed_sql: json.sql, params: json.params });
  appendBufferEntry({ agent: 'action-agent', userId, type: 'action-proposed', payload: { actionId: id, userQuery, sql: json.sql, reasoning: json.reasoning } });
  return { id, sql: json.sql, params: json.params, reasoning: json.reasoning };
}

// Execute a previously proposed action (requires confirmation)
// mode: 'auto' | 'sql' | 'semantic'
export async function executeAction({ actionId, mode = 'auto', permissions = {}, userId = null }) {
  const {
    executionEnabled = true,
    allowMutations = false,
    requireConfirmation = true,
    confirmed = false,
  } = permissions;

  if (!executionEnabled) {
    throw new Error('Action execution is disabled by policy');
  }

  const action = await (async () => { const client = createClient(); await client.connect(); const res = await client.query('SELECT * FROM actions WHERE id = $1', [actionId]); await client.end(); return res.rows[0]; })();
  if (!action) throw new Error('Action not found');

  // Decide routing — hybrid queries require the semantic/RAG layer too
  let chosen;
  if (mode === 'auto') {
    const cls = await classifyQuery(action.user_query || action.proposed_sql || '', { userId });
    chosen = cls === 'sql' ? 'sql' : 'semantic';
  } else {
    chosen = mode === 'sql' ? 'sql' : 'semantic';
  }

  if (chosen === 'semantic') {
    // Forward to semantic RAG agent: we don't execute SQL here, just mark forwarded.
    await updateActionStatus(actionId, 'forwarded', { forwardedTo: 'semantic-rag-agent', reason: `routed by classifier (${mode})` });
    appendBufferEntry({ agent: 'action-agent', userId, type: 'action-forwarded', payload: { actionId, target: 'semantic-rag-agent' } });
    return { forwarded: true, agent: 'semantic-rag-agent' };
  }

  // SQL execution path: allow SELECT always, mutations only when policy allows.
  const verb = getSqlVerb(action.proposed_sql);
  if (!['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(verb)) {
    throw new Error('Action SQL must start with SELECT, INSERT, UPDATE, or DELETE for SQL mode');
  }

  if (isMutationVerb(verb)) {
    if (!allowMutations) {
      throw new Error('Mutation queries are not allowed by policy');
    }
    if (requireConfirmation && !confirmed) {
      throw new Error('Mutation queries require explicit confirmation');
    }
  }

  const client = createClient();
  await client.connect();
  try {
    const params = JSON.parse(action.params || '[]');
    const res = await client.query(action.proposed_sql, params);
    await updateActionStatus(actionId, 'executed', res.rows || { rowCount: res.rowCount });
    appendBufferEntry({ agent: 'action-agent', userId, type: 'action-executed', payload: { actionId, rowCount: res.rowCount } });
    return res;
  } finally {
    await client.end();
  }
}

// Helper: load the three SQL files (attributes.sql, nodes.sql, relationships.sql) into DB.
// Resolves paths relative to the project root so this works on any machine / in Docker.
export async function loadProjectSqlFiles() {
  const candidateRoots = [
    path.resolve(__dirname, '../../04_data'),
    path.resolve(__dirname, '../../sql'),
  ];
  const base = candidateRoots.find((p) => ['attributes.sql', 'nodes.sql', 'relationships.sql']
    .every((f) => fs.existsSync(path.join(p, f))));
  const resolvedBase = base || path.resolve(__dirname, '../../sql');
  const files = ['attributes.sql', 'nodes.sql', 'relationships.sql'].map((f) => path.join(resolvedBase, f));
  await loadSqlFilesToDb(files);
  return { loaded: files };
}
