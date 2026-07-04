import path from 'path';
import { buildQAuthRAG, crossEncoderRerank, formatResults } from './rag_process_enhanced.js';

function tokenize(text) {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter(t => t.length > 2);
}

function buildTfIdf(docs) {
  const df = new Map();
  const docsTokens = docs.map(d => tokenize(d.pageContent));
  docsTokens.forEach(tokens => {
    const seen = new Set(tokens);
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  });
  const N = docs.length;

  const idf = key => Math.log((N + 1) / ((df.get(key) || 0) + 1));

  const vectors = docsTokens.map(tokens => {
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    const vec = new Map();
    for (const [t, f] of tf.entries()) {
      vec.set(t, f * idf(t));
    }
    return vec;
  });

  return { vectors, idfMap: df };
}

function cosineMap(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [k, va] of a.entries()) {
    na += va * va;
    const vb = b.get(k) || 0;
    dot += va * vb;
  }
  for (const vb of b.values()) nb += vb * vb;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function main() {
  const pdfPath = path.resolve(process.cwd(), '03_data', 'the-modern-guide-to-oauth.pdf');
  console.log('Building RAG data from PDF:', pdfPath);
  const rag = await buildQAuthRAG({ pdfPath, useStreaming: true, useLLaMA: false, useReranking: false, topK: 50 });

  const query = 'What is PKCE in OAuth?';
  console.log('\nQuery:', query, '\n');

  // BM25 base results
  const bm25Results = rag.bm25.search(query, 50).map(r => ({ ...r }));

  // Build TF-IDF vectors for cosine similarity
  const { vectors } = buildTfIdf(rag.documents);

  // Build query vector
  const qTokens = tokenize(query);
  const qtf = new Map();
  for (const t of qTokens) qtf.set(t, (qtf.get(t) || 0) + 1);
  // compute idf from rag.bm25's idf if accessible
  // fallback: use docs-derived idf from buildTfIdf via document vectors
  const qvec = new Map();
  for (const [t, f] of qtf.entries()) {
    // approximate idf by presence in vectors maps
    let idf = 1;
    if (vectors.length > 0) {
      // count docs that contain term
      const df = vectors.reduce((c, v) => c + (v.has(t) ? 1 : 0), 0);
      idf = Math.log((vectors.length + 1) / (df + 1));
    }
    qvec.set(t, f * idf);
  }

  // compute semantic scores (cosine) for docs
  const semanticScores = vectors.map((vec, i) => ({ index: i, score: cosineMap(qvec, vec) }));

  // merge bm25 and semantic into combined map
  const combined = new Map();
  for (const r of bm25Results) {
    const key = `${r.heading}:${r.text.slice(0,50)}`;
    combined.set(key, { heading: r.heading, text: r.text, bm25Score: r.bm25Score || 0, chunkIndex: r.index });
  }
  for (const s of semanticScores) {
    const doc = rag.documents[s.index];
    const key = `${doc.metadata.heading}:${doc.pageContent.slice(0,50)}`;
    if (combined.has(key)) combined.get(key).semanticScore = s.score;
    else combined.set(key, { heading: doc.metadata.heading, text: doc.pageContent, semanticScore: s.score, chunkIndex: s.index, bm25Score: 0 });
  }

  let results = Array.from(combined.values());

  // show top10 by semantic
  const bySemantic = [...results].sort((a,b)=> (b.semanticScore||0) - (a.semanticScore||0)).slice(0,10);
  console.log('Top 10 by semantic (cosine TF-IDF):');
  bySemantic.forEach((r,i)=>{
    console.log(`${i+1}. ${r.heading} | semantic=${(r.semanticScore||0).toFixed(4)} | bm25=${(r.bm25Score||0).toFixed(3)}`);
  });

  // show top10 by BM25
  const byBM25 = [...results].sort((a,b)=> (b.bm25Score||0) - (a.bm25Score||0)).slice(0,10);
  console.log('\nTop 10 by BM25:');
  byBM25.forEach((r,i)=>{
    console.log(`${i+1}. ${r.heading} | bm25=${(r.bm25Score||0).toFixed(3)} | semantic=${(r.semanticScore||0).toFixed(4)}`);
  });

  // apply cross-encoder rerank (uses semanticScore + bm25Score normalization)
  // prepare results with both scores
  const prepared = results.map(r => ({ ...r, semanticScore: r.semanticScore||0, bm25Score: r.bm25Score||0 }));
  const reranked = crossEncoderRerank(prepared, query, { semantic: 0.6, bm25: 0.4 }).slice(0,10);

  console.log('\nTop 10 after reranking (cross-encoder style 0.6/0.4):');
  reranked.forEach((r,i)=>{
    console.log(`${i+1}. ${r.heading} | reranked=${r.rerankedScore.toFixed(4)} | semantic=${(r.semanticScore||0).toFixed(4)} | bm25=${(r.bm25Score||0).toFixed(3)}`);
    console.log(`    snippet: ${r.text.slice(0,180).replace(/\n/g,' ')}...`);
  });

  // simple evaluation: intersection sizes
  const setSemantic = new Set(bySemantic.map(r=>r.heading+':'+r.text.slice(0,50)));
  const setBM25 = new Set(byBM25.map(r=>r.heading+':'+r.text.slice(0,50)));
  const intersect = [...setSemantic].filter(x=> setBM25.has(x)).length;
  console.log(`\nOverlap between semantic top10 and BM25 top10: ${intersect}/10`);

  // average scores for reranked top10
  const avgRerankedSemantic = reranked.reduce((s,r)=> s + (r.semanticScore||0), 0)/reranked.length;
  const avgRerankedBM25 = reranked.reduce((s,r)=> s + (r.bm25Score||0), 0)/reranked.length;
  console.log(`Average semantic score (reranked top10): ${avgRerankedSemantic.toFixed(4)}`);
  console.log(`Average BM25 score (reranked top10): ${avgRerankedBM25.toFixed(3)}`);

  process.exit(0);
}

main().catch(err=>{ console.error('Diagnostics failed:', err); process.exit(1); });
