import { createHash } from 'crypto';
import { pool } from '../../config/db.js';
import { addDocumentsToRag } from '../../agents/semantic_rag_agent.js';
import { fetchUrlContent, chunkText } from '../../ingest/web_scrape_ingest.js';
import { cleanRelevantHtmlToMarkdown } from './html_relevance_cleaner.js';

const DEFAULT_DELETE_SOURCE_BATCH_SIZE = Math.max(25, Number(process.env.LOCAL_GOV_RAG_DELETE_SOURCE_BATCH_SIZE || 250));
const DEFAULT_DELETE_ROW_BATCH_SIZE = Math.max(100, Number(process.env.LOCAL_GOV_RAG_DELETE_ROW_BATCH_SIZE || 1500));
const DEFAULT_FETCH_CONCURRENCY = Math.max(1, Number(process.env.LOCAL_GOV_RAG_FETCH_CONCURRENCY || 4));
const DEFAULT_FETCH_RETRY_ATTEMPTS = Math.max(1, Number(process.env.LOCAL_GOV_RAG_FETCH_RETRY_ATTEMPTS || 3));
const DEFAULT_FETCH_RETRY_DELAY_MS = Math.max(100, Number(process.env.LOCAL_GOV_RAG_FETCH_RETRY_DELAY_MS || 500));
const DEFAULT_MIN_MARKDOWN_CHARS = Math.max(40, Number(process.env.LOCAL_GOV_RAG_MIN_MARKDOWN_CHARS || 80));
const DEFAULT_INSERT_FLUSH_DOCS = Math.max(10, Number(process.env.LOCAL_GOV_RAG_INSERT_FLUSH_DOCS || 60));
const DEFAULT_INSERT_BATCH_SIZE = Math.max(1, Number(process.env.LOCAL_GOV_RAG_INSERT_BATCH_SIZE || 24));
const DEFAULT_INSERT_RETRY_ATTEMPTS = Math.max(1, Number(process.env.LOCAL_GOV_RAG_INSERT_RETRY_ATTEMPTS || 2));
const DEFAULT_INSERT_RETRY_DELAY_MS = Math.max(100, Number(process.env.LOCAL_GOV_RAG_INSERT_RETRY_DELAY_MS || 300));

export const DEFAULT_LOCAL_GOV_URLS = [
  'https://www.ashdod.muni.il/he-il/%d7%90%d7%aa%d7%a8-%d7%94%d7%a2%d7%99%d7%a8/',
];

async function ensureRagMetadataIndex() {
  // Prefer provisioning this via a dedicated migration in production; keep a runtime fallback here.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rag_documents_metadata_gin
    ON rag_documents
    USING gin (metadata);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rag_documents_local_gov_source_lookup
    ON rag_documents ((metadata->>'sourceType'), (metadata->>'source'));
  `);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunkArray(items = [], chunkSize = 1) {
  const size = Math.max(1, Number(chunkSize) || 1);
  const out = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function isTransientFetchError(error) {
  const text = `${error?.name || ''} ${error?.message || error || ''}`.toLowerCase();
  return /abort|timeout|timed out|network|fetch failed|socket|econnreset|econnrefused|enotfound|eai_again|503|502|429/.test(text);
}

async function retryWithBackoff(work, {
  attempts = 3,
  initialDelayMs = 500,
  shouldRetry = () => false,
} = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= Math.max(1, Number(attempts) || 1); attempt += 1) {
    try {
      return { value: await work(attempt), attemptsUsed: attempt };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || shouldRetry(error, attempt) === false) break;
      await sleep(initialDelayMs * (2 ** (attempt - 1)));
    }
  }

  throw lastError;
}

export function validateCleanedMarkdown(cleaned = {}, { minChars = DEFAULT_MIN_MARKDOWN_CHARS } = {}) {
  const markdown = String(cleaned?.markdown || '').trim();
  const plainText = String(cleaned?.plainText || '').trim();
  const candidate = markdown || plainText;
  const normalized = candidate.replace(/\s+/g, ' ').trim();
  const hasLanguageContent = /[\p{L}\p{N}]/u.test(normalized);

  if (!normalized) {
    return { ok: false, reason: 'empty-cleaned-markdown', text: '', textLength: 0 };
  }
  if (!hasLanguageContent) {
    return { ok: false, reason: 'cleaned-markdown-has-no-language-content', text: '', textLength: normalized.length };
  }
  if (normalized.length < Math.max(1, Number(minChars) || DEFAULT_MIN_MARKDOWN_CHARS)) {
    return { ok: false, reason: 'cleaned-markdown-too-short', text: normalized, textLength: normalized.length };
  }

  return {
    ok: true,
    text: candidate,
    textLength: normalized.length,
    usedFallbackPlainText: !markdown && Boolean(plainText),
  };
}

export function deduplicateChunkRecords(chunks = [], { source = '' } = {}) {
  const seen = new Set();
  const uniqueChunks = [];
  let duplicatesRemoved = 0;

  for (const chunk of chunks || []) {
    const pageContent = String(chunk?.pageContent || '').replace(/\s+/g, ' ').trim();
    if (!pageContent) continue;
    const key = createHash('sha1').update(`${source}\n${pageContent}`).digest('hex');
    if (seen.has(key)) {
      duplicatesRemoved += 1;
      continue;
    }
    seen.add(key);
    uniqueChunks.push({
      ...chunk,
      pageContent,
      metadata: {
        ...(chunk?.metadata || {}),
        contentHash: key,
      },
    });
  }

  return {
    chunks: uniqueChunks,
    duplicatesRemoved,
  };
}

export async function mapWithConcurrencyLimit(items = [], concurrency = DEFAULT_FETCH_CONCURRENCY, worker) {
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, Math.max(1, items.length)));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      try {
        results[currentIndex] = { status: 'fulfilled', value: await worker(items[currentIndex], currentIndex) };
      } catch (error) {
        results[currentIndex] = { status: 'rejected', reason: error };
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runner()));
  return results;
}

async function deleteExistingLocalGovDocsBySources(sources = [], {
  sourceBatchSize = DEFAULT_DELETE_SOURCE_BATCH_SIZE,
  rowBatchSize = DEFAULT_DELETE_ROW_BATCH_SIZE,
} = {}) {
  const normalized = Array.from(new Set((sources || []).map((s) => String(s || '').trim()).filter(Boolean)));
  if (normalized.length === 0) return { deleted: 0, sourceBatches: 0, deletePasses: 0 };

  const sourceBatches = chunkArray(normalized, sourceBatchSize);
  let deleted = 0;
  let deletePasses = 0;

  for (const sourceBatch of sourceBatches) {
    while (true) {
      const res = await pool.query(`
        WITH delete_batch AS (
          SELECT ctid
          FROM rag_documents
          WHERE metadata->>'sourceType' = 'local-government-service'
            AND metadata->>'source' = ANY($1::text[])
          LIMIT $2
        )
        DELETE FROM rag_documents rd
        USING delete_batch
        WHERE rd.ctid = delete_batch.ctid
      `, [sourceBatch, Math.max(1, Number(rowBatchSize) || DEFAULT_DELETE_ROW_BATCH_SIZE)]);
      const rowCount = Number(res.rowCount || 0);
      deletePasses += 1;
      deleted += rowCount;
      if (rowCount < rowBatchSize) break;
    }
  }

  return {
    deleted,
    sourceBatches: sourceBatches.length,
    deletePasses,
  };
}

async function fetchAndPrepareLocalGovPage(url, {
  fetchTimeoutMs,
  minRelevanceScore,
  chunkSize,
  chunkOverlap,
  maxChunksPerUrl,
  fetchRetryAttempts,
  fetchRetryDelayMs,
  minMarkdownChars,
} = {}) {
  const startedAt = Date.now();
  const fetchResult = await retryWithBackoff(
    async () => fetchUrlContent(url, Math.max(1000, Number(fetchTimeoutMs) || 20000)),
    {
      attempts: Math.max(1, Number(fetchRetryAttempts) || DEFAULT_FETCH_RETRY_ATTEMPTS),
      initialDelayMs: Math.max(100, Number(fetchRetryDelayMs) || DEFAULT_FETCH_RETRY_DELAY_MS),
      shouldRetry: (error) => isTransientFetchError(error),
    },
  );

  const cleaned = cleanRelevantHtmlToMarkdown(fetchResult.value, {
    minScore: Math.max(0, Number(minRelevanceScore) || 1),
  });
  const validation = validateCleanedMarkdown(cleaned, { minChars: minMarkdownChars });
  if (!validation.ok) {
    throw new Error(`Validated cleaned markdown failed for ${url}: ${validation.reason}`);
  }

  const chunks = chunkText(validation.text, Number(chunkSize) || 900, Number(chunkOverlap) || 120);
  const limited = chunks.slice(0, Math.max(1, Number(maxChunksPerUrl) || 45));
  const deduped = deduplicateChunkRecords(limited, { source: url });

  const docs = deduped.chunks.map((chunk) => ({
    pageContent: chunk.pageContent,
    metadata: {
      ...(chunk.metadata || {}),
      source: url,
      sourceType: 'local-government-service',
      operationGroup: 'making_operations',
      operationName: 'local_government_web_to_rag',
      cleaned: true,
      cleanedMarkdownLength: validation.textLength,
      fetchedAt: new Date().toISOString(),
    },
  }));

  return {
    docs,
    page: {
      url,
      ok: true,
      attempts: fetchResult.attemptsUsed,
      keptItems: cleaned.keptItems,
      droppedItems: cleaned.droppedItems,
      extractedChars: String(cleaned.markdown || '').length,
      validatedChars: validation.textLength,
      usedFallbackPlainText: Boolean(validation.usedFallbackPlainText),
      chunks: docs.length,
      totalExtractedChunks: chunks.length,
      duplicatesRemoved: deduped.duplicatesRemoved,
      durationMs: Date.now() - startedAt,
    },
  };
}

export async function ingestLocalGovernmentWebToRag({
  urls = DEFAULT_LOCAL_GOV_URLS,
  replaceExisting = true,
  chunkSize = 900,
  chunkOverlap = 120,
  maxChunksPerUrl = 45,
  minRelevanceScore = 1,
  fetchTimeoutMs = 20000,
  fetchConcurrency = DEFAULT_FETCH_CONCURRENCY,
  fetchRetryAttempts = DEFAULT_FETCH_RETRY_ATTEMPTS,
  fetchRetryDelayMs = DEFAULT_FETCH_RETRY_DELAY_MS,
  minMarkdownChars = DEFAULT_MIN_MARKDOWN_CHARS,
  insertFlushDocs = DEFAULT_INSERT_FLUSH_DOCS,
  insertBatchSize = DEFAULT_INSERT_BATCH_SIZE,
  insertRetryAttempts = DEFAULT_INSERT_RETRY_ATTEMPTS,
  insertRetryDelayMs = DEFAULT_INSERT_RETRY_DELAY_MS,
  deleteSourceBatchSize = DEFAULT_DELETE_SOURCE_BATCH_SIZE,
  deleteRowBatchSize = DEFAULT_DELETE_ROW_BATCH_SIZE,
} = {}) {
  const startedAt = Date.now();
  const selectedUrls = Array.from(new Set((urls || []).map((u) => String(u || '').trim()).filter(Boolean)));
  if (selectedUrls.length === 0) {
    return { ok: false, error: 'No URLs supplied' };
  }

  await ensureRagMetadataIndex();

  let deletedExisting = 0;
  let deleteSummary = { deleted: 0, sourceBatches: 0, deletePasses: 0 };
  if (replaceExisting) {
    deleteSummary = await deleteExistingLocalGovDocsBySources(selectedUrls, {
      sourceBatchSize: deleteSourceBatchSize,
      rowBatchSize: deleteRowBatchSize,
    });
    deletedExisting = deleteSummary.deleted;
  }

  const pages = [];
  const pendingDocs = [];
  const insertObservability = {
    attemptedDocs: 0,
    inserted: 0,
    failed: 0,
    batches: 0,
    partialFailures: 0,
    failures: [],
  };
  let insertFlushes = 0;
  let insertMutex = Promise.resolve();

  async function flushPendingDocs(force = false) {
    insertMutex = insertMutex.then(async () => {
      if (!force && pendingDocs.length < Math.max(1, Number(insertFlushDocs) || DEFAULT_INSERT_FLUSH_DOCS)) {
        return;
      }
      if (pendingDocs.length === 0) return;

      const docsToInsert = pendingDocs.splice(0, pendingDocs.length);
      insertObservability.attemptedDocs += docsToInsert.length;
      insertFlushes += 1;
      const result = await addDocumentsToRag(docsToInsert, {
        truncate: false,
        batchSize: insertBatchSize,
        retryAttempts: insertRetryAttempts,
        retryDelayMs: insertRetryDelayMs,
      });
      insertObservability.inserted += Number(result?.inserted || 0);
      insertObservability.failed += Number(result?.failedCount || 0);
      insertObservability.batches += Number(result?.batchCount || 0);
      insertObservability.partialFailures += Number(result?.partialFailureCount || 0);
      if (Array.isArray(result?.failedDocuments) && result.failedDocuments.length) {
        insertObservability.failures.push(...result.failedDocuments.slice(0, 20));
      }
    });
    return insertMutex;
  }

  const fetchResults = await mapWithConcurrencyLimit(selectedUrls, fetchConcurrency, async (url) => {
    const prepared = await fetchAndPrepareLocalGovPage(url, {
      fetchTimeoutMs,
      minRelevanceScore,
      chunkSize,
      chunkOverlap,
      maxChunksPerUrl,
      fetchRetryAttempts,
      fetchRetryDelayMs,
      minMarkdownChars,
    });
    pendingDocs.push(...prepared.docs);
    await flushPendingDocs(false);
    return prepared.page;
  });

  for (let index = 0; index < fetchResults.length; index += 1) {
    const url = selectedUrls[index];
    const result = fetchResults[index];
    if (result?.status === 'fulfilled') {
      pages.push(result.value);
      continue;
    }
    const error = result?.reason;
    pages.push({ url, ok: false, error: error?.message || String(error || 'unknown-fetch-error') });
  }

  await flushPendingDocs(true);

  const inserted = insertObservability.inserted;
  const failedPages = pages.filter((page) => page.ok === false).length;

  return {
    ok: inserted > 0 || failedPages < selectedUrls.length,
    sourceType: 'local-government-service',
    urls: selectedUrls,
    replaceExisting,
    deletedExisting,
    inserted,
    pages,
    observability: {
      durationMs: Date.now() - startedAt,
      selectedUrlCount: selectedUrls.length,
      fetchConcurrency: Math.max(1, Number(fetchConcurrency) || DEFAULT_FETCH_CONCURRENCY),
      fetchRetryAttempts: Math.max(1, Number(fetchRetryAttempts) || DEFAULT_FETCH_RETRY_ATTEMPTS),
      insertFlushes,
      delete: deleteSummary,
      insert: insertObservability,
      failures: {
        pageFailures: failedPages,
        insertFailures: insertObservability.failed,
      },
    },
  };
}

export async function getLocalGovernmentRagStats() {
  const statsQ = await pool.query(`
    SELECT
      COUNT(*)::int AS total_docs,
      COUNT(DISTINCT metadata->>'source')::int AS distinct_sources
    FROM rag_documents
    WHERE metadata->>'sourceType' = 'local-government-service'
  `);

  const sourcesQ = await pool.query(`
    SELECT metadata->>'source' AS source, COUNT(*)::int AS chunks
    FROM rag_documents
    WHERE metadata->>'sourceType' = 'local-government-service'
    GROUP BY metadata->>'source'
    ORDER BY chunks DESC, source
    LIMIT 50
  `);

  return {
    totalDocs: Number(statsQ.rows?.[0]?.total_docs || 0),
    distinctSources: Number(statsQ.rows?.[0]?.distinct_sources || 0),
    sources: sourcesQ.rows || [],
  };
}

export async function resetLocalGovernmentRagData() {
  const res = await pool.query(`
    DELETE FROM rag_documents
    WHERE metadata->>'sourceType' = 'local-government-service'
  `);
  return {
    ok: true,
    deleted: Number(res.rowCount || 0),
  };
}
