import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { getEmbeddings } from '../providers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.resolve(PROJECT_ROOT, '04_data');
const OUT_PATH = process.env.SQL_SQL_FILE_EMBEDDING_INDEX_PATH || path.resolve(PROJECT_ROOT, 'tmp', 'sql-file-embedding-index.json');
const BATCH_SIZE = Math.max(1, parseInt(process.env.SQL_FILE_EMBED_BATCH_SIZE || '128', 10));
const MAX_CHUNK_LINES = Math.max(1, parseInt(process.env.SQL_FILE_EMBED_MAX_CHUNK_LINES || '10', 10));
const MAX_CHUNK_CHARS = Math.max(120, parseInt(process.env.SQL_FILE_EMBED_MAX_CHUNK_CHARS || '1200', 10));
const DEFAULT_SQL_FILES = ['attributes.sql', 'nodes.sql', 'relationships.sql'];
const ALLOWED_SQL_FILES = String(process.env.SQL_FILE_EMBED_FILES || DEFAULT_SQL_FILES.join(','))
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

function walkSqlFiles(dirPath) {
  const out = [];
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (/\.sql$/i.test(entry.name) && (ALLOWED_SQL_FILES.includes('*') || ALLOWED_SQL_FILES.includes(entry.name.toLowerCase()))) out.push(abs);
    }
  }
  return out.sort();
}

function extractLineEntries(filePath) {
  const rel = path.relative(PROJECT_ROOT, filePath).replace(/\\/g, '/');
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const entries = [];
  let chunkLines = [];
  let chunkStart = null;

  const flushChunk = () => {
    if (chunkLines.length === 0 || chunkStart == null) return;
    const text = chunkLines.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) {
      chunkLines = [];
      chunkStart = null;
      return;
    }
    const endLine = chunkStart + chunkLines.length - 1;
    entries.push({
      file: rel,
      lineNumber: chunkStart,
      startLine: chunkStart,
      endLine,
      snippet: text.slice(0, 300),
      content: `${rel}:${chunkStart}-${endLine} ${text}`,
    });
    chunkLines = [];
    chunkStart = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = String(lines[i] || '');
    const trimmed = raw.trim();
    if (!trimmed) {
      flushChunk();
      continue;
    }
    if (trimmed.startsWith('--')) continue;

    if (chunkStart == null) chunkStart = i + 1;
    chunkLines.push(trimmed);

    const chunkText = chunkLines.join(' ').replace(/\s+/g, ' ').trim();
    const shouldFlush =
      chunkLines.length >= MAX_CHUNK_LINES ||
      chunkText.length >= MAX_CHUNK_CHARS ||
      /;\s*$/.test(trimmed);

    if (shouldFlush) {
      flushChunk();
    }
  }

  flushChunk();

  return entries;
}

async function buildIndex() {
  if (!fs.existsSync(DATA_DIR)) {
    throw new Error(`04_data directory was not found at ${DATA_DIR}`);
  }

  const sqlFiles = walkSqlFiles(DATA_DIR);
  if (sqlFiles.length === 0) {
    throw new Error(`No .sql files were found under ${DATA_DIR}`);
  }

  const rawEntries = sqlFiles.flatMap((filePath) => extractLineEntries(filePath));
  if (rawEntries.length === 0) {
    throw new Error('No non-empty SQL lines were found to index.');
  }

  // Deduplicate identical lines before embedding to reduce compute and keep output deterministic.
  const uniqueByContent = new Map();
  for (const entry of rawEntries) {
    if (!uniqueByContent.has(entry.content)) {
      uniqueByContent.set(entry.content, []);
    }
    uniqueByContent.get(entry.content).push(entry);
  }

  const uniqueTexts = Array.from(uniqueByContent.keys());
  const vectorByContent = new Map();

  for (let i = 0; i < uniqueTexts.length; i += BATCH_SIZE) {
    const batch = uniqueTexts.slice(i, i + BATCH_SIZE);
    const embeddings = await getEmbeddings(batch);
    if (!Array.isArray(embeddings) || embeddings.length !== batch.length) {
      throw new Error(`Embedding provider returned unexpected batch size for range ${i}-${i + batch.length - 1}`);
    }
    for (let j = 0; j < batch.length; j++) {
      const vector = Array.isArray(embeddings[j]) ? embeddings[j].map((x) => Number(x) || 0) : [];
      vectorByContent.set(batch[j], vector);
    }
  }

  const entries = rawEntries.map((entry) => ({
    ...entry,
    embedding: vectorByContent.get(entry.content) || [],
  }));

  const doc = {
    version: 1,
    mode: 'chunk',
    generatedAt: new Date().toISOString(),
    sourceRoot: path.relative(PROJECT_ROOT, DATA_DIR).replace(/\\/g, '/'),
    totalSqlFiles: sqlFiles.length,
    totalEntries: entries.length,
    embeddingDimension: Array.isArray(entries[0]?.embedding) ? entries[0].embedding.length : 0,
    entries,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(doc, null, 2), 'utf8');

  return {
    ok: true,
    outputPath: OUT_PATH,
    totalSqlFiles: doc.totalSqlFiles,
    totalEntries: doc.totalEntries,
    embeddingDimension: doc.embeddingDimension,
  };
}

buildIndex()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2));
    process.exit(1);
  });
