import fs from 'fs';
import path from 'path';
import { isDirectStructuredLookupQuery } from '../agents/sql_rag_agent.js';

const PROJECT_ROOT = process.cwd();
const DEFAULT_DATASET_PATH = path.resolve(PROJECT_ROOT, '02_backend', 'eval', 'langgraph_eval_dataset.json');
const DEFAULT_BASE_URL = process.env.ASK_VERIFY_BASE_URL || 'http://127.0.0.1:3100';

function parseArgs(argv = []) {
  const out = {
    baseUrl: DEFAULT_BASE_URL,
    datasetPath: DEFAULT_DATASET_PATH,
    parserOnly: false,
    limit: 10,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    const next = i + 1 < argv.length ? String(argv[i + 1] || '').trim() : '';

    if (token === '--base-url' && next) {
      out.baseUrl = next;
      i += 1;
      continue;
    }
    if (token === '--dataset' && next) {
      out.datasetPath = path.resolve(PROJECT_ROOT, next);
      i += 1;
      continue;
    }
    if (token === '--limit' && next) {
      out.limit = Math.max(1, Number(next) || out.limit);
      i += 1;
      continue;
    }
    if (token === '--parser-only') {
      out.parserOnly = true;
      continue;
    }
  }

  return out;
}

function getTargetCases(dataset = [], limit = 10) {
  const explicitCases = [
    {
      id: 'direct-parent-phrase',
      query: 'Which parent does statistical_5000_221 belong to?',
      expectedRoutes: ['sql_query_fastpath', 'sql_query', 'multi_step'],
    },
    {
      id: 'district-phrase',
      query: 'Which district does statistical_5000_221 belong to?',
      expectedRoutes: ['sql_query_fastpath', 'sql_query', 'multi_step'],
    },
    {
      id: 'district-with-attribute',
      query: "Which district does statistical_5000_221 belong to, and what is that district's rent_pcnt?",
      expectedRoutes: ['sql_query_fastpath', 'sql_query', 'multi_step'],
    },
  ];

  const datasetDistrictCases = (Array.isArray(dataset) ? dataset : [])
    .filter((row) => {
      const query = String(row?.query || '');
      return /which\s+district\s+does\s+((?:e|statistical)_[a-z0-9_]+)\s+belong\s+to/i.test(query);
    })
    .slice(0, Math.max(0, limit - explicitCases.length))
    .map((row) => ({
      id: String(row.id || 'dataset-case'),
      query: String(row.query || ''),
      expectedRoutes: ['sql_query_fastpath', 'sql_query', 'multi_step'],
    }));

  return [...explicitCases, ...datasetDistrictCases].slice(0, limit);
}

async function callAsk(baseUrl, query) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      userId: 'verify-ask-route-alignment',
      context: {
        useRerank: false,
      },
    }),
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  return {
    status: response.status,
    ok: response.ok,
    route: parsed?.decision?.route || null,
    textPreview: text.slice(0, 240),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.datasetPath)) {
    throw new Error(`Dataset file not found: ${args.datasetPath}`);
  }

  const dataset = JSON.parse(fs.readFileSync(args.datasetPath, 'utf8'));
  const cases = getTargetCases(dataset, args.limit);

  const results = [];
  let failures = 0;

  for (const testCase of cases) {
    const parserMatch = isDirectStructuredLookupQuery(testCase.query);
    const row = {
      id: testCase.id,
      query: testCase.query,
      parserMatch,
      parserOk: parserMatch === true,
      askRoute: null,
      askOk: null,
      status: null,
      note: null,
    };

    if (!row.parserOk) {
      failures += 1;
      row.note = 'Parser did not classify as direct structured lookup.';
      results.push(row);
      continue;
    }

    if (!args.parserOnly) {
      try {
        const ask = await callAsk(args.baseUrl, testCase.query);
        row.status = ask.status;
        row.askRoute = ask.route;
        row.askOk = ask.ok && testCase.expectedRoutes.includes(String(ask.route || ''));
        if (!row.askOk) {
          failures += 1;
          row.note = ask.ok
            ? `Unexpected /ask route: ${String(ask.route || 'null')}`
            : `HTTP ${ask.status}: ${ask.textPreview}`;
        }
      } catch (error) {
        failures += 1;
        row.askOk = false;
        row.note = `Ask request failed: ${String(error?.message || error)}`;
      }
    }

    results.push(row);
  }

  const summary = {
    parserOnly: args.parserOnly,
    baseUrl: args.baseUrl,
    total: results.length,
    failures,
    passed: Math.max(0, results.length - failures),
    results,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (failures > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
