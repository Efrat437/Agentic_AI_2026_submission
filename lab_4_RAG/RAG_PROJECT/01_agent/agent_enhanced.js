/**
 * agent_enhanced.js
 * Demonstration of enhanced RAG with:
 * - Hybrid BM25 + semantic search
 * - Cross-encoder reranking
 * - LLaMA parser (optional)
 * - Rich metadata display (headlines, chunks, images)
 */

import dotenv from "dotenv";
import fs from "fs";
import { performance } from "node:perf_hooks";
import { buildStreamingRAG, queryRAG } from "../02_scripts/rag_process_enhanced.js";
import { runFullPipeline } from "../receipt_pipeline/agents/orchestrator.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PDF_PATH = path.join(__dirname, "../03_data", "the-modern-guide-to-oauth.pdf");
const RECEIPT_IMAGE_PATH = path.join(
  __dirname,
  "../receipt_pipeline/03_data/common-gas-receipt-writer-supports-for-usa-east-canada-uk.png"
);

dotenv.config();

function ensureStandaloneDatabaseUrl() {
  const receiptEnv = path.join(__dirname, "../receipt_pipeline/.env");
  if (!fs.existsSync(receiptEnv)) return process.env.DATABASE_URL;

  dotenv.config({ path: receiptEnv, override: false });

  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const host = process.env.DB_HOST || "localhost";
  const port = process.env.DB_PORT || "5433";
  const database = process.env.DB_NAME || "sso_db";
  const current = process.env.DATABASE_URL || "";
  const hasLikelyStaleDefault =
    current.includes("localhost:5433") || current.includes("langchainnew");

  if (user && password && (!current || hasLikelyStaleDefault)) {
    process.env.DATABASE_URL = `postgresql://${user}:${password}@${host}:${port}/${database}`;
  }

  return process.env.DATABASE_URL;
}

function printDivider(label) {
  console.log("\n" + "=".repeat(72));
  console.log(label);
  console.log("=".repeat(72));
}

function printBestAnswer(results) {
  const best = results?.[0];
  if (!best) {
    console.log("Best answer: N/A (no retrieved chunk)");
    return;
  }

  const source = best?.metadata?.source || "N/A";
  const heading = best?.metadata?.heading || "N/A";
  const page = best?.metadata?.page ?? "N/A";
  const chunk = best?.metadata?.chunkIndex ?? "N/A";
  const snippet = String(best?.pageContent || "").slice(0, 320).replace(/\s+/g, " ");

  console.log(`Best answer source: ${heading} | page=${page} | chunk=${chunk} | file=${source}`);
  console.log(`Best answer snippet: ${snippet}`);
}

async function runPdfFlow(targetPath) {
  ensureStandaloneDatabaseUrl();
  if (!process.env.SKIP_SEMANTIC_HANDOFF) process.env.SKIP_SEMANTIC_HANDOFF = "true";
  if (!process.env.USE_LLAMA) process.env.USE_LLAMA = "false";
  const t0 = performance.now();
  const ragData = await buildStreamingRAG(targetPath);
  const buildMs = performance.now() - t0;

  printDivider(`PDF mode: ${targetPath}`);
  console.log(`Build time: ${(buildMs / 1000).toFixed(2)}s`);

  const testQueries = [
    "What is PKCE and why is it important?",
    "How do refresh tokens work in OAuth?",
    "Explain the authorization code flow"
  ];

  for (const query of testQueries) {
    const q0 = performance.now();
    const results = await queryRAG(ragData, query);
    const qMs = performance.now() - q0;

    console.log(`\nQuery: ${query}`);
    console.log(`Retrieved: ${results.length} docs in ${(qMs / 1000).toFixed(2)}s`);

    results.slice(0, 3).forEach((doc, idx) => {
      const heading = doc?.metadata?.heading || "N/A";
      const page = doc?.metadata?.page ?? "N/A";
      const chunk = doc?.metadata?.chunkIndex ?? "N/A";
      const preview = String(doc?.pageContent || "").slice(0, 220).replace(/\s+/g, " ");
      console.log(`  ${idx + 1}. ${heading} | page=${page} chunk=${chunk}`);
      console.log(`     ${preview}`);
    });

    printBestAnswer(results);
  }
}

async function runReceiptFlow(targetPath) {
  const t0 = performance.now();
  const result = await runFullPipeline(targetPath, { userId: "agent-enhanced" });
  const totalMs = performance.now() - t0;

  printDivider(`Receipt mode: ${targetPath}`);
  console.log(`Pipeline time: ${(totalMs / 1000).toFixed(2)}s`);
  console.log(`Extracted date: ${result?.date || "N/A"}`);
  console.log(`Extracted total: ${result?.total ?? "N/A"}`);
  console.log(`Extracted currency: ${result?.currency || "N/A"}`);
  console.log(`Source: ${result?.source || "N/A"}`);

  const answers = [
    result?.total !== undefined && result?.currency
      ? `The total amount is ${result.total} ${result.currency}.`
      : result?.total !== undefined
      ? `The total amount is ${result.total}.`
      : "No total found.",
    result?.currency ? `The currency is ${result.currency}.` : "No currency found.",
    "I have only one receipt."
  ];

  console.log("\nQA:");
  console.log(`Q: What is the total amount?\nA: ${answers[0]}`);
  console.log(`Q: What is the currency?\nA: ${answers[1]}`);
  console.log(`Q: How many receipts do I have?\nA: ${answers[2]}`);
}

async function main() {
  const inputArg = process.argv[2];
  const defaultTarget = PDF_PATH;
  const targetPath = path.resolve(process.cwd(), inputArg || defaultTarget);
  const ext = path.extname(targetPath).toLowerCase();

  try {
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Input file not found: ${targetPath}`);
    }

    if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp") {
      await runReceiptFlow(targetPath);
      return;
    }

    if (ext !== ".pdf") {
      console.log(`Unsupported extension (${ext}).`);
      console.log(`Try PDF: ${PDF_PATH}`);
      console.log(`Try receipt image: ${RECEIPT_IMAGE_PATH}`);
      process.exit(1);
    }

    await runPdfFlow(targetPath);

  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

main();
