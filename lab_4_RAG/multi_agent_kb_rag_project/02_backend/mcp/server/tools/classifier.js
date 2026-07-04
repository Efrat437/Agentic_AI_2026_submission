import { classifyQuery } from '../../../agents/classifier_agent.js';

function mapKindToRoute(kind) {
  if (kind === 'sql') return 'sql_query';
  if (kind === 'hybrid') return 'multi_step';
  return 'rag_query';
}

export async function classifyQueryTool({ query, userId = null } = {}) {
  const kind = await classifyQuery(query, { userId });
  return {
    kind,
    route: mapKindToRoute(kind),
  };
}
