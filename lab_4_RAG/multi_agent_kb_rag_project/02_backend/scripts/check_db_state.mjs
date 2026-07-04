import { createClient } from '../agents/dbTools.js';

const client = createClient();
await client.connect();

try {
  const ext = await client.query("SELECT extname FROM pg_extension WHERE extname='vector'");
  const cols = await client.query(
    "SELECT table_name, column_name, udt_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='rag_documents' ORDER BY ordinal_position"
  );

  const cnt = await client
    .query('SELECT COUNT(*)::int AS count FROM rag_documents')
    .catch(() => ({ rows: [{ count: -1 }] }));

  const emb = await client
    .query('SELECT COUNT(*)::int AS cnt FROM rag_documents WHERE embedding IS NOT NULL')
    .catch(() => ({ rows: [{ cnt: -1 }] }));

  const srcCounts = {};
  for (const table of ['attributes', 'nodes', 'relationships']) {
    const res = await client
      .query(`SELECT COUNT(*)::int AS count FROM ${table}`)
      .catch(() => ({ rows: [{ count: -1 }] }));
    srcCounts[table] = res.rows[0].count;
  }

  console.log(
    JSON.stringify(
      {
        vectorExtension: ext.rows.length > 0,
        ragDocumentsColumns: cols.rows,
        ragDocumentsCount: cnt.rows[0].count,
        embeddedRows: emb.rows[0].cnt,
        sourceTableCounts: srcCounts,
      },
      null,
      2
    )
  );
} finally {
  await client.end();
}
