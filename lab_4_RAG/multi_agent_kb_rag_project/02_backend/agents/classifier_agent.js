import OpenAI from 'openai';
import 'dotenv/config';
import { appendBufferEntry } from './memoryBuffer.js';
import { buildAgentSecurityPromptFramework } from './prompt_security_framework.js';
import { buildLlmMetrics, emptyLlmMetrics, metricFromChatCompletionResponse } from '../services/llmMetrics.js';

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// System prompt: rules + few-shot examples + chain-of-thought instruction
// Aware of ingestSqlTablesToRag bootstrap layer (always runs before semantic/hybrid tools).
const CLASSIFIER_SYSTEM_PROMPT = `You are a query-type classifier for a multi-agent knowledge-base system.

## Context
The system has three execution paths:
- SQL: structured queries answered by running parameterized SQL against PostgreSQL tables
  (nodes, relationships, attributes). Best for counting, filtering, aggregating, or retrieving
  specific rows by field value.
- SEMANTIC: natural-language questions answered by vector-similarity search over rag_documents.
  The rag_documents store is pre-populated via the ingestSqlTablesToRag bootstrap layer which
  copies SQL table rows into embeddings. Best for "tell me about", "related to", "similar to",
  "explain", "describe", "history of", "why", conceptual or open-ended questions.
- HYBRID: questions that require both structured filtering AND semantic similarity in a single
  plan. Use when the query contains an explicit field filter (id, status, date range, type)
  AND asks for conceptual context or similarity ranking in the same request.

## Retrieval mechanisms (understand these to reason about routing)
- M1 Cosine embedding similarity: the user question is embedded as a 384-dim vector and compared
  against embedding columns in nodes/relationships/attributes tables, OR against rag_documents
  (pre-populated by ingestSqlTablesToRag). Activated by SEMANTIC and HYBRID routes via pgvector
  <=> operator. Produces similarity-ranked results without a WHERE clause.
- M2 Semantic similarity inference layer: when explicit attribute keys are absent the system infers
  similar attribute dimensions from the embedded attribute space. Applies to SEMANTIC queries where
  the question uses natural-language descriptions that don't map to any column name.
- M3 Proxy index layer: maps natural-language query aspects to canonical attribute keys before SQL
  filtering (e.g. "privacy-related" → key: "domain", value: "privacy"). Applies to HYBRID when an
  implicit structured filter is phrased in natural language.
- M4 SQL rewrite + graph traversal: rewrites the query to JOIN across the relationships table
  (nodes → relationships → nodes) to traverse the knowledge graph. Activated when the query asks
  about connected entities, paths, or multi-entity links. Applies to SQL and HYBRID routes.
- M5 Multi-anchor + recursive SQL: expands from multiple entity anchors using recursive CTEs for
  multi-hop traversal. Activated when the query chains connections across several hops.
  Applies to SQL and HYBRID routes.

## Rules
1. Always reason step-by-step (one short sentence) before stating your answer.
2. Prefer SEMANTIC for natural-language questions even if they use words like "list" or "which".
3. Prefer SQL only when the query clearly targets a specific field value, count, or aggregate.
4. Choose HYBRID when both a structured filter and a conceptual/similarity requirement coexist.
5. Queries about entity connections or multi-hop paths activate M4/M5 — route SQL or HYBRID.
6. Reply ONLY with the format: Reasoning: <one sentence>. Answer: SQL | SEMANTIC | HYBRID

## Few-shot examples
Q: How many nodes have type "regulation"?
Reasoning: Counting rows by a field value is a structured SQL aggregate.
Answer: SQL

Q: What is the relationship between data privacy and GDPR compliance?
Reasoning: This is a conceptual open-ended question best answered by semantic similarity over ingestSqlTablesToRag embeddings.
Answer: SEMANTIC

Q: Find regulations similar to node id=42 that were created after 2023.
Reasoning: The date filter requires SQL but the similarity ranking requires the semantic RAG layer — hybrid needed.
Answer: HYBRID

Q: List all attributes for the "identity" node.
Reasoning: Retrieving all attributes of a specific named node is a direct SQL lookup by field value.
Answer: SQL

Q: Explain why access control policies matter in SSO systems.
Reasoning: An explanatory conceptual question — best served by semantic search over the RAG store.
Answer: SEMANTIC
`;

const CLASSIFIER_SYSTEM_PROMPT_EFFECTIVE = `${CLASSIFIER_SYSTEM_PROMPT}

${buildAgentSecurityPromptFramework({
  agentName: 'classifier_agent',
  goal: 'Classify each user query into SQL, SEMANTIC, or HYBRID with deterministic routing.',
  tools: [
    'Classifier output labels: SQL | SEMANTIC | HYBRID (routing only, no execution).',
    'Schema grounding and recent conversation hints when provided by supervisor.',
  ],
  outputContract: 'Reply ONLY with: Reasoning: <one sentence>. Answer: SQL | SEMANTIC | HYBRID',
})}`;

// Parse the model reply: extract Answer: SQL | SEMANTIC | HYBRID
function parseLlmAnswer(text) {
  const match = String(text || '').match(/Answer:\s*(SQL|SEMANTIC|HYBRID)/i);
  if (!match) return null;
  const word = match[1].toUpperCase();
  if (word === 'SQL') return 'sql';
  if (word === 'HYBRID') return 'hybrid';
  return 'semantic';
}

// Heuristic fallback when no OpenAI key is available.
// Scores sql/semantic/hybrid signals independently instead of short-circuiting.
function heuristicClassify(q) {
  const explicitEntityId = /\b(?:e|statistical)_[a-z0-9_]+\b/i.test(q);
  const explicitAttributeLookup = /\bwhat\s+is\s+the\s+[a-z_][a-z0-9_]*\s+for\s+(?:e|statistical)_[a-z0-9_]+\b/i.test(q);
  const explicitParentLookup = /\bwhich\s+parent\s+does\s+(?:e|statistical)_[a-z0-9_]+\s+belong\s+to\b/i.test(q);
  const explicitRelationshipLookup = /\bbelongs?_to\b/i.test(q) || /\bbelong\s+to\b/i.test(q);
  if (explicitAttributeLookup || explicitParentLookup || (explicitEntityId && explicitRelationshipLookup)) {
    return 'sql';
  }

  // Strong SQL signals: SQL keywords or explicit structured-data patterns
  const strongSqlHints = ['select ', 'where ', 'join ', ' count(', ' sum(', ' avg(', ' min(', ' max(', 'group by', 'order by', 'update ', 'delete ', 'insert into'];
  // Moderate SQL signals: likely structured but could be natural language
  const softSqlHints = ['how many', 'rows', 'table', 'column', 'schema'];
  // Semantic signals: conceptual/natural-language questions
  const semanticHints = ['meaning', 'similar', 'related', 'find similar', 'semantic', 'what is', 'tell me about', 'describe', 'explain', 'history', 'who is', 'why', 'how does', 'what are'];
  // Hybrid signals: field filter + semantic request combined
  const hybridFilterHints = ['id=', 'id =', 'status=', 'after ', 'before ', 'since ', 'between ', 'created'];

  let sqlScore = 0;
  let semanticScore = 0;

  for (const h of strongSqlHints) if (q.includes(h)) sqlScore += 3;
  for (const h of softSqlHints) if (q.includes(h)) sqlScore += 1;
  for (const h of semanticHints) if (q.includes(h)) semanticScore += 2;

  const hasHybridFilter = hybridFilterHints.some((h) => q.includes(h));
  if (hasHybridFilter && semanticScore > 0) return 'hybrid';

  if (sqlScore > semanticScore && sqlScore >= 3) return 'sql';
  if (semanticScore >= sqlScore && semanticScore > 0) return 'semantic';

  // default: short queries → sql, longer prose → semantic
  return q.split(/\s+/).length < 6 ? 'sql' : 'semantic';
}

// schemaHint: optional schema grounding text from supervisor (adds FK/table context).
// recentConversation: optional array of {query, decision} objects from supervisor context.
export async function classifyQuery(query, { userId = null, schemaHint = null, recentConversation = null } = {}) {
  const detailed = await classifyQueryDetailed(query, { userId, schemaHint, recentConversation });
  return detailed.kind;
}

export async function classifyQueryDetailed(query, { userId = null, schemaHint = null, recentConversation = null } = {}) {
  const q = (query || '').toLowerCase();

  // Local heuristic if no OpenAI key
  if (!openai) {
    const kind = heuristicClassify(q);
    appendBufferEntry({ agent: 'classifier-agent', userId, type: 'classification', payload: { query, kind, mode: 'heuristic' } });
    return { kind, reasoning: 'Heuristic fallback classification.', llmMetrics: emptyLlmMetrics() };
  }

  // Build enriched user message — include schema and conversation hints when available
  const extras = [];
  if (schemaHint) extras.push(`Schema grounding:\n${schemaHint}`);
  if (Array.isArray(recentConversation) && recentConversation.length > 0) {
    const lines = recentConversation.slice(0, 4).map((m) => `  - ${m.query || ''} → ${m.decision || 'unknown'}`).join('\n');
    extras.push(`Recent conversation:\n${lines}`);
  }
  const userContent = extras.length > 0 ? `Q: ${query}\n\n${extras.join('\n\n')}` : `Q: ${query}`;

  // LLM-based classification with heuristic fallback when the API is unavailable or rate-limited.
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT_EFFECTIVE },
        { role: 'user', content: userContent },
      ],
      max_tokens: 60,
      temperature: 0,
    });

    const text = resp.choices?.[0]?.message?.content?.trim?.();
    if (!text) {
      appendBufferEntry({ agent: 'classifier-agent', userId, type: 'classification', payload: { query, kind: 'semantic', mode: 'llm-empty-fallback' } });
      return {
        kind: 'semantic',
        reasoning: '',
        llmMetrics: buildLlmMetrics([metricFromChatCompletionResponse(resp, { label: 'classifier_route' })]),
      };
    }

    const kind = parseLlmAnswer(text) ?? heuristicClassify(q);
    appendBufferEntry({ agent: 'classifier-agent', userId, type: 'classification', payload: { query, kind, mode: 'llm', reasoning: text } });
    return {
      kind,
      reasoning: text,
      llmMetrics: buildLlmMetrics([metricFromChatCompletionResponse(resp, { label: 'classifier_route' })]),
    };
  } catch (err) {
    const kind = heuristicClassify(q);
    appendBufferEntry({
      agent: 'classifier-agent',
      userId,
      type: 'classification',
      payload: {
        query,
        kind,
        mode: 'llm-error-fallback',
        error: String(err?.message || err),
      },
    });
    return {
      kind,
      reasoning: `Heuristic fallback after classifier error: ${String(err?.message || err)}`,
      llmMetrics: emptyLlmMetrics(),
    };
  }
}
