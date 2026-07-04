/**
 * eval_enhanced.js
 * OAuth PDF gold-set evaluation: Recall@K, MRR, NDCG@K
 * Runs fully in-memory via SKIP_SEMANTIC_HANDOFF (no DB needed).
 */

import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env", import.meta.url).pathname });

// Must be set BEFORE buildStreamingRAG reads it (it's read inside the function)
process.env.SKIP_SEMANTIC_HANDOFF = "true";

import { buildStreamingRAG, queryRAG } from "./rag_process_enhanced.js";

// ----------------------------------------------------------------
// Gold eval set – queries grounded in "The Modern Guide to OAuth"
// Each entry has:
//   query        : the user question
//   relevant     : keywords that MUST appear in a relevant chunk
//   description  : human label for reporting
// ----------------------------------------------------------------
const GOLD_SET = [
  {
    description: "PKCE definition & purpose",
    query: "What is PKCE and why is it important for OAuth?",
    relevant: ["pkce", "proof key", "code challenge", "code verifier", "interception"],
  },
  {
    description: "Refresh token mechanics",
    query: "How do refresh tokens work in OAuth 2.0?",
    relevant: ["refresh token", "access token", "expire", "renew", "long-lived"],
  },
  {
    description: "Authorization code flow",
    query: "Explain the authorization code flow in OAuth",
    relevant: ["authorization code", "redirect", "grant", "exchange", "code"],
  },
  {
    description: "OAuth scopes",
    query: "What are OAuth scopes and how are they used?",
    relevant: ["scope", "permission", "access", "resource"],
  },
  {
    description: "CSRF / state parameter",
    query: "How does OAuth prevent CSRF attacks using the state parameter?",
    relevant: ["state", "csrf", "cross-site", "random", "nonce"],
  },
  {
    description: "Client credentials grant",
    query: "What is the client credentials grant in OAuth?",
    relevant: ["client credentials", "machine", "server", "grant"],
  },
  {
    description: "Bearer token usage",
    query: "What is a bearer token and how is it used?",
    relevant: ["bearer", "authorization header", "token", "credential"],
  },
  {
    description: "Implicit flow",
    query: "How does the OAuth implicit flow work?",
    relevant: ["implicit", "access token", "browser", "fragment", "spa"],
  },
];

const TOP_K = parseInt(process.env.TOP_K || "8");
const PDF_PATH = process.env.EVAL_PDF || "./03_data/the-modern-guide-to-oauth.pdf";

// ----------------------------------------------------------------
// Metric helpers
// ----------------------------------------------------------------

/** Reciprocal Rank – rank position of first relevant result (1-indexed) */
function reciprocalRank(docs, keywords) {
  for (let i = 0; i < docs.length; i++) {
    const text = (docs[i].pageContent || "").toLowerCase();
    if (keywords.some((kw) => text.includes(kw.toLowerCase()))) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/** Binary Recall@K – 1 if ANY relevant doc found in top-K */
function recallAtK(docs, keywords) {
  return docs.some((d) =>
    keywords.some((kw) => (d.pageContent || "").toLowerCase().includes(kw.toLowerCase()))
  )
    ? 1
    : 0;
}

/** Precision@K – fraction of top-K docs that contain at least one keyword */
function precisionAtK(docs, keywords) {
  if (docs.length === 0) return 0;
  const hits = docs.filter((d) =>
    keywords.some((kw) => (d.pageContent || "").toLowerCase().includes(kw.toLowerCase()))
  ).length;
  return hits / docs.length;
}

/** NDCG@K */
function ndcgAtK(docs, keywords, k) {
  const effective = docs.slice(0, k);

  let dcg = 0;
  effective.forEach((d, i) => {
    const rel = keywords.some((kw) =>
      (d.pageContent || "").toLowerCase().includes(kw.toLowerCase())
    )
      ? 1
      : 0;
    dcg += rel / Math.log2(i + 2);
  });

  // Ideal DCG: assume all k positions could be relevant
  const maxRel = Math.min(keywords.length, k);
  let idcg = 0;
  for (let i = 0; i < maxRel; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg > 0 ? dcg / idcg : 0;
}

/** Format provenance line from a doc */
function provenanceLine(doc) {
  const m = doc.metadata || {};
  const parts = [];
  if (m.page) parts.push(`page ${m.page}`);
  if (m.chunkIndex !== undefined) parts.push(`chunk ${m.chunkIndex}`);
  if (m.source) parts.push(m.source.split(/[\\/]/).pop());
  return parts.length ? `[${parts.join(" | ")}]` : "[unknown]";
}

// ----------------------------------------------------------------
// Main
// ----------------------------------------------------------------

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(" OAuth PDF – Enhanced Retrieval Evaluation");
  console.log(`${"═".repeat(60)}`);
  console.log(`PDF : ${PDF_PATH}`);
  console.log(`TOP_K: ${TOP_K}\n`);

  const startIngest = Date.now();
  const ragData = await buildStreamingRAG(PDF_PATH);
  const ingestMs = Date.now() - startIngest;
  console.log(`\n[Eval] RAG ready in ${ingestMs}ms\n`);

  const results = [];

  for (const item of GOLD_SET) {
    const t0 = Date.now();
    const docs = await queryRAG(ragData, item.query);
    const latencyMs = Date.now() - t0;

    const rr = reciprocalRank(docs, item.relevant);
    const recall = recallAtK(docs, item.relevant);
    const precision = precisionAtK(docs, item.relevant);
    const ndcg = ndcgAtK(docs, item.relevant, TOP_K);

    // find first relevant doc for provenance display
    const firstHit = docs.find((d) =>
      item.relevant.some((kw) =>
        (d.pageContent || "").toLowerCase().includes(kw.toLowerCase())
      )
    );

    results.push({ item, docs, rr, recall, precision, ndcg, latencyMs, firstHit });

    console.log(`─ ${item.description}`);
    console.log(`  Query   : "${item.query}"`);
    console.log(`  MRR     : ${rr === 0 ? "0 (not found)" : (1 / rr).toFixed(0) + " → RR=" + rr.toFixed(3)}`);
    console.log(`  Recall@${TOP_K}: ${recall === 1 ? "HIT" : "MISS"}`);
    console.log(`  Prec@${TOP_K}  : ${(precision * 100).toFixed(1)}%`);
    console.log(`  NDCG@${TOP_K}  : ${ndcg.toFixed(3)}`);
    console.log(`  Latency : ${latencyMs}ms`);
    if (firstHit) {
      console.log(`  Best hit: ${provenanceLine(firstHit)}`);
      console.log(`  Snippet : "${(firstHit.pageContent || "").slice(0, 120).replace(/\s+/g, " ")}..."`);
    } else {
      console.log(`  Best hit: (none – no chunk matched keywords)`);
    }
    console.log();
  }

  // ----------------------------------------------------------------
  // Aggregate summary
  // ----------------------------------------------------------------
  const n = results.length;
  const avgMRR = results.reduce((s, r) => s + r.rr, 0) / n;
  const avgRecall = results.reduce((s, r) => s + r.recall, 0) / n;
  const avgPrec = results.reduce((s, r) => s + r.precision, 0) / n;
  const avgNDCG = results.reduce((s, r) => s + r.ndcg, 0) / n;
  const avgLatency = results.reduce((s, r) => s + r.latencyMs, 0) / n;
  const hits = results.filter((r) => r.recall === 1).length;

  console.log(`${"═".repeat(60)}`);
  console.log(` Summary  (${n} queries, TOP_K=${TOP_K})`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  MRR@${TOP_K}    : ${avgMRR.toFixed(3)}`);
  console.log(`  Recall@${TOP_K} : ${avgRecall.toFixed(3)}  (${hits}/${n} queries hit)`);
  console.log(`  Prec@${TOP_K}   : ${(avgPrec * 100).toFixed(1)}%`);
  console.log(`  NDCG@${TOP_K}   : ${avgNDCG.toFixed(3)}`);
  console.log(`  Avg Latency: ${avgLatency.toFixed(0)}ms`);
  console.log(`${"═".repeat(60)}\n`);

  // Quality interpretation
  console.log(" Quality interpretation:");
  console.log(`  MRR >= 0.8 → first relevant doc is usually in top-2`);
  const grade =
    avgMRR >= 0.8 ? "Excellent" : avgMRR >= 0.6 ? "Good" : avgMRR >= 0.4 ? "Fair" : "Needs improvement";
  console.log(`  This pipeline: ${grade} (MRR=${avgMRR.toFixed(3)})\n`);
}

main().catch((err) => {
  console.error("[Eval] Fatal error:", err);
  process.exit(1);
});
