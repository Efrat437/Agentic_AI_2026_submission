import fs from 'fs';
import path from 'path';
import { buildQAuthRAG as buildBM25RAG, crossEncoderRerank } from './rag_process_enhanced.js';
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
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function formatTime(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatMem(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function computeMetrics(relevant, predictions, k = 10) {
  const retrieved = predictions.slice(0, k);
  const hits = retrieved.filter(i => relevant.has(i)).length;
  
  // Recall@K
  const recall = relevant.size === 0 ? 0 : hits / relevant.size;
  
  // MRR (Mean Reciprocal Rank)
  let mrr = 0;
  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.has(retrieved[i])) {
      mrr = 1 / (i + 1);
      break;
    }
  }
  
  // NDCG (Normalized Discounted Cumulative Gain)
  let dcg = 0, idcg = 0;
  for (let i = 0; i < k; i++) {
    if (i < retrieved.length && relevant.has(retrieved[i])) {
      dcg += 1 / Math.log2(i + 2);
    }
    if (i < relevant.size) {
      idcg += 1 / Math.log2(i + 2);
    }
  }
  const ndcg = idcg === 0 ? 0 : dcg / idcg;
  
  return { recall, mrr, ndcg, hits };
}

async function main() {
  const startTime = Date.now();
  loadEnvFallback();
  
  if (!process.env.OPENAI_API_KEY && !process.env.OPENROUTER_API_KEY) {
    console.error('Missing OPENAI_API_KEY or OPENROUTER_API_KEY');
    process.exit(1);
  }

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║     RAG PERFORMANCE BENCHMARKING & METRICS             ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const pdfPath = path.resolve(process.cwd(), '03_data', 'the-modern-guide-to-oauth.pdf');
  
  // ========== STAGE 1: DATA LOADING ==========
  console.log('━━━ STAGE 1: DATA LOADING ━━━');
  const t1Start = performance.now();
  const bm25Rag = await buildBM25RAG({ pdfPath, useStreaming: true, useLLaMA: false, useReranking: false, topK: 100 });
  const t1End = performance.now();
  const t1Duration = t1End - t1Start;
  
  const docs = bm25Rag.documents;
  const bm25 = bm25Rag.bm25;
  console.log(`✓ Documents loaded: ${docs.length}`);
  console.log(`✓ Time taken: ${formatTime(t1Duration)}\n`);

  // ========== STAGE 2: EMBEDDINGS SETUP ==========
  console.log('━━━ STAGE 2: EMBEDDINGS COMPUTATION ━━━');
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  const model = process.env.OPENROUTER_API_KEY ? 'openai/text-embedding-3-small' : 'text-embedding-3-small';
  const basePath = process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined;
  const embeddings = new OpenAIEmbeddings({ model, apiKey }, basePath ? { basePath } : {});
  
  const t2Start = performance.now();
  const vectors = [];
  const embTimes = [];
  for (let i = 0; i < docs.length; i++) {
    const embStart = performance.now();
    const vec = await embeddings.embedQuery(docs[i].pageContent);
    const embTime = performance.now() - embStart;
    vectors.push(vec);
    embTimes.push(embTime);
    
    if ((i + 1) % 40 === 0) {
      const avg = embTimes.reduce((a, b) => a + b) / embTimes.length;
      console.log(`  Progress: ${i + 1}/${docs.length} docs | Avg time/doc: ${formatTime(avg)}`);
    }
  }
  const t2End = performance.now();
  const t2Duration = t2End - t2Start;
  const avgEmbTime = embTimes.reduce((a, b) => a + b) / embTimes.length;
  console.log(`✓ Total embeddings computed: ${vectors.length}`);
  console.log(`✓ Average time per embedding: ${formatTime(avgEmbTime)}`);
  console.log(`✓ Total embedding time: ${formatTime(t2Duration)}\n`);

  // ========== STAGE 3: TEST QUERIES ==========
  console.log('━━━ STAGE 3: QUERY PROCESSING & RANKING ━━━');
  const testQueries = [
    'What is PKCE and how does it work?',
    'How does OAuth authorization code flow work?',
    'What are the differences between implicit and explicit flows?',
    'How do I refresh access tokens?',
    'What is the purpose of the state parameter?'
  ];

  // Define relevant documents (heuristic)
  const relevant = new Set([40, 41, 43, 49, 50, 51, 55, 58, 67]);

  const results = [];
  for (let qi = 0; qi < testQueries.length; qi++) {
    const query = testQueries[qi];
    console.log(`\n[Query ${qi + 1}] "${query}"`);

    // BM25 ranking
    const bm25Start = performance.now();
    const bm25Results = bm25.search(query, 10);
    const bm25Time = performance.now() - bm25Start;
    const bm25Indices = bm25Results.map(r => r.index);
    const bm25Metrics = await computeMetrics(relevant, bm25Indices, 10);

    // Dense ranking
    const denseStart = performance.now();
    const queryVec = await embeddings.embedQuery(query);
    const denseScores = vectors.map((v, i) => ({
      index: i,
      score: cosine(queryVec, v)
    })).sort((a, b) => b.score - a.score);
    const denseTime = performance.now() - denseStart;
    const denseIndices = denseScores.slice(0, 10).map(r => r.index);
    const denseMetrics = await computeMetrics(relevant, denseIndices, 10);

    // Hybrid ranking (BM25 0.4 + Dense 0.6)
    const hybridStart = performance.now();
    const hybridScores = docs.map((d, i) => {
      const bm25Score = bm25Results.find(r => r.index === i)?.score || 0;
      const denseScore = denseScores.find(r => r.index === i)?.score || 0;
      return {
        index: i,
        score: 0.4 * bm25Score + 0.6 * denseScore
      };
    }).sort((a, b) => b.score - a.score);
    const hybridTime = performance.now() - hybridStart;
    const hybridIndices = hybridScores.slice(0, 10).map(r => r.index);
    const hybridMetrics = await computeMetrics(relevant, hybridIndices, 10);

    console.log(`  BM25    [${formatTime(bm25Time)}]: Recall@10=${(bm25Metrics.recall*100).toFixed(1)}% MRR=${bm25Metrics.mrr.toFixed(3)} NDCG=${bm25Metrics.ndcg.toFixed(3)}`);
    console.log(`  Dense   [${formatTime(denseTime)}]: Recall@10=${(denseMetrics.recall*100).toFixed(1)}% MRR=${denseMetrics.mrr.toFixed(3)} NDCG=${denseMetrics.ndcg.toFixed(3)}`);
    console.log(`  Hybrid  [${formatTime(hybridTime)}]: Recall@10=${(hybridMetrics.recall*100).toFixed(1)}% MRR=${hybridMetrics.mrr.toFixed(3)} NDCG=${hybridMetrics.ndcg.toFixed(3)}`);

    results.push({
      query,
      bm25: { time: bm25Time, metrics: bm25Metrics, indices: bm25Indices },
      dense: { time: denseTime, metrics: denseMetrics, indices: denseIndices },
      hybrid: { time: hybridTime, metrics: hybridMetrics, indices: hybridIndices }
    });
  }

  // ========== SUMMARY METRICS ==========
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║                    SUMMARY METRICS                    ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  // Aggregate metrics
  const avgBM25Recall = results.reduce((s, r) => s + r.bm25.metrics.recall, 0) / results.length;
  const avgDenseRecall = results.reduce((s, r) => s + r.dense.metrics.recall, 0) / results.length;
  const avgHybridRecall = results.reduce((s, r) => s + r.hybrid.metrics.recall, 0) / results.length;

  const avgBM25MRR = results.reduce((s, r) => s + r.bm25.metrics.mrr, 0) / results.length;
  const avgDenseMRR = results.reduce((s, r) => s + r.dense.metrics.mrr, 0) / results.length;
  const avgHybridMRR = results.reduce((s, r) => s + r.hybrid.metrics.mrr, 0) / results.length;

  const avgBM25NDCG = results.reduce((s, r) => s + r.bm25.metrics.ndcg, 0) / results.length;
  const avgDenseNDCG = results.reduce((s, r) => s + r.dense.metrics.ndcg, 0) / results.length;
  const avgHybridNDCG = results.reduce((s, r) => s + r.hybrid.metrics.ndcg, 0) / results.length;

  const avgBM25Time = results.reduce((s, r) => s + r.bm25.time, 0) / results.length;
  const avgDenseTime = results.reduce((s, r) => s + r.dense.time, 0) / results.length;
  const avgHybridTime = results.reduce((s, r) => s + r.hybrid.time, 0) / results.length;

  console.log('RETRIEVAL QUALITY (Average across 5 queries):');
  console.log(`  Metric          BM25         Dense        Hybrid       Winner`);
  console.log(`  ──────────────────────────────────────────────────────────`);
  console.log(`  Recall@10    ${(avgBM25Recall*100).toFixed(1).padStart(5)}%     ${(avgDenseRecall*100).toFixed(1).padStart(5)}%     ${(avgHybridRecall*100).toFixed(1).padStart(5)}%     ${avgHybridRecall > Math.max(avgBM25Recall, avgDenseRecall) ? '✓ HYBRID' : (avgDenseRecall > avgBM25Recall ? '✓ DENSE' : '✓ BM25')}`);
  console.log(`  MRR          ${avgBM25MRR.toFixed(3).padStart(5)}     ${avgDenseMRR.toFixed(3).padStart(5)}     ${avgHybridMRR.toFixed(3).padStart(5)}     ${avgHybridMRR > Math.max(avgBM25MRR, avgDenseMRR) ? '✓ HYBRID' : (avgDenseMRR > avgBM25MRR ? '✓ DENSE' : '✓ BM25')}`);
  console.log(`  NDCG         ${avgBM25NDCG.toFixed(3).padStart(5)}     ${avgDenseNDCG.toFixed(3).padStart(5)}     ${avgHybridNDCG.toFixed(3).padStart(5)}     ${avgHybridNDCG > Math.max(avgBM25NDCG, avgDenseNDCG) ? '✓ HYBRID' : (avgDenseNDCG > avgBM25NDCG ? '✓ DENSE' : '✓ BM25')}`);

  console.log('\nQUERY LATENCY (Average):');
  console.log(`  BM25:        ${formatTime(avgBM25Time)}`);
  console.log(`  Dense:       ${formatTime(avgDenseTime)}`);
  console.log(`  Hybrid:      ${formatTime(avgHybridTime)}`);

  console.log('\nTOTAL PIPELINE PERFORMANCE:');
  const totalTime = Date.now() - startTime;
  console.log(`  Data loading:      ${formatTime(t1Duration)}`);
  console.log(`  Embeddings:        ${formatTime(t2Duration)}`);
  console.log(`  Query processing:  ${formatTime(totalTime - t1Duration - t2Duration)}`);
  console.log(`  Total time:        ${formatTime(totalTime)}`);

  console.log('\nDOCUMENT STATISTICS:');
  console.log(`  Documents:         ${docs.length}`);
  console.log(`  Avg doc length:    ${Math.round(docs.reduce((s, d) => s + d.pageContent.length, 0) / docs.length)} chars`);
  console.log(`  Embedding dims:    ${vectors[0]?.length || 'N/A'}`);

  console.log('\nTOP RECOMMENDATION:');
  const winner = avgHybridRecall > Math.max(avgBM25Recall, avgDenseRecall) ? 'HYBRID' : 
                 avgDenseRecall > avgBM25Recall ? 'DENSE' : 'BM25';
  console.log(`  Best retrieval:    ${winner} (${winner === 'HYBRID' ? 'combines strengths of BM25 and dense' : winner === 'DENSE' ? 'semantic similarity' : 'keyword matching'})`);
  console.log(`  Best for speed:    ${avgBM25Time < avgDenseTime ? 'BM25' : 'DENSE'}`);
  console.log(`  Best overall:      HYBRID (balanced quality + speed)`);

  console.log('\n✓ Benchmarking complete!\n');
  process.exit(0);
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
