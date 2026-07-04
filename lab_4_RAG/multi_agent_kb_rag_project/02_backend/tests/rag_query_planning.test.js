import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAnchorFilteringToCandidates,
  buildRecursiveSemanticQueries,
  buildSemanticRetrievalPlan,
  localCrossEncoderRerank,
  rankSqlFileEmbeddingEntries,
} from '../agents/semantic_rag_agent.js';
import { normalizeSqlRecursiveDepth } from '../agents/sql_rag_agent.js';

test('buildRecursiveSemanticQueries enforces a bounded fallback budget', () => {
  const queries = buildRecursiveSemanticQueries('housing affordability', {
    recursiveEnabled: true,
    maxDepth: 5,
    maxQueries: 4,
    maxExpansions: 2,
    semanticEntityHints: { cityNames: ['Tel Aviv', 'Haifa', 'Jerusalem'] },
  });

  assert.equal(queries.length <= 4, true);
  assert.equal(queries[0], 'housing affordability');
});

test('buildSemanticRetrievalPlan separates rewrite, anchors, and recursion', () => {
  const plan = buildSemanticRetrievalPlan({
    query: 'Explain housing demand',
    anchors: ['tel aviv', 'rent'],
    useGraph: true,
    sqlRewriterEnabled: true,
    recursiveEnabled: true,
    recursiveMaxDepth: 2,
    schemaGrounding: {
      foreignKeys: [
        { fromTable: 'attributes', fromColumn: 'node_id', toTable: 'nodes', toColumn: 'node_id' },
      ],
    },
  });

  assert.equal(plan.initialQueries.length, 1);
  assert.equal(plan.fallbackQueries.length <= 3, true);
  assert.equal(plan.rewrittenQuery.includes('anchors:'), false);
  assert.deepEqual(plan.anchorFilters, ['tel aviv', 'rent']);
});

test('applyAnchorFilteringToCandidates prefers anchor-matching evidence', () => {
  const ranked = applyAnchorFilteringToCandidates([
    { id: '1', name: 'Housing in Tel Aviv', description: 'rent pressure is rising', combinedScore: 0.4 },
    { id: '2', name: 'National employment overview', description: 'countrywide trend', combinedScore: 0.9 },
  ], ['tel aviv', 'rent']);

  assert.equal(ranked[0].id, '1');
});

test('localCrossEncoderRerank uses lexical overlap in addition to base scores', () => {
  const ranked = localCrossEncoderRerank([
    { id: 'weak', name: 'mobility dashboard', description: 'bus and traffic', semanticScore: 0.9, bm25Score: 0.4 },
    { id: 'strong', name: 'Tel Aviv rent', description: 'rent trends in tel aviv neighborhoods', semanticScore: 0.4, bm25Score: 0.2 },
  ], 'rent in tel aviv');

  assert.equal(ranked[0].id, 'strong');
});

test('rankSqlFileEmbeddingEntries scores offline index entries without scanning sql files', () => {
  const ranked = rankSqlFileEmbeddingEntries([1, 0, 0], [
    { file: 'a.sql', embedding: [1, 0, 0], snippet: 'perfect match' },
    { file: 'b.sql', embedding: [0, 1, 0], snippet: 'different vector' },
  ], 2);

  assert.equal(ranked[0].file, 'a.sql');
  assert.equal(ranked.length, 2);
});

test('normalizeSqlRecursiveDepth clamps overly deep recursion', () => {
  assert.equal(normalizeSqlRecursiveDepth(7), 2);
  assert.equal(normalizeSqlRecursiveDepth(-1), 0);
});