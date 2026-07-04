/**
 * evaluate_retriever.js
 * Evaluate RAG retriever performance using NDCG, MRR, recall metrics
 */

import "dotenv/config";
import { buildStreamingRAG as buildQAuthRAG, queryRAG } from "./rag_process_enhanced.js";

// use in-memory mode so no DB is required
process.env.SKIP_SEMANTIC_HANDOFF = "true";

const testQueries = [
  {
    query: "What is PKCE in OAuth?",
    relevant: ["PKCE", "Proof Key", "authorization code", "interception"]
  },
  {
    query: "How does OAuth handle refresh tokens?",
    relevant: ["refresh tokens", "long-lived", "access tokens", "secure"]
  },
  {
    query: "Explain authorization code flow",
    relevant: ["authorization code", "web applications", "secure", "redirect"]
  },
  {
    query: "What is OAuth 2.0?",
    relevant: ["OAuth 2.0", "authorization", "delegation", "credentials"]
  }
];

/**
 * Calculate Reciprocal Rank (RR) - position of first relevant result
 */
function calculateRR(results, relevantKeywords) {
  for (let i = 0; i < results.length; i++) {
    const text = (results[i].pageContent || results[i].text || "").toLowerCase();
    if (relevantKeywords.some(keyword => text.includes(keyword.toLowerCase()))) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * Calculate Recall@K - proportion of relevant docs in top K
 */
function calculateRecall(results, relevantKeywords) {
  const found = results.filter(r =>
    relevantKeywords.some(keyword =>
      (r.pageContent || r.text || "").toLowerCase().includes(keyword.toLowerCase())
    )
  );
  return found.length > 0 ? 1 : 0;
}

/**
 * Calculate NDCG@K - Normalized Discounted Cumulative Gain
 */
function calculateNDCG(results, relevantKeywords, k = 10) {
  // DCG calculation
  let dcg = 0;
  for (let i = 0; i < Math.min(k, results.length); i++) {
    const isRelevant = relevantKeywords.some(keyword =>
      (results[i].pageContent || results[i].text || "").toLowerCase().includes(keyword.toLowerCase())
    ) ? 1 : 0;
    dcg += isRelevant / Math.log2(i + 2);
  }

  // IDCG calculation (ideal: all relevant at top)
  const relevantCount = Math.min(relevantKeywords.length, k);
  let idcg = 0;
  for (let i = 0; i < relevantCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg > 0 ? dcg / idcg : 0;
}

/**
 * Run evaluation on the retriever
 */
async function evaluateRetriever() {
  console.log("🔹 Initializing RAG retriever for evaluation...\n");
  
  const ragData = await buildQAuthRAG("./03_data/the-modern-guide-to-oauth.pdf");

  let totalMRR = 0;
  let totalRecall = 0;
  let totalNDCG = 0;

  console.log("📊 Evaluating on test queries:\n");

  for (const test of testQueries) {
    console.log(`Query: "${test.query}"`);
    console.log(`Relevant keywords: [${test.relevant.join(", ")}]\n`);

    // Retrieve documents
    const results = await queryRAG(ragData, test.query);

    if (results.length === 0) {
      console.log("  ⚠️  No results retrieved\n");
      continue;
    }

    // Calculate metrics
    const mrr = calculateRR(results, test.relevant);
    const recall = calculateRecall(results, test.relevant);
    const ndcg = calculateNDCG(results, test.relevant, 10);

    totalMRR += mrr;
    totalRecall += recall;
    totalNDCG += ndcg;

    console.log("  Top 3 Results:");
    results.slice(0, 3).forEach((r, i) => {
      const text = r.pageContent || r.text || "";
      console.log(`    [${i + 1}] ${text.slice(0, 100)}...`);
    });

    console.log(`\n  Metrics:`);
    console.log(`    MRR@10: ${mrr.toFixed(3)}`);
    console.log(`    Recall@10: ${recall.toFixed(3)}`);
    console.log(`    NDCG@10: ${ndcg.toFixed(3)}\n`);
  }

  // Compute averages
  const avgMRR = totalMRR / testQueries.length;
  const avgRecall = totalRecall / testQueries.length;
  const avgNDCG = totalNDCG / testQueries.length;

  console.log("━".repeat(50));
  console.log("📈 Overall Evaluation Results:\n");
  console.log(`  Average MRR@10:    ${avgMRR.toFixed(3)}`);
  console.log(`  Average Recall@10: ${avgRecall.toFixed(3)}`);
  console.log(`  Average NDCG@10:   ${avgNDCG.toFixed(3)}`);
  console.log("━".repeat(50) + "\n");

  console.log("✅ Evaluation complete!");
}

// Run evaluation
evaluateRetriever().catch(err => {
  console.error("❌ Evaluation failed:", err);
  process.exit(1);
});