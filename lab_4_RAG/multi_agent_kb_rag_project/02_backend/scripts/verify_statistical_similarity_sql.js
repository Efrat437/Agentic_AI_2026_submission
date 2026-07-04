import 'dotenv/config';
import { createClient } from '../agents/dbTools.js';
import { buildHeuristicSqlFromSchema } from '../agents/sql_rag_agent.js';

async function getSchema(client) {
  const res = await client.query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='public';`);
  return res.rows;
}

async function getForeignKeys(client) {
  const res = await client.query(`
    SELECT
      tc.table_name,
      kcu.column_name,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name,
      tc.constraint_name
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
    ORDER BY tc.table_name, tc.constraint_name;
  `);
  return res.rows;
}

async function run(query) {
  const client = createClient();
  await client.connect();
  try {
    const schemaRows = await getSchema(client);
    const fkRows = await getForeignKeys(client);
    const sql = buildHeuristicSqlFromSchema(query, schemaRows, fkRows);
    const rows = await client.query(sql);
    return { query, sql, rowCount: rows.rows.length, sample: rows.rows.slice(0, 5) };
  } finally {
    await client.end();
  }
}

async function main() {
  const q1 = await run('which statistical areas are similar in socio-economic point of view to statistical_5000_111?');
  const q2 = await run('which statistical areas are similar in population number to sub area 111 within 5000 locality?');
  const q3 = await run('which statistical areas are similar in rent aspect to statistical_5000_111?');
  const q4 = await run('which nodes and relationships are similar to e_5000 in transport aspect?');
  console.log(JSON.stringify({ socioEconomic: q1, population: q2, genericAspect: q3, crossEntity: q4 }, null, 2));
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
