import { plan } from './planner.js';
import { appendBufferEntry } from './memoryBuffer.js';
import { classifyQuery } from './classifier_agent.js';
import { buildSchemaGrounding, formatSchemaGroundingForPrompt, getSchemaGraph } from './schemaGraph.js';

function isLikelyDbQuestion(text) {
  const q = String(text || '').toLowerCase();
  return /\b(table|tables|column|columns|row|rows|database|db|sql|count|how many|number of|node|nodes|relationship|relationships|attribute|attributes|district|city|program|plan|taba)\b/.test(q);
}

function classifyFallbackReason(err) {
  const msg = String(err?.message || '').toLowerCase();
  if (msg.includes('429') || msg.includes('quota') || msg.includes('rate limit')) {
    return 'fallback: upstream-rate-limited';
  }
  if (msg.includes('timeout') || msg.includes('timed out')) {
    return 'fallback: upstream-timeout';
  }
  return 'fallback: supervisor-unavailable';
}

export async function supervise({ userQuery, context = {}, userId = null } = {}) {
  // Keep the supervisor thin: delegate plan generation to planner.
  const planObj = await plan({ userQuery, context, userId });
  appendBufferEntry({ agent: 'supervisor-agent', userId, type: 'supervision', payload: { userQuery, stepCount: planObj.length } });
  return { plan: planObj };
}

// Map classifier_agent kinds to supervisor route vocabulary.
// Single source of truth for mechanism knowledge lives in classifier_agent.js.
function routeFromKind(kind) {
  if (kind === 'sql') return 'sql_query';
  if (kind === 'hybrid') return 'multi_step';
  return 'rag_query'; // 'semantic'
}

export async function supervisor(query, { userId = null, context = {} } = {}) {

  const recentConversation = Array.isArray(context?.recentConversation)
    ? context.recentConversation.slice(0, 4).map((m) => ({
      query: m?.query,
      decision: m?.decision?.route || null,
    }))
    : [];

  let schemaHint = null;
  try {
    const schema = await getSchemaGraph();
    const grounding = buildSchemaGrounding(query, schema, { maxTables: 6, maxColumns: 30, maxForeignKeys: 15 });
    schemaHint = formatSchemaGroundingForPrompt(grounding);
  } catch (_e) {
    schemaHint = null;
  }

  try {
    const kind = await classifyQuery(query, { userId, schemaHint, recentConversation });
    const route = routeFromKind(kind);
    const decision = { route, reason: 'classifier-agent' };
    appendBufferEntry({ agent: 'supervisor-agent', userId, type: 'decision', payload: { query, ...decision } });
    return decision;
  } catch (err) {
    const fallbackRoute = isLikelyDbQuestion(query) ? 'sql_query' : 'multi_step';
    const fallback = { route: fallbackRoute, reason: classifyFallbackReason(err) };
    appendBufferEntry({ agent: 'supervisor-agent', userId, type: 'decision', payload: { query, ...fallback } });
    return fallback;
  }
}
