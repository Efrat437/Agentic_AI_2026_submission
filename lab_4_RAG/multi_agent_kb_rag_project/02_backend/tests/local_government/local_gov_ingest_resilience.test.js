import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addDocumentsWithBatchControl,
  chunkDocumentsForInsert,
} from '../../agents/semantic_rag_agent.js';
import {
  deduplicateChunkRecords,
  mapWithConcurrencyLimit,
  validateCleanedMarkdown,
} from '../../making_operations/local_government/operations.js';

test('validateCleanedMarkdown accepts useful markdown and rejects empty or too-short content', () => {
  const invalid = validateCleanedMarkdown({ markdown: 'tiny' }, { minChars: 10 });
  const fallback = validateCleanedMarkdown({ markdown: '', plainText: 'Useful plain text content for municipal service information.' }, { minChars: 10 });

  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'cleaned-markdown-too-short');
  assert.equal(fallback.ok, true);
  assert.equal(fallback.usedFallbackPlainText, true);
});

test('deduplicateChunkRecords removes repeated chunks after whitespace normalization', () => {
  const result = deduplicateChunkRecords([
    { pageContent: 'Arnona office hours\nMonday to Thursday' },
    { pageContent: 'Arnona office hours   Monday to Thursday' },
    { pageContent: 'Parking permit information' },
  ], { source: 'https://example.invalid/local-gov' });

  assert.equal(result.chunks.length, 2);
  assert.equal(result.duplicatesRemoved, 1);
  assert.ok(result.chunks[0].metadata.contentHash);
});

test('mapWithConcurrencyLimit bounds parallel work while preserving all results', async () => {
  let active = 0;
  let maxActive = 0;

  const results = await mapWithConcurrencyLimit([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return value * 10;
  });

  assert.equal(maxActive <= 2, true);
  assert.deepEqual(results.map((entry) => entry.value), [10, 20, 30, 40, 50]);
});

test('chunkDocumentsForInsert groups documents into bounded batches', () => {
  const docs = Array.from({ length: 5 }, (_, index) => ({ id: index + 1 }));
  const batches = chunkDocumentsForInsert(docs, 2);

  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((batch) => batch.length), [2, 2, 1]);
});

test('addDocumentsWithBatchControl retries and degrades to per-document partial failure handling', async () => {
  const attempts = new Map();
  const docs = [
    { pageContent: 'good', metadata: { source: 'good' } },
    { pageContent: 'bad', metadata: { source: 'bad' } },
    { pageContent: 'flaky', metadata: { source: 'flaky' } },
  ];

  const result = await addDocumentsWithBatchControl(async (batch) => {
    if (batch.length > 1) {
      throw new Error('batch-level failure');
    }
    const source = batch[0]?.metadata?.source;
    const currentAttempts = Number(attempts.get(source) || 0) + 1;
    attempts.set(source, currentAttempts);
    if (source === 'bad') {
      throw new Error('permanent failure');
    }
    if (source === 'flaky' && currentAttempts === 1) {
      throw new Error('temporary network failure');
    }
  }, docs, {
    batchSize: 3,
    retryAttempts: 2,
    retryDelayMs: 1,
  });

  assert.equal(result.inserted, 2);
  assert.equal(result.failedCount, 1);
  assert.equal(result.partialFailureCount, 1);
  assert.equal(result.failedDocuments[0].source, 'bad');
});