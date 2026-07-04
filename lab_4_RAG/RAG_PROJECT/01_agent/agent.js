// Load environment variables
import "dotenv/config";
// Import your RAG pipeline helper functions (with RecursiveCharacterTextSplitter + LLaMA parser)
import { buildQAuthRAG, queryRAG } from "../02_scripts/rag_process.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PDF_PATH = path.join(__dirname, "../03_data", "the-modern-guide-to-oauth.pdf");

// This ensures ingestion is done only once (decoupled)
async function initializeRetriever() {
  console.log("Building RAG retriever with RecursiveCharacterTextSplitter + LLaMA parser...");
  const ragData = await buildQAuthRAG({ 
    pdfPath: PDF_PATH,
    useStreaming: true,      // Enable streaming with batching
    chunkSize: 1000,         // Intelligent chunk boundaries
    chunkOverlap: 200,       // Context overlap between chunks
    topK: 20                 // Return top 20 relevant chunks
  });
  console.log("✅ Retriever ready with optimized chunking strategy.");
  return ragData;
}

function hybridScore(cosine, bm25, maxBM25) { 
  const c = (cosine + 1) / 2; // normalize cosine from [-1,1] → [0,1]
  const b = bm25 / maxBM25;   // normalize BM25 score
  return 0.6 * c + 0.4 * b;   // weighted combination
}

const testSet = [
  {
    query: "What is PKCE in OAuth?",
    relevantDocId: "chunk_45"
  }
];

async function retrieveAndRank(ragData, query, k = 20) {
  // Extract retriever from ragData
  const retriever = ragData.retriever;
  
  // Get top K chunks from retriever
  const rawChunks = await queryRAG(retriever, query, k);

  // Compute hybrid scores
  const maxScore = Math.max(...rawChunks.map(c => c.score || 1), 1);
  const scoredChunks = rawChunks.map(chunk => {
    const normalizedScore = chunk.score / maxScore;
    return { ...chunk, score: normalizedScore };
  });

  // Sort by score descending
  const rankedChunks = scoredChunks.sort((a, b) => b.score - a.score);

  return rankedChunks;
}

function evaluate(testSet, retrievedChunks) {
  testSet.forEach(test => {
    const foundIndex = retrievedChunks.findIndex(c => c.chunkIndex === test.relevantDocId);
    const recall = foundIndex !== -1 ? 1 : 0;
    const mrr = foundIndex !== -1 ? 1 / (foundIndex + 1) : 0;
    console.log(`Query: ${test.query}, Recall@K: ${recall}, MRR@K: ${mrr}`);
  });
}

async function main() {
  const ragData = await initializeRetriever();

  const queries = [
    "What is PKCE in OAuth?",
    "How does OAuth handle refresh tokens?",
    "Explain authorization code flow in OAuth"
  ];

  for (const q of queries) {
    const chunks = await retrieveAndRank(ragData, q, 10);
    
    console.log(`\n📌 Query: "${q}"`);
    if (chunks.length === 0) {
      console.log("  ℹ️  No results found");
      continue;
    }
    
    chunks.slice(0, 5).forEach((c, i) => {
      console.log(`  [${i + 1}] Score: ${c.score.toFixed(3)}, Text: ${c.text.slice(0, 100)}...`);
    });

    evaluate(testSet, chunks);
  }

  console.log("\n✅ RAG Agent test complete!");
}

main().catch(err => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});