import { createClient } from '../../../agents/dbTools.js';
import { validateSqlMutationStatement } from '../../../security/input_guards.js';

export async function sqlAction(sql, params = []) {
  const normalizedSql = validateSqlMutationStatement(sql);

  const client = createClient();
  await client.connect();
  try {
    const res = await client.query(normalizedSql, params);
    return { rowCount: res.rowCount };
  } finally {
    await client.end();
  }
}
