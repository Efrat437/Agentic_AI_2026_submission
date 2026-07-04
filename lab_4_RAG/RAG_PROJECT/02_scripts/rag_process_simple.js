/**
 * rag-process-simple.js
 * Simplified RAG without external vectorstore dependencies
 * Uses text similarity matching for retrieval
 */

import fs from "fs";
import path from "path";
import { Document } from "@langchain/core/documents";
import "dotenv/config";

const PDF_PATH = path.join("./data", "the-modern-guide-to-qauth.pdf");

/**
 * Simple text similarity using word overlap
 */
function calculateSimilarity(text1, text2) {
  const words1 = new Set(text1.toLowerCase().split(/\s+/));
  const words2 = new Set(text2.toLowerCase().split(/\s+/));
  
  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);
  
  return intersection.size / union.size; // Jaccard similarity
}

/**
 * Build simple RAG from documents
 */
export async function buildQAuthRAG({
  pdfPath = PDF_PATH,
  topK = 20,
} = {}) {
  console.log("🔹 Initializing RAG pipeline...");

  let docs = [];
  
  // Load documents
  if (fs.existsSync(pdfPath)) {
    console.log(`🔹 Loading text file: ${pdfPath}...`);
    try {
      const content = fs.readFileSync(pdfPath, 'utf-8');
      const chunks = content.split('\n\n').filter(c => c.trim().length > 10);
      docs = chunks.slice(0, 50).map((chunk, i) => new Document({
        pageContent: chunk.trim().slice(0, 800),
        metadata: { source: pdfPath, chunkIndex: i }
      }));
      console.log(`  ✓ Loaded and chunked ${docs.length} documents`);
    } catch (err) {
      console.warn(`⚠️  Could not load file: ${err.message}, using sample data...`);
      docs = getDefaultDocuments();
    }
  } else {
    console.warn(`⚠️  File not found at ${pdfPath}, using sample data...`);
    docs = getDefaultDocuments();
  }

  console.log("✅ RAG initialized with sample retriever (similarity-based)!");
  
  return { 
    documents: docs,
    retriever: { documents: docs, invoke: null } // Placeholder
  };
}

/**
 * Query using simple similarity matching
 */
export async function queryRAG(ragData, query, k = 20) {
  const documents = ragData.documents || [];
  
  if (!documents.length) {
    console.warn("⚠️  No documents to search");
    return [];
  }

  // Calculate similarity for each document
  const scored = documents.map((doc, i) => ({
    chunkIndex: i,
    text: doc.pageContent,
    heading: doc.metadata?.heading || "",
    score: calculateSimilarity(query, doc.pageContent)
  }));

  // Sort by score descending and return top K
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/**
 * Get default sample documents
 */
function getDefaultDocuments() {
  return [
    new Document({
      pageContent: "OAuth 2.0 is an open standard authorization protocol. It enables resource owners to authorize third-party applications to access their resources without sharing their credentials directly with the third-party.",
      metadata: { source: "sample", heading: "OAuth 2.0 Overview" }
    }),
    new Document({
      pageContent: "PKCE (Proof Key for Code Exchange) is an OAuth 2.0 extension designed to protect public clients from authorization code interception attacks. It uses dynamically generated codes during the authorization process.",
      metadata: { source: "sample", heading: "PKCE Mechanism" }
    }),
    new Document({
      pageContent: "Refresh tokens are long-lived credentials that allow applications to obtain new access tokens without requiring the user to re-authenticate. They should be stored securely and rotated regularly.",
      metadata: { source: "sample", heading: "Refresh Tokens" }
    }),
    new Document({
      pageContent: "The Authorization Code Flow is the most secure OAuth flow for traditional server-side web applications. It involves the user being redirected to the authorization server and receiving an authorization code.",
      metadata: { source: "sample", heading: "Authorization Code Flow" }
    }),
    new Document({
      pageContent: "The Implicit Flow is simplified OAuth flow for browser-based applications but is now considered less secure and discouraged. The Resource Owner Password Credentials flow is rarely used for new applications.",
      metadata: { source: "sample", heading: "OAuth Flows" }
    }),
    new Document({
      pageContent: "Scopes in OAuth define what permissions an application is requesting. They allow users to grant limited access instead of full access to all user data and functionality.",
      metadata: { source: "sample", heading: "OAuth Scopes" }
    }),
  ];
}
