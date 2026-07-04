import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchUrlContent, extractTextFromHtmlString, chunkText, fetchApiAndExtractText } from './web_scrape_ingest.js';
import { extractTextFromPdfFile, extractTextFromPdfBuffer } from './pdf_ingest.js';
import { ingestSqlTablesToRag } from '../agents/dbTools.js';
import { addDocumentsToRag } from '../agents/semantic_rag_agent.js';

const JOBS = new Map();
let nextJobId = 1;

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

function resolveInputPath(inputPath = '') {
  const normalized = String(inputPath || '').trim();
  if (!normalized) return '';
  if (path.isAbsolute(normalized)) return normalized;

  const candidates = [
    path.resolve(process.cwd(), normalized),
    path.resolve(PROJECT_ROOT, normalized),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function buildRagDocsFromChunks(chunks = [], source = '') {
  return chunks.map((chunk, idx) => ({
    pageContent: chunk.pageContent || '',
    metadata: {
      source,
      chunkIndex: idx,
      ...(chunk.metadata || {}),
    },
  }));
}

async function ingestTextToRag(text, source, { truncate = false } = {}) {
  const chunks = chunkText(String(text || ''));
  if (chunks.length === 0) return { inserted: 0 };
  return addDocumentsToRag(buildRagDocsFromChunks(chunks, source), { truncate });
}

// start an ingestion job. options: { source: 'local'|'url'|'scrape'|'api'|'sql-tables', path: '<relative or url>', truncate: false }
export async function startIngestJob(options) {
  const id = String(nextJobId++);
  JOBS.set(id, { id, status: 'queued', progress: 0, startedAt: Date.now(), message: null });

  (async () => {
    try {
      JOBS.get(id).status = 'running';
      const localDir = path.join(PROJECT_ROOT, '04_data');

      if (options.source === 'local') {
        // path may be a directory or filename
        let files = [];
        const p = options.path ? resolveInputPath(options.path) : localDir;
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
          const allFiles = fs.readdirSync(p).map(f => path.join(p, f));
          files = allFiles.filter((f) => {
            const lower = f.toLowerCase();
            return lower.endsWith('.pdf')
              || lower.endsWith('.html')
              || lower.endsWith('.txt')
              || lower.endsWith('.md')
              || lower.endsWith('.json');
          });
        } else if (fs.existsSync(p)) {
          files = [p];
        } else {
          throw new Error('Local path not found: ' + p);
        }

        const total = files.length;
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          JOBS.get(id).message = `Processing ${file}`;
          if (file.toLowerCase().endsWith('.html')) {
            const { extractTextFromHtmlFile, chunkHtmlContent } = await import('./html_ingest.js');
            const { text } = extractTextFromHtmlFile(file);
            const chunks = chunkHtmlContent(text);
            // Insert parsed HTML chunks into centralized RAG store.
            try {
              const res = await addDocumentsToRag(buildRagDocsFromChunks(chunks, file), { truncate: Boolean(options.truncate) && i === 0 });
              JOBS.get(id).message = `Inserted ${res.inserted} chunks for ${file}`;
            } catch (e) {
              JOBS.get(id).message = `Error inserting chunks for ${file}: ${e.message}`;
            }
            JOBS.get(id).progress = Math.round(((i + 1) / total) * 100);
            continue;
          }

          if (file.toLowerCase().endsWith('.pdf')) {
            try {
              const text = await extractTextFromPdfFile(file);
              const res = await ingestTextToRag(text, file, { truncate: Boolean(options.truncate) && i === 0 });
              JOBS.get(id).message = `Inserted ${res.inserted} chunks for ${file}`;
            } catch (e) {
              JOBS.get(id).message = `Error ingesting PDF ${file}: ${e.message}`;
            }
            JOBS.get(id).progress = Math.round(((i + 1) / total) * 100);
            continue;
          }

          if (file.toLowerCase().endsWith('.txt') || file.toLowerCase().endsWith('.md') || file.toLowerCase().endsWith('.json')) {
            try {
              const text = fs.readFileSync(file, 'utf8');
              const res = await ingestTextToRag(text, file, { truncate: Boolean(options.truncate) && i === 0 });
              JOBS.get(id).message = `Inserted ${res.inserted} chunks for ${file}`;
            } catch (e) {
              JOBS.get(id).message = `Error ingesting ${file}: ${e.message}`;
            }
            JOBS.get(id).progress = Math.round(((i + 1) / total) * 100);
            continue;
          }

          JOBS.get(id).message = `Processing ${file}`;
          try {
            const text = fs.readFileSync(file, 'utf8');
            const res = await ingestTextToRag(text, file, { truncate: Boolean(options.truncate) && i === 0 });
            JOBS.get(id).message = `Inserted ${res.inserted} chunks for ${file}`;
          } catch (e) {
            JOBS.get(id).message = `Error ingesting ${file}: ${e.message}`;
          }
          JOBS.get(id).progress = Math.round(((i + 1) / total) * 100);
        }
      } else if (options.source === 'url') {
        // single url
        JOBS.get(id).message = `Processing URL ${options.path}`;
        if (String(options.path || '').toLowerCase().endsWith('.pdf')) {
          const response = await fetch(options.path, { headers: { 'User-Agent': 'AgenticRAG/1.0' } });
          if (!response.ok) throw new Error(`Fetch failed ${response.status} ${response.statusText}`);
          const ab = await response.arrayBuffer();
          const text = await extractTextFromPdfBuffer(Buffer.from(ab));
          await ingestTextToRag(text, options.path, { truncate: options.truncate });
        } else {
          const html = await fetchUrlContent(options.path);
          const { text } = extractTextFromHtmlString(html);
          await ingestTextToRag(text, options.path, { truncate: options.truncate });
        }
        JOBS.get(id).progress = 100;

      } else if (options.source === 'scrape') {
        JOBS.get(id).message = `Scraping ${options.path}`;
        const html = await fetchUrlContent(options.path);
        const { text } = extractTextFromHtmlString(html);
        const res = await ingestTextToRag(text, options.path, { truncate: options.truncate });
        JOBS.get(id).progress = 100;
        JOBS.get(id).message = `Inserted ${res.inserted} chunks from scrape`;

      } else if (options.source === 'api') {
        JOBS.get(id).message = `Fetching API ${options.path}`;
        const text = await fetchApiAndExtractText(options.path);
        const res = await ingestTextToRag(text, options.path, { truncate: options.truncate });
        JOBS.get(id).progress = 100;
        JOBS.get(id).message = `Inserted ${res.inserted} chunks from api`;

      } else if (options.source === 'sql-tables') {
        JOBS.get(id).message = `Ingesting SQL tables to RAG: ${options.tables || '[attributes,nodes,relationships]'}`;
        const res = await ingestSqlTablesToRag({ tables: options.tables || ['attributes','nodes','relationships'], truncate: options.truncate });
        JOBS.get(id).progress = 100;
        JOBS.get(id).message = `Inserted ${res.inserted} documents from SQL tables`;

      } else {
        throw new Error('Unsupported source');
      }

      JOBS.get(id).status = 'done';
      JOBS.get(id).completedAt = Date.now();
      JOBS.get(id).message = 'Completed';
    } catch (err) {
      const job = JOBS.get(id);
      if (job) {
        job.status = 'error';
        job.message = err.message;
      }
    }
  })();

  return id;
}

export function getJobStatus(id) {
  return JOBS.get(id) || null;
}

export function listJobs() {
  return Array.from(JOBS.values()).sort((a,b)=>a.id-b.id);
}
