import path from 'path';
import { buildQAuthRAG, queryRAG } from './rag_process_v2.js';

(async () => {
  try {
    console.log('Starting ChromaDB ingestion test...');
    const pdfPath = path.resolve(process.cwd(), '03_data', 'the-modern-guide-to-oauth.pdf');

    // Ensure CHROMA_URL env var if you run a Chroma server; otherwise local persistent storage will be used
    const res = await buildQAuthRAG({ pdfPath, useStreaming: true, useChromaDB: true, parserType: 'auto', isScanned: false });

    console.log('Ingestion complete. Running one sample query...');
    const { retriever } = res;
    const results = await queryRAG(retriever, 'What is PKCE in OAuth?', 5);
    console.log('Top results:');
    results.slice(0,5).forEach((r, i) => {
      console.log(`--- Result ${i+1} (len ${r.text.length}):`);
      console.log(r.text.substring(0, 500));
      console.log('---');
    });

    console.log('ChromaDB ingestion test finished.');
  } catch (err) {
    console.error('Ingest test failed:', err.message);
    process.exit(1);
  }
})();
