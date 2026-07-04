import { Client } from 'pg';
import 'dotenv/config';

const client = new Client({
  user: process.env.DB_USER || 'sso_user',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'sso_db',
  password: process.env.DB_PASSWORD || 'sso_pass',
  port: parseInt(process.env.DB_PORT || '5433', 10),
});

async function main() {
  await client.connect();

  const fkQuery = `
    SELECT
      tc.table_name,
      kcu.column_name,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name,
      tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    WHERE tc.table_schema = 'public'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_name IN ('relationships', 'attributes')
    ORDER BY tc.table_name, tc.constraint_name;
  `;

  const countQuery = `
    SELECT 'nodes' AS table_name, count(*)::int AS row_count FROM nodes
    UNION ALL
    SELECT 'relationships' AS table_name, count(*)::int AS row_count FROM relationships
    UNION ALL
    SELECT 'attributes' AS table_name, count(*)::int AS row_count FROM attributes
    ORDER BY table_name;
  `;

  const embeddingQuery = `
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('nodes', 'relationships', 'attributes')
      AND column_name = 'embedding'
    ORDER BY table_name;
  `;

  const relJoinStatsQuery = `
    SELECT
      count(*)::int AS total_relationship_rows,
      count(*) FILTER (WHERE n_from.node_id IS NOT NULL)::int AS with_from_node_match,
      count(*) FILTER (WHERE n_to.node_id IS NOT NULL)::int AS with_to_node_match,
      count(*) FILTER (WHERE n_from.node_id IS NULL)::int AS missing_from_node_match,
      count(*) FILTER (WHERE n_to.node_id IS NULL)::int AS missing_to_node_match
    FROM relationships r
    LEFT JOIN nodes n_from ON r.from_node = n_from.node_id
    LEFT JOIN nodes n_to ON r.to_node = n_to.node_id;
  `;

  const attrJoinStatsQuery = `
    SELECT
      count(*)::int AS total_attribute_rows,
      count(*) FILTER (WHERE n.node_id IS NOT NULL)::int AS with_node_match,
      count(*) FILTER (WHERE n.node_id IS NULL)::int AS missing_node_match
    FROM attributes a
    LEFT JOIN nodes n ON a.node_id = n.node_id;
  `;

  const relJoinSamplesQuery = `
    SELECT
      r.from_node,
      COALESCE(n_from.name, n_from.title, n_from.description, n_from.content, n_from.node_id) AS from_node_label,
      r.to_node,
      COALESCE(n_to.name, n_to.title, n_to.description, n_to.content, n_to.node_id) AS to_node_label,
      COALESCE(r.rel_type, r.type) AS relationship_type
    FROM relationships r
    JOIN nodes n_from ON r.from_node = n_from.node_id
    JOIN nodes n_to ON r.to_node = n_to.node_id
    LIMIT 5;
  `;

  const attrJoinSamplesQuery = `
    SELECT
      a.node_id,
      COALESCE(n.name, n.title, n.description, n.content, n.node_id) AS node_label,
      a.key,
      a.value
    FROM attributes a
    JOIN nodes n ON a.node_id = n.node_id
    LIMIT 5;
  `;

  const fkRes = await client.query(fkQuery);
  const countRes = await client.query(countQuery);
  const embRes = await client.query(embeddingQuery);
  const relJoinStatsRes = await client.query(relJoinStatsQuery);
  const attrJoinStatsRes = await client.query(attrJoinStatsQuery);
  const relJoinSamplesRes = await client.query(relJoinSamplesQuery);
  const attrJoinSamplesRes = await client.query(attrJoinSamplesQuery);

  console.log(JSON.stringify({
    foreignKeys: fkRes.rows,
    rowCounts: countRes.rows,
    embeddingColumns: embRes.rows,
    relationshipNodeJoinStats: relJoinStatsRes.rows[0] || null,
    attributeNodeJoinStats: attrJoinStatsRes.rows[0] || null,
    relationshipNodeJoinSamples: relJoinSamplesRes.rows,
    attributeNodeJoinSamples: attrJoinSamplesRes.rows,
  }, null, 2));

  await client.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await client.end(); } catch {}
  process.exit(1);
});
