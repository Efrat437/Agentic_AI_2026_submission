import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env", import.meta.url).pathname });

import fs from "fs";
import fetch from "node-fetch";
import FormData from "form-data";

import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";
import { BM25Retriever } from "@langchain/community/retrievers/bm25";
import { Document } from "@langchain/core/documents";
import { pipeline } from "@xenova/transformers";

// ============================================================
// LOCAL EMBEDDINGS
// ============================================================

class LocalEmbeddings {
  constructor() {
    this.extractor = null;
    this.dimensions = 384;
    this.timeoutMs = parseInt(process.env.EMBED_TIMEOUT_MS || "20000", 10);
  }

  async init() {
    if (!this.extractor) {
      console.log("[Embeddings] Loading Xenova/all-MiniLM-L6-v2...");
      this.extractor = await pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2"
      );
      console.log("[Embeddings] Model ready");
    }
  }

  async embedDocuments(texts) {
    await this.init();
    const vectors = [];
    const total = texts.length;

    for (let i = 0; i < total; i++) {
      if ((i + 1) % 10 === 0 || i === 0 || i === total - 1) {
        console.log(`[Embeddings] Progress ${i + 1}/${total}`);
      }

      const safeText = String(texts[i] || "").slice(0, 4000);

      try {
        const output = await Promise.race([
          this.extractor(safeText, {
            pooling: "mean",
            normalize: true,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Embedding timeout after ${this.timeoutMs}ms`)), this.timeoutMs)
          ),
        ]);

        vectors.push(Array.from(output.data));
      } catch (err) {
        console.warn(
          `[Embeddings] Failed chunk ${i + 1}/${total}: ${err.message || err}. Using zero vector fallback.`
        );
        vectors.push(new Array(this.dimensions).fill(0));
      }
    }

    return vectors;
  }

  async embedQuery(text) {
    await this.init();
    const safeText = String(text || "").slice(0, 4000);

    const output = await Promise.race([
      this.extractor(safeText, {
        pooling: "mean",
        normalize: true,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Query embedding timeout after ${this.timeoutMs}ms`)), this.timeoutMs)
      ),
    ]);

    return Array.from(output.data);
  }
}

const embeddings = new LocalEmbeddings();
const USE_LLAMA = process.env.USE_LLAMA === "true";

// Common stopwords to skip when looking for distinctive query terms
const STOPWORDS = new Set([
  "a","an","the","is","are","was","were","be","been","being",
  "how","what","why","when","where","which","who","does","do",
  "and","or","for","to","in","of","on","at","by","with","from",
  "it","its","this","that","these","those","i","we","you","he","she","they",
  "oauth","work","used","using","important","prevent","explain","use",
]);

/**
 * Extract distinctive (non-stopword) tokens from a query for title matching.
 */
function extractQueryTerms(query) {
  return query.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Title-match bonus: return 1 if any query term appears in the chunk's heading
 * or first sentence, 0 otherwise. Rewards chapter-header chunks.
 */
function titleMatchBonus(doc, queryTerms) {
  const heading = String(doc?.metadata?.heading || "").toLowerCase();
  const firstLine = String(doc?.pageContent || "").slice(0, 120).toLowerCase();
  return queryTerms.some(t => heading.includes(t) || firstLine.includes(t)) ? 1 : 0;
}

const TITLE_BONUS_WEIGHT = parseFloat(process.env.TITLE_BONUS_WEIGHT || "0.25");
const TOP_K = parseInt(process.env.TOP_K || "8");
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || "1000");
const CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP || "120");
const SEMANTIC_WEIGHT = parseFloat(process.env.SEMANTIC_WEIGHT || "0.7");
const BM25_WEIGHT = parseFloat(process.env.BM25_WEIGHT || "0.3");

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);

  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ============================================================
// STREAM PDF (STANDARD TEXT PDFs)
// ============================================================

async function* streamPDF(pdfPath) {
  const dataBuffer = fs.readFileSync(pdfPath);
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(dataBuffer),
  });
  const pdfDoc = await loadingTask.promise;

  console.log(`[PDF] Total pages: ${pdfDoc.numPages}`);

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const items = textContent.items;

    if (!items || items.length === 0) continue;

    const text = items.map((i) => i.str).join(" ").trim();

    if (text.length > 30) {
      yield new Document({
        pageContent: text,
        metadata: {
          heading: `Page ${pageNum}`,
          page: pageNum,
          source: pdfPath,
          type: "pdf",
        },
      });
    }
  }

  console.log("[PDF] Extraction complete");
}

// ============================================================
// STREAM LLAMA PARSE (SMART MODE)
// ============================================================

async function* streamLlama(pdfPath) {
  console.log("[LLaMA] Parsing via LlamaIndex API...");

  let response;

  // If this is a public URL → use file_url
  if (pdfPath.startsWith("http")) {
    response = await fetch("https://api.llamaindex.ai/api/parsing", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.LLAMA_PARSE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        file_url: pdfPath,
        parsing_instruction:
          "Extract all text. Preserve tables in markdown. Perform OCR and/or tesseract on images and tables. Extract semantic content from images and tables in pdf files, also extract the text."
      }),
    });
  } else {
    // for local files → upload
    const form = new FormData();
    form.append("file", fs.createReadStream(pdfPath));
    form.append(
      "parsing_instruction",
      "Extract all text. Preserve tables in markdown. Perform OCR and/or tesseract on images and tables. Extract semantic content from images and tables in pdf files, also extract the text."
    );

    response = await fetch(
      "https://api.llamaindex.ai/api/parsing/upload",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.LLAMA_PARSE_API_KEY}`,
          ...form.getHeaders(),
        },
        body: form,
      }
    );
  }

  if (!response.ok) {
    throw new Error(`LLaMA Parse failed: ${response.statusText}`);
  }

  const data = await response.json();

  for (const doc of data.documents || []) {
    yield new Document({
      pageContent: doc.text,
      metadata: {
        heading: doc.heading || `Page ${doc.page}`,
        page: doc.page,
        type: "llama",
        hasTables: doc.tables?.length > 0,
        hasImages: doc.images?.length > 0,
        source: "llama_parse",
      },
    });
  }

  console.log("[LLaMA] Parsing complete");
}

// ============================================================
// BUILD RAG
// ============================================================

export async function buildStreamingRAG(pdfPath) {
  const skipSemanticHandoffEarly = String(process.env.SKIP_SEMANTIC_HANDOFF || "false").toLowerCase() === "true";

  let pool = null;

  if (!skipSemanticHandoffEarly) {
    const pg = await import("pg");
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
    });

    // create extension, ensure table exists, then truncate to clear rows
    try {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS rag_documents (
          id bigserial PRIMARY KEY,
          content text,
          metadata jsonb,
          embedding vector(384)
        );
      `);

      // clear previous rows but keep indexes/constraints
      await pool.query(`TRUNCATE TABLE rag_documents RESTART IDENTITY;`);

      console.log("[DB] Table ready");
    } catch (err) {
      console.error("[DB] Error setting up table:", err);
      await pool.end();
      throw err;
    }
  }

  // remove early vectorStore initialization; we'll initialize after ingestion via the semantic agent

  // const vectorStore = await PGVectorStore.initialize(embeddings, {
  //   pool,
  //   tableName: "rag_documents",
  //   columns: {
  //     contentColumnName: "content",
  //     metadataColumnName: "metadata",
  //     vectorColumnName: "embedding",
  //     idColumnName: "id",
  //   },
  // });

  const splitter =
    USE_LLAMA === true
      ? new RecursiveCharacterTextSplitter({
          chunkSize: CHUNK_SIZE,
          chunkOverlap: CHUNK_OVERLAP,
          separators: ["\n\n", "\n", " ", ""],
        })
      : new RecursiveCharacterTextSplitter({
          chunkSize: CHUNK_SIZE,
          chunkOverlap: CHUNK_OVERLAP,
        });

  const documents = USE_LLAMA
    ? streamLlama(pdfPath)
    : streamPDF(pdfPath);

  const allDocs = [];
  let chunkCounter = 0;

  for await (const page of documents) {
    const chunks = await splitter.splitDocuments([page]);

    for (const chunk of chunks) {
      chunk.metadata = {
        ...page.metadata,
        chunkIndex: chunkCounter++,
        length: chunk.pageContent.length,
      };

      // collect chunks; do not insert directly here. We'll batch-insert via the semantic agent.
      allDocs.push(chunk);
    }
  }

  console.log(`[Ingestion] ${chunkCounter} chunks collected`);

  const skipSemanticHandoff = String(process.env.SKIP_SEMANTIC_HANDOFF || "false").toLowerCase() === "true";

  if (skipSemanticHandoff) {
    console.log("[Ingestion] Local hybrid verification mode: semantic in-memory + BM25 (no DB insert)");

    const docVectors = await embeddings.embedDocuments(allDocs.map((d) => d.pageContent));
    const bm25Retriever = BM25Retriever.fromDocuments(allDocs);
    bm25Retriever.k = TOP_K;

    // Semantic retriever returns scored pairs so fusion can use real cosine values
    const localSemanticRetriever = {
      async invokeScored(query) {
        const queryVec = await embeddings.embedQuery(query);
        const scored = allDocs.map((doc, idx) => ({
          doc,
          score: cosineSimilarity(queryVec, docVectors[idx]),
        }));
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, TOP_K * 2); // fetch wider candidate pool for fusion
      },
    };

    const ensembleRetriever = {
      async invoke(query) {
        const [semanticScored, keyword] = await Promise.all([
          localSemanticRetriever.invokeScored(query),
          bm25Retriever.invoke(query),
        ]);

        // Min-max normalize cosine scores so they're in [0,1]
        const cosineMax = semanticScored.length ? semanticScored[0].score : 1;
        const cosineMin = semanticScored.length ? semanticScored[semanticScored.length - 1].score : 0;
        const cosineRange = cosineMax - cosineMin || 1;

        const queryTerms = extractQueryTerms(query);
        const ranked = new Map();

        semanticScored.forEach(({ doc, score }) => {
          const key = `${doc?.metadata?.page ?? "p"}:${doc?.metadata?.chunkIndex ?? "c"}`;
          const base = ranked.get(key) || { doc, score: 0 };
          base.score += SEMANTIC_WEIGHT * ((score - cosineMin) / cosineRange);
          base.score += TITLE_BONUS_WEIGHT * titleMatchBonus(doc, queryTerms);
          ranked.set(key, base);
        });

        keyword.forEach((doc, idx) => {
          const key = `${doc?.metadata?.page ?? "p"}:${doc?.metadata?.chunkIndex ?? "c"}`;
          const base = ranked.get(key) || { doc, score: 0 };
          base.score += BM25_WEIGHT * (1 / (idx + 1));
          base.score += TITLE_BONUS_WEIGHT * titleMatchBonus(doc, queryTerms);
          ranked.set(key, base);
        });

        return [...ranked.values()]
          .sort((a, b) => b.score - a.score)
          .slice(0, TOP_K)
          .map((x) => x.doc);
      },
    };

    return { retriever: ensembleRetriever, vectorStore: null, allDocs };
  } else {
    // Hand off collected chunks to the project's semantic agent ingestion helper
    try {
      const agentPath = '../../multi_agent_kb_rag_project/02_backend/agents/semantic_rag_agent.js';
      const { addDocumentsToRag } = await import(agentPath);
      const plain = allDocs.map(d => ({ content: d.pageContent, metadata: d.metadata }));
      const res = await addDocumentsToRag(plain, { truncate: true });
      console.log(`[Ingestion] addDocumentsToRag inserted ${res.inserted} docs via semantic agent`);
    } catch (e) {
      console.warn('[Ingestion] Failed to hand off to semantic agent:', e.message || e);
    }
  }

  // initialize vectorStore for retrieval against the table now populated by semantic agent
  const vectorStore = await PGVectorStore.initialize(embeddings, {
    pool,
    tableName: "rag_documents",
    columns: {
      contentColumnName: "content",
      metadataColumnName: "metadata",
      vectorColumnName: "embedding",
      idColumnName: "id",
    },
  });

  const semanticRetriever = vectorStore.asRetriever({ k: TOP_K });
  const bm25Retriever = BM25Retriever.fromDocuments(allDocs);
  bm25Retriever.k = TOP_K;

  const ensembleRetriever = {
    async invoke(query) {
      const semantic = await semanticRetriever.invoke(query);
      const keyword = await bm25Retriever.invoke(query);

      const ranked = new Map();

      semantic.forEach((doc, idx) => {
        const key = `${doc?.metadata?.page ?? "p"}:${doc?.metadata?.chunkIndex ?? "c"}`;
        const base = ranked.get(key) || { doc, score: 0 };
        base.score += SEMANTIC_WEIGHT * (1 / (idx + 1));
        ranked.set(key, base);
      });

      keyword.forEach((doc, idx) => {
        const key = `${doc?.metadata?.page ?? "p"}:${doc?.metadata?.chunkIndex ?? "c"}`;
        const base = ranked.get(key) || { doc, score: 0 };
        base.score += BM25_WEIGHT * (1 / (idx + 1));
        ranked.set(key, base);
      });

      return [...ranked.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, TOP_K)
        .map((x) => x.doc);
    },
  };

  return { retriever: ensembleRetriever, vectorStore, allDocs };
}

// ============================================================
// QUERY
// ============================================================

export async function queryRAG(ragData, query) {
  return await ragData.retriever.invoke(query);
}

// add helper to insert arbitrary Document objects (plain objects with pageContent and metadata)
export async function addDocumentsToRag(docs, { truncate = false } = {}) {
  const pg = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // ensure extension and table
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rag_documents (
        id bigserial PRIMARY KEY,
        content text,
        metadata jsonb,
        embedding vector(384)
      );
    `);

    if (truncate) {
      await pool.query(`TRUNCATE TABLE rag_documents RESTART IDENTITY;`);
    }

    const { PGVectorStore } = await import('@langchain/community/vectorstores/pgvector');
    const { Document } = await import('@langchain/core/documents');

    const vectorStore = await PGVectorStore.initialize(embeddings, {
      pool,
      tableName: 'rag_documents',
      columns: {
        contentColumnName: 'content',
        metadataColumnName: 'metadata',
        vectorColumnName: 'embedding',
        idColumnName: 'id',
      },
    });

    // convert plain docs to Document instances if needed
    const toAdd = docs.map(d => new Document({ pageContent: d.pageContent, metadata: d.metadata || {} }));

    await vectorStore.addDocuments(toAdd);

    await pool.end();
    return { inserted: toAdd.length };
  } catch (err) {
    try { await pool.end(); } catch(e){}
    throw err;
  }
}