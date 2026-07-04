function toLimit(maxLimit = 120) {
  return Math.max(1, Number(maxLimit || 120));
}

export function buildGarAgentQuery({ userRequest = '', maxLimit = 120 } = {}) {
  const request = String(userRequest || '').toLowerCase();
  const limit = toLimit(maxLimit);

  if (/relationship|edge|link/.test(request)) {
    return {
      sql: `SELECT relationship_id, source_id, target_id, relation_type FROM relationships ORDER BY relationship_id LIMIT ${limit}`,
      params: [],
      reason: 'gar-relationships-read',
    };
  }

  if (/attribute|field|property/.test(request)) {
    return {
      sql: `SELECT attribute_id, node_id, key, value FROM attributes ORDER BY attribute_id LIMIT ${limit}`,
      params: [],
      reason: 'gar-attributes-read',
    };
  }

  return {
    sql: `SELECT node_id, title, type FROM nodes ORDER BY node_id LIMIT ${limit}`,
    params: [],
    reason: 'gar-nodes-read',
  };
}
