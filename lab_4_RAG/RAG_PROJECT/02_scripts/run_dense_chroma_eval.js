import fs from 'fs';
import path from 'path';
import { buildQAuthRAG as buildBM25RAG, crossEncoderRerank } from './rag_process_enhanced.js';
import { buildQAuthRAG as buildEmbRAG } from './rag_process_v2.js';
import { OpenAIEmbeddings } from '@langchain/openai';

function loadEnvFallback() {
  if (process.env.OPENAI_API_KEY) return;
  const fallback = path.resolve(process.cwd(), '..', 'lab_3_Chat_Bot', '.env');
  if (fs.existsSync(fallback)) {
    const content = fs.readFileSync(fallback, 'utf8');
    const m = content.match(/OPENAI_API_KEY\s*=\s*(.+)/);
    if (m) process.env.OPENAI_API_KEY = m[1].trim();
  }
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function main() {
  loadEnvFallback();
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY in env or ../lab_3_Chat_Bot/.env');
    process.exit(1);
  }

  const pdfPath = path.resolve(process.cwd(), '03_data', 'the-modern-guide-to-oauth.pdf');
  console.log('Loading documents and BM25 index...');
  const bm25Rag = await buildBM25RAG({ pdfPath, useStreaming: true, useLLaMA: false, useReranking: false, topK: 50 });
  const docs = bm25Rag.documents;
  const bm25 = bm25Rag.bm25;

  console.log('Creating embeddings object (OpenRouter or OpenAI)...');
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  const model = process.env.OPENROUTER_API_KEY ? 'openai/text-embedding-3-small' : 'text-embedding-3-small';
  const basePath = process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined;
  const embeddings = new OpenAIEmbeddings({ model, apiKey }, basePath ? { basePath } : {});

  console.log('Computing dense embeddings for documents (this may take a moment)...');
  const vectors = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    try {
      const emb = await embeddings.embedQuery(d.pageContent);
      vectors.push(emb);
    } catch (err) {
      console.warn('Embedding error for doc', i, err.message);
      vectors.push(new Array(1536).fill(0));
    }
  }

  const query = 'What is PKCE in OAuth?';
  const qemb = await embeddings.embedQuery(query);

  // Dense semantic ranking
  const semanticScores = vectors.map((v, i) => ({ index: i, score: cosine(qemb, v) }));
  const byDense = semanticScores.sort((a,b) => b.score - a.score).slice(0,50).map(s => ({ index: s.index, score: s.score, heading: docs[s.index].metadata.heading, text: docs[s.index].pageContent }));

  // BM25 ranking
  const byBM25 = bm25.search(query, 50).map(r => ({ index: r.index, bm25Score: r.bm25Score, heading: r.heading, text: r.text }));

  // Merge for reranking
  const combined = new Map();
  for (const r of byBM25) combined.set(r.index, { index: r.index, bm25Score: r.bm25Score, heading: r.heading, text: r.text });
  for (const s of byDense) {
    if (combined.has(s.index)) combined.get(s.index).semanticScore = s.score;
    else combined.set(s.index, { index: s.index, semanticScore: s.score, heading: s.heading, text: s.text, bm25Score: 0 });
  }

  const resultsArr = Array.from(combined.values()).map(r => ({ ...r, semanticScore: r.semanticScore || 0, bm25Score: r.bm25Score || 0 }));
  const reranked = crossEncoderRerank(resultsArr, query, { semantic: 0.6, bm25: 0.4 }).slice(0,50);

  console.log('\nTop 10 Dense semantic:');
  byDense.slice(0,10).forEach((r,i)=> console.log(`${i+1}. [doc ${r.index}] ${r.heading} | semantic=${r.score.toFixed(4)}`));

  console.log('\nTop 10 BM25:');
  byBM25.slice(0,10).forEach((r,i)=> console.log(`${i+1}. [doc ${r.index}] ${r.heading} | bm25=${r.bm25Score.toFixed(3)}`));

  console.log('\nTop 10 Reranked (0.6 semantic / 0.4 bm25):');
  reranked.slice(0,10).forEach((r,i)=> console.log(`${i+1}. [doc ${r.index}] ${r.heading} | reranked=${r.rerankedScore.toFixed(4)} | semantic=${r.semanticScore.toFixed(4)} | bm25=${r.bm25Score.toFixed(3)}`));

  // Simple relevance labels: contains 'pkce' or 'code_challenge' or 'proof key'
  const relevant = new Set();
  docs.forEach((d, idx) => {
    const t = d.pageContent.toLowerCase();
    if (t.includes('pkce') || t.includes('code_challenge') || t.includes('proof key')) relevant.add(idx);
  });
  const relevantTotal = relevant.size;
  console.log(`\nHeuristic relevant documents count: ${relevantTotal}`);

  function evalList(listIdxs, k=10) {
    const retrieved = listIdxs.slice(0,k);
    const hits = retrieved.filter(i => relevant.has(i));
    const recall = relevantTotal === 0 ? 0 : hits.length / relevantTotal;
    let rr = 0;
    for (let i=0;i<retrieved.length;i++) {
      if (relevant.has(retrieved[i])) { rr = 1 / (i+1); break; }
    }
    return { recall, mrr: rr };
  }

  const denseIdxs = byDense.map(r=>r.index);
  const bm25Idxs = byBM25.map(r=>r.index);
  const rerankedIdxs = reranked.map(r=>r.index);

  const k = 10;
  const denseEval = evalList(denseIdxs, k);
  const bm25Eval = evalList(bm25Idxs, k);
  const rerankEval = evalList(rerankedIdxs, k);

  console.log(`\nEvaluation @${k}:`);
  console.log(` Dense Recall@${k}: ${denseEval.recall.toFixed(3)}, MRR: ${denseEval.mrr.toFixed(3)}`);
  console.log(` BM25  Recall@${k}: ${bm25Eval.recall.toFixed(3)}, MRR: ${bm25Eval.mrr.toFixed(3)}`);
  console.log(` Rerank Recall@${k}: ${rerankEval.recall.toFixed(3)}, MRR: ${rerankEval.mrr.toFixed(3)}`);

  // Attempt to ingest into Chroma (best-effort)
  try {
    console.log('\nAttempting to ingest documents into Chroma (collection: oauth-docs) ...');
    const chromaResult = await buildEmbRAG({ pdfPath, useStreaming: true, useChromaDB: true, chromaCollectionName: 'oauth-docs', topK:50 });
    console.log('Chroma ingestion succeeded. You can query CHROMA at', process.env.CHROMA_URL || 'http://localhost:8000');
  } catch (err) {
    console.warn('Chroma ingestion failed:', err.message);
  }

  process.exit(0);
}

main().catch(e=>{ console.error('Error:', e); process.exit(1); });
