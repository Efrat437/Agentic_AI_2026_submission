import 'dotenv/config';
import { runSemanticRAG } from '../agents/semantic_rag_agent.js';

async function main() {
  const out = await runSemanticRAG({
    query: 'nodes relationships attributes schema',
    topK: 2,
    useRerank: false,
    userId: 'semantic-upgrade-test',
  });

  const hasSchemaGrounding = Boolean(out && out.schemaGrounding);
  console.log(`HAS_SCHEMA_GROUNDING=${hasSchemaGrounding}`);
  if (hasSchemaGrounding) {
    console.log(JSON.stringify(out.schemaGrounding, null, 2));
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
