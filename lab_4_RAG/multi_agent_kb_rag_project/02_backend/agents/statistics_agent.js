function toLimit(maxLimit = 200) {
  return Math.max(1, Number(maxLimit || 200));
}

export function buildStatisticsAgentQuery({ userRequest = '', maxLimit = 200 } = {}) {
  const request = String(userRequest || '').toLowerCase();
  const limit = toLimit(maxLimit);

  if (/\bnode\b|\bnodes\b/.test(request)) {
    return {
      sql: `SELECT COUNT(*)::int AS total_nodes FROM nodes LIMIT ${limit}`,
      params: [],
      reason: 'stats-nodes-count',
    };
  }

  if (/\brelationship\b|\brelationships\b|\bedge\b|\bedges\b/.test(request)) {
    return {
      sql: `SELECT COUNT(*)::int AS total_relationships FROM relationships LIMIT ${limit}`,
      params: [],
      reason: 'stats-relationships-count',
    };
  }

  if (/\battribute\b|\battributes\b/.test(request)) {
    return {
      sql: `SELECT COUNT(*)::int AS total_attributes FROM attributes LIMIT ${limit}`,
      params: [],
      reason: 'stats-attributes-count',
    };
  }

  if (/\bmemor(y|ies)\b/.test(request)) {
    return {
      sql: `SELECT COUNT(*)::int AS total_memories FROM memories LIMIT ${limit}`,
      params: [],
      reason: 'stats-memories-count',
    };
  }

  if (/government|request|status/.test(request)) {
    return {
      sql: `SELECT status, COUNT(*)::int AS total FROM government_requests GROUP BY status ORDER BY total DESC LIMIT ${limit}`,
      params: [],
      reason: 'stats-government-requests',
    };
  }

  if (/action|execute|proposal/.test(request)) {
    return {
      sql: `SELECT status, COUNT(*)::int AS total FROM actions GROUP BY status ORDER BY total DESC LIMIT ${limit}`,
      params: [],
      reason: 'stats-actions',
    };
  }

  return {
    sql: `SELECT COUNT(*)::int AS total_memories FROM memories LIMIT ${limit}`,
    params: [],
    reason: 'stats-memories-count',
  };
}
