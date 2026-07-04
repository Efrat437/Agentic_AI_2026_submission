import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

const client = new Client({
  user: process.env.DB_USER || 'sso_user',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'sso_db',
  password: process.env.DB_PASSWORD || 'sso_pass',
  port: parseInt(process.env.DB_PORT || '5433', 10),
});

const sql = `
WITH all_relationship_ends AS (
  SELECT from_node AS node_id FROM relationships WHERE from_node IS NOT NULL
  UNION ALL
  SELECT to_node AS node_id FROM relationships WHERE to_node IS NOT NULL
),
relationship_counts AS (
  SELECT node_id, COUNT(*)::int AS total_relationships
  FROM all_relationship_ends
  GROUP BY node_id
)
SELECT
  rc.node_id,
  coalesce(n.name, n.title, n.description, n.content, rc.node_id) AS node_name,
  rc.total_relationships
FROM relationship_counts rc
LEFT JOIN nodes n ON n.node_id = rc.node_id
ORDER BY rc.total_relationships DESC, rc.node_id
LIMIT 5`;

async function main() {
  await client.connect();
  const result = await client.query(sql);
  console.log(JSON.stringify(result.rows, null, 2));
  await client.end();
}

main().catch(async (err) => {
  console.error(err.message || err);
  try { await client.end(); } catch {}
  process.exit(1);
});
