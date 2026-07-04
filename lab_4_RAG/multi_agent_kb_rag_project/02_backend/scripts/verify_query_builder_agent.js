import 'dotenv/config';
import { runQueryBuilderAgent } from '../agents/query_builder_agent.js';

async function main() {
  const baseQuery = 'which statistical areas are similar in rent aspect to statistical_5000_111?';

  const plannedOnly = await runQueryBuilderAgent({
    query: baseQuery,
    userId: 'query-builder-verify',
    mode: 'auto',
    execute: false,
    maxCycles: 4,
  });

  const sqlOnly = await runQueryBuilderAgent({
    query: baseQuery,
    userId: 'query-builder-verify',
    mode: 'sql-rag-exclusive',
    execute: true,
    maxCycles: 3,
  });

  const semanticOnly = await runQueryBuilderAgent({
    query: 'explain semantically which areas are similar to statistical_5000_111',
    userId: 'query-builder-verify',
    mode: 'semantic-rag-exclusive',
    execute: false,
    maxCycles: 3,
  });

  const multiAnchor = await runQueryBuilderAgent({
    query: 'What is the population and median age of Tel Aviv?',
    userId: 'query-builder-verify',
    mode: 'auto',
    execute: false,
    maxCycles: 3,
  });

  console.log(JSON.stringify({ plannedOnly, sqlOnly, semanticOnly, multiAnchor }, null, 2));
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
