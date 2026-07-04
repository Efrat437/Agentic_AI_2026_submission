import 'dotenv/config';
import { createClient } from '../agents/dbTools.js';
import { runSemanticRAG } from '../agents/semantic_rag_agent.js';
import { runSQLRAG } from '../agents/sql_rag_agent.js';
import { supervisor, supervise } from '../agents/supervisor.js';
import { runReactExecutionAgent } from '../agents/reactExecutionAgent.js';
import { reflect } from '../agents/reflectionAgent.js';

function short(text, len = 140) {
  const s = String(text || '');
  return s.length > len ? `${s.slice(0, len)}...` : s;
}

async function checkEmbeddings() {
  const client = createClient();
  await client.connect();
  try {
    const embCols = await client.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (udt_name = 'vector' OR data_type = 'USER-DEFINED' OR column_name = 'embedding')
      ORDER BY table_name, column_name;
    `);

    const rows = [];
    for (const item of embCols.rows) {
      const table = item.table_name;
      const col = item.column_name;

      const q = `
        SELECT
          $1::text AS table_name,
          $2::text AS column_name,
          COUNT(*) FILTER (WHERE ${col} IS NOT NULL) AS embedded_rows,
          COUNT(*) AS total_rows,
          MIN(vector_dims(${col})) FILTER (WHERE ${col} IS NOT NULL) AS min_dim,
          MAX(vector_dims(${col})) FILTER (WHERE ${col} IS NOT NULL) AS max_dim
        FROM ${table}
      `;

      const r = await client.query(q, [table, col]);
      rows.push(r.rows[0]);
    }

    return rows;
  } finally {
    await client.end();
  }
}

async function main() {
  const out = {
    semanticRag: { ok: false },
    sqlRag: { ok: false },
    fullArchitectureFlow: { ok: false },
    embeddingCheck: { ok: false, rows: [] },
  };

  try {
    const s = await runSemanticRAG({
      query: 'What is Tel Aviv?',
      topK: 5,
      useRerank: false,
      userId: 'verify-user',
    });
    out.semanticRag = {
      ok: true,
      docs: Array.isArray(s?.docs) ? s.docs.length : 0,
      answerPreview: short(s?.answer),
    };
  } catch (e) {
    out.semanticRag = { ok: false, error: e.message };
  }

  try {
    const q = await runSQLRAG({
      userQuery: 'How many nodes are there?',
      systemPrompt: '',
      userId: 'verify-user',
    });
    out.sqlRag = {
      ok: true,
      sql: q?.sql || null,
      rowCount: Array.isArray(q?.rows) ? q.rows.length : 0,
      answerPreview: short(q?.answer),
    };
  } catch (e) {
    out.sqlRag = { ok: false, error: e.message };
  }

  try {
    const userQuery = 'Tell me briefly what Tel Aviv is';
    const decision = await supervisor(userQuery, { userId: 'verify-user' });
    let plan = [];

    if (decision.route === 'multi_step') {
      const sup = await supervise({ userQuery, context: {}, userId: 'verify-user' });
      plan = sup.plan || [];
    } else if (decision.route === 'sql_query') {
      plan = [{ tool: 'sql_query' }];
    } else {
      plan = [{ tool: 'rag_search' }];
    }

    const result = await runReactExecutionAgent({ plan, userQuery, userId: 'verify-user' });
    const reflection = await reflect(userQuery, JSON.stringify(result), { userId: 'verify-user' });

    out.fullArchitectureFlow = {
      ok: true,
      route: decision.route,
      planSteps: Array.isArray(plan) ? plan.length : 0,
      resultItems: Array.isArray(result) ? result.length : 0,
      reflectionQuality: reflection?.quality || null,
    };
  } catch (e) {
    out.fullArchitectureFlow = { ok: false, error: e.message };
  }

  try {
    const rows = await checkEmbeddings();
    const allDims384 = rows.length > 0
      ? rows.every((r) => Number(r.min_dim) === 384 && Number(r.max_dim) === 384)
      : false;
    const allHaveEmbeddings = rows.length > 0
      ? rows.every((r) => Number(r.embedded_rows) === Number(r.total_rows))
      : false;
    out.embeddingCheck = {
      ok: true,
      allDims384,
      allRowsEmbedded: allHaveEmbeddings,
      embeddingColumnsDetected: rows.length,
      rows,
    };
  } catch (e) {
    out.embeddingCheck = { ok: false, error: e.message, rows: [] };
  }

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error('Verification script failed:', err);
  process.exit(1);
});
