import 'dotenv/config';
import { createClient } from '../agents/dbTools.js';
import { runSemanticRAG } from '../agents/semantic_rag_agent.js';
import { buildHeuristicSqlFromSchema } from '../agents/sql_rag_agent.js';
import { getSchemaGraph } from '../agents/schemaGraph.js';

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

async function main() {
  const client = createClient();
  await client.connect();

  let schema;
  try {
    schema = await getSchemaGraph({ db: client, useCache: false });
  } finally {
    await client.end();
  }

  if (!schema || !Array.isArray(schema.columns) || !Array.isArray(schema.foreignKeys)) {
    fail('Schema graph unavailable');
  }

  const semantic = await runSemanticRAG({
    query: 'show relationships between nodes and attributes',
    userId: 'schema-graph-verify',
    schemaOnly: true,
  });

  const hasSchemaGrounding = Boolean(
    semantic
    && semantic.schemaGrounding
    && Array.isArray(semantic.schemaGrounding.tables)
    && semantic.schemaGrounding.tables.length > 0
  );

  const fallbackSql = buildHeuristicSqlFromSchema(
    'how many joins exist between attributes and nodes?',
    schema.columns,
    schema.foreignKeys
  );

  const usesJoin = /\bjoin\b/i.test(fallbackSql);
  const referencesRequestedTables = /\battributes\b/i.test(fallbackSql) && /\bnodes\b/i.test(fallbackSql);
  const fkAwareFallbackOk = usesJoin && referencesRequestedTables;

  const report = {
    ok: hasSchemaGrounding && fkAwareFallbackOk,
    semantic: {
      hasSchemaGrounding,
      mode: semantic?.mode || null,
      tables: semantic?.schemaGrounding?.tables || [],
    },
    sqlFallback: {
      fkAwareFallbackOk,
      usesJoin,
      referencesRequestedTables,
      sql: fallbackSql,
    },
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((err) => {
  fail(err?.message || String(err));
});
