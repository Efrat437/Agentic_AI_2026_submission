import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env", import.meta.url).pathname });
import { queryRAG } from "../02_scripts/rag_process_enhanced.js";
import fetch from "node-fetch";

// ============================================================
// CLAUDE API
// ============================================================

async function callClaude(systemContent, userContent) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Set ANTHROPIC_API_KEY in .env");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method : "POST",
    headers: {
      "Content-Type"     : "application/json",
      "x-api-key"        : apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model     : "claude-opus-4-6",
      max_tokens: 1500,
      system    : systemContent,
      messages  : [{ role: "user", content: userContent }]
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[Claude] API error:', JSON.stringify(data));
    throw new Error(data.error?.message || JSON.stringify(data));
  }

  return data.content?.[0]?.text || "No response received.";
}

// ============================================================
// SYSTEM PROMPT
// ============================================================

const SYSTEM_PROMPT = `
You are a highly capable RAG (Retrieval-Augmented Generation) agent specialized in OAuth 2.0.
Your task is to answer user questions using retrieved knowledge sources efficiently, accurately, and clearly.

================================================================
1. OBJECTIVE
================================================================
- Answer ONLY from relevant content retrieved from the knowledge base.
- Be concise, precise, and structured in every response.
- Always include citations and references to source chunks.
- Never hallucinate or invent information not present in the context.
- If no relevant documents are found, say so clearly.
- If the query is ambiguous, ask for clarification before answering.

================================================================
2. RETRIEVAL FLOW (always follow this order)
================================================================
Step 1 — Semantic Search (PRIMARY, weight: 0.7)
         Query the vector store for semantically similar chunks.
         Focus on meaning and context, not just keywords.

Step 2 — BM25 Keyword Search (SUPPORTING, weight: 0.3)
         Reinforce results with exact keyword matches.
         Especially useful when semantic similarity is low.

Step 3 — Hybrid Ensemble
         Combine semantic + BM25 scores using weighted average.
         Formula: hybridScore = (0.7 x semantic) + (0.3 x BM25)
         Both scores normalized to 0-1 before combining.

Step 4 — Reranker
         Re-rank top-K hybrid results to improve precision.
         Only top-ranked chunks after reranking are used.

Step 5 — Contextual Compression
         Extract only the most relevant sections from top chunks.
         Discard irrelevant content within each chunk.

Step 6 — Answer Generation
         Formulate a clear natural language answer.
         Include citations for every claim made.

================================================================
3. ANSWER FORMAT (always use this structure)
================================================================
1. DIRECT ANSWER
   A concise, precise answer to the question.

2. SUPPORTING EVIDENCE
   Key facts and quotes from retrieved chunks that support the answer.
   Reference each chunk explicitly.

3. CITATIONS
   Format: (Source: [heading] | Page [X] | Chunk [Y])
   Include one citation per supporting claim.

4. CHAIN OF THOUGHT SUMMARY
   Brief summary of the retrieval reasoning:
   - Which chunks were most relevant and why
   - How semantic vs keyword search contributed
   - Any ambiguities or gaps in the retrieved context

================================================================
4. CITATION FORMAT
================================================================
Always cite using this format:
  "According to [heading], page [X], chunk [Y]: ..."

Example:
  "According to 'Authorization Code Grant', page 12, chunk 34:
   The authorization code is exchanged for an access token
   by the application backend."

================================================================
5. EXAMPLE
================================================================
User Question:
  "How does OAuth 2.0 authorization work in a modern web application?"

Retrieval Steps:
  1. Semantic search: top-K chunks about "OAuth 2.0 authorization flow"
  2. BM25 search: reinforced "authorization code", "web application"
  3. Hybrid ensemble: combined and weighted results
  4. Reranker: selected top 5 most relevant chunks
  5. Compression: extracted concise explanation from each chunk

Answer:
  OAuth 2.0 uses the Authorization Code flow in modern web apps.
  The application redirects the user to the authorization server,
  receives an authorization code, then exchanges it for an access
  token which grants access to protected resources.

  (Source: 'Authorization Code Grant' | Page 12 | Chunk 34)

Chain of Thought:
  - Semantic search found chunks about OAuth flows and token exchange.
  - BM25 reinforced matches on "authorization code" and "web app".
  - Hybrid ensemble ranked Authorization Code Grant chunks highest.
  - Reranker confirmed chunk 34 as most precise answer.

================================================================
6. DEBUG MODE (when user requests retrieval transparency)
================================================================
If the user asks for debug information, provide:
  - Query used for semantic search
  - Query used for BM25 search
  - Top-K chunk headings and scores before reranking
  - Top-K chunk headings and scores after reranking
  - Which chunks contributed to the final answer and why

================================================================
7. RULES SUMMARY
================================================================
  - Never answer from memory — only from retrieved context.
  - Always follow the flow: Semantic → BM25 → Hybrid → Rerank → Answer.
  - Always cite heading, page number, and chunk index.
  - Weights are fixed: 0.7 semantic, 0.3 BM25.
  - If context is insufficient, say so and suggest rephrasing.
  - Keep answers focused — do not pad with irrelevant information.
`;

// ============================================================
// ANSWER WITH RAG — returns { answer, chunks }
// ============================================================

export async function answerWithRAG(ragData, userQuestion, options = { topK: 5 }) {

  // Step 1: Retrieve chunks
  const retrievedDocs = await queryRAG(ragData, userQuestion, options.topK);

  if (!retrievedDocs || retrievedDocs.length === 0) {
    console.warn('[Agent] No chunks retrieved for query:', userQuestion);
    return {
      answer: 'No relevant documents found for your question.',
      chunks: []
    };
  }

  // Step 2: Log full metadata to terminal
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Agent] Query: "${userQuestion}"`);
  console.log(`[Agent] ${retrievedDocs.length} chunks retrieved:`);
  console.log('='.repeat(60));

  retrievedDocs.forEach((doc, idx) => {
    console.log(`\n  Chunk ${idx + 1}:`);
    console.log(`  ├─ Heading    : ${doc.metadata?.heading    || 'N/A'}`);
    console.log(`  ├─ Page       : ${doc.metadata?.page       || 'N/A'}`);
    console.log(`  ├─ ChunkIndex : ${doc.metadata?.chunkIndex ?? 'N/A'}`);
    console.log(`  ├─ Type       : ${doc.metadata?.type       || 'N/A'}`);
    console.log(`  ├─ Length     : ${doc.metadata?.length     || doc.pageContent?.length || 0} chars`);
    console.log(`  ├─ HasTables  : ${doc.metadata?.hasTables  ?? false}`);
    console.log(`  ├─ HasImages  : ${doc.metadata?.hasImages  ?? false}`);
    console.log(`  └─ Preview    : ${(doc.pageContent || '').slice(0, 150).replace(/\n/g, ' ')}...`);
  });
  console.log('='.repeat(60));

  // Step 3: Build context for Claude
  const contextText = retrievedDocs
    .map((doc, idx) => `
[Chunk ${idx + 1}]
Heading    : ${doc.metadata?.heading    || 'N/A'}
Page       : ${doc.metadata?.page       || 'N/A'}
ChunkIndex : ${doc.metadata?.chunkIndex ?? 'N/A'}
Type       : ${doc.metadata?.type       || 'N/A'}
HasTables  : ${doc.metadata?.hasTables  ?? false}
HasImages  : ${doc.metadata?.hasImages  ?? false}
Content    : ${doc.pageContent || ''}
`).join('\n---\n');

  const userContent = `Context from retrieved documents:\n${contextText}\n\nUser Question: ${userQuestion}`;

  // Step 4: Call Claude
  console.log('[Agent] Calling Claude API...');
  let answer;
  try {
    answer = await callClaude(SYSTEM_PROMPT, userContent);
    console.log('[Agent] Answer received');
  } catch (err) {
    console.error('[Agent] Claude call failed:', err.message);
    answer = `Error calling Claude API: ${err.message}`;
  }

  // Step 5: Return answer + chunk metadata for browser UI
  const chunks = retrievedDocs.map((doc, idx) => ({
    rank      : idx + 1,
    heading   : doc.metadata?.heading    || 'N/A',
    page      : doc.metadata?.page       || 'N/A',
    chunkIndex: doc.metadata?.chunkIndex ?? 'N/A',
    type      : doc.metadata?.type       || 'N/A',
    length    : doc.metadata?.length     || doc.pageContent?.length || 0,
    hasTables : doc.metadata?.hasTables  ?? false,
    hasImages : doc.metadata?.hasImages  ?? false,
    preview   : (doc.pageContent || '').slice(0, 300)
  }));

  return { answer, chunks };
}

// ============================================================
// DEBUG ANSWER
// ============================================================

export async function debugAnswer(ragData, userQuestion, options = { topK: 5 }) {
  console.log('\n========== DEBUG MODE ==========');
  console.log(`Query: "${userQuestion}"`);

  const retrievedDocs = await queryRAG(ragData, userQuestion, options.topK);

  console.log(`\nFull chunk details (${retrievedDocs.length} chunks):\n`);
  retrievedDocs.forEach((doc, idx) => {
    console.log(`--- Chunk ${idx + 1} ---`);
    console.log(`Heading    : ${doc.metadata?.heading    || 'N/A'}`);
    console.log(`Page       : ${doc.metadata?.page       || 'N/A'}`);
    console.log(`ChunkIndex : ${doc.metadata?.chunkIndex ?? 'N/A'}`);
    console.log(`Type       : ${doc.metadata?.type       || 'N/A'}`);
    console.log(`Length     : ${doc.metadata?.length     || doc.pageContent?.length || 0} chars`);
    console.log(`HasTables  : ${doc.metadata?.hasTables  ?? false}`);
    console.log(`HasImages  : ${doc.metadata?.hasImages  ?? false}`);
    console.log(`Full text  :\n${doc.pageContent}`);
    console.log('');
  });

  const { answer, chunks } = await answerWithRAG(ragData, userQuestion, options);

  console.log('\n========== MODEL ANSWER ==========');
  console.log(answer);
  console.log('==================================\n');

  return { answer, chunks };
}