import path from 'path';
import { buildQAuthRAG, queryRAG, formatResults } from './rag_process_enhanced.js';

(async () => {
  try {
    console.log('Running enhanced RAG ingestion (BM25 hybrid)');
    const pdfPath = path.resolve(process.cwd(), '03_data', 'the-modern-guide-to-oauth.pdf');
    const rag = await buildQAuthRAG({ pdfPath, useStreaming: true, useLLaMA: false });

    console.log('Running sample query: What is PKCE in OAuth?');
    const results = await queryRAG(rag, 'What is PKCE in OAuth?', 5);
    const formatted = formatResults(results);
    console.log('Top results:');
    formatted.forEach(r => {
      console.log(`- Rank ${r.rank} | ${r.heading} | score=${r.score}`);
      console.log(r.text);
      console.log('---');
    });

    process.exit(0);
  } catch (err) {
    console.error('Enhanced ingest failed:', err.message);
    process.exit(1);
  }
})();
