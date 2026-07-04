import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { supervisor, supervise } from '../agents/supervisor.js';
import { runReactExecutionAgent } from '../agents/reactExecutionAgent.js';
import { reflect } from '../agents/reflectionAgent.js';

function short(s, n = 240) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

async function main() {
  const report = {
    ok: false,
    query: 'How many nodes are there?',
    decision: null,
    planSteps: 0,
    resultItems: 0,
    resultPreview: null,
    reflectionQuality: null,
    error: null,
  };

  try {
    const query = report.query;
    const userId = 'verify-user';

    const decision = await supervisor(query, { userId });
    report.decision = decision;

    let plan = [];
    if (decision.route === 'multi_step') {
      const sup = await supervise({ userQuery: query, context: {}, userId });
      plan = (sup.plan || []).map((step) => ({
        ...step,
        tool:
          step.tool
          || (step.type === 'sql'
            ? 'sql_query'
            : step.type === 'rag'
              ? 'rag_search'
              : step.type === 'web'
                ? 'fetch_public_uri_json'
              : step.type === 'action'
                ? 'sql_action'
                : step.type === 'memory'
                  ? 'store_memory'
                  : undefined),
      })).filter((s) => s.tool === 'sql_query'
        || s.tool === 'rag_search'
        || s.tool === 'fetch_public_uri_json'
        || s.tool === 'fetch_public_uris_json'
        || s.tool === 'new_request_for_goverment'
        || s.tool === 'get_request_status'
        || s.tool === 'update_request_status'
        || s.tool === 'ingest_municipality_web_to_rag'
        || s.tool === 'ingest_sql_corpus_to_rag'
        || s.tool === 'sql_action'
        || s.tool === 'store_memory');
      if (plan.length === 0) plan = [{ tool: 'sql_query' }];
    } else if (decision.route === 'sql_query') {
      plan = [{ tool: 'sql_query' }];
    } else {
      plan = [{ tool: 'rag_search' }];
    }

    const result = await runReactExecutionAgent({ plan, userQuery: query, userId });
    const refl = await reflect(query, JSON.stringify(result), { userId });

    report.planSteps = Array.isArray(plan) ? plan.length : 0;
    report.resultItems = Array.isArray(result) ? result.length : 0;
    report.resultPreview = short(JSON.stringify(result));
    report.reflectionQuality = refl?.quality || null;
    report.ok = true;
  } catch (err) {
    report.error = err?.message || String(err);
  }

  const outPath = path.resolve(process.cwd(), 'scripts', 'e2e_internal_validate_report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(outPath);
}

main().catch((err) => {
  const outPath = path.resolve(process.cwd(), 'scripts', 'e2e_internal_validate_report.json');
  fs.writeFileSync(outPath, JSON.stringify({ ok: false, fatal: err?.message || String(err) }, null, 2), 'utf8');
  process.exit(1);
});
