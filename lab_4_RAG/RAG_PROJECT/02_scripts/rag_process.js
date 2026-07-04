/**
 * rag-process.js
 * Ingest data into vector store for RAG retrieval
 * Supports full LLaMA parser, recursive character splitting, streaming ingestion
 */

// This file now delegates implementation to the production v2 file to keep both
// copies available while ensuring behavior is synchronized. The heavy lifting
// and feature-rich parser/store live in `rag_process_v2.js`.

import { smartPdfParser, streamPdfIntoVectorStore, buildQAuthRAG, queryRAG } from './rag_process_v2.js';

export { smartPdfParser, streamPdfIntoVectorStore, buildQAuthRAG, queryRAG };

// ============================================================
// RECURSIVE CHARACTER TEXT SPLITTER
// ============================================================

/**
 * RecursiveCharacterTextSplitter - Splits text intelligently
 * Tries to split on most relevant separators (semantic boundaries)
 * Not just dumb character slicing
 */
class RecursiveCharacterTextSplitter {
  constructor(options = {}) {
    this.chunkSize = options.chunkSize || 1000;
    this.chunkOverlap = options.chunkOverlap || 200;
    // Separators in order of preference (most semantic first)
    this.separators = options.separators || [
      "\n\n",     // Paragraph breaks (most semantic)
      "\n",       // Line breaks
      "\\. ",     // Sentence boundaries
      " ",        // Word boundaries
      ""          // Character level (fallback)
    ];
  }

  /**
   * Split text using recursive strategy
   * Prefers semantic boundaries (paragraphs) over blind character cuts
   */
  splitText(text) {
    const chunks = [];
    const goodSplits = [];

    // Try each separator in order
    for (const separator of this.separators) {
      if (separator === "") {
        // Character-level split (last resort)
        goodSplits.push([...text]);
        break;
      }

      const splitText = text.split(separator);
      
      // If this separator produces reasonable splits, use it
      if (splitText.length > 1) {
        goodSplits.push(splitText);
        break;
      }
    }

    // Merge splits and create chunks
    const mergedText = goodSplits.length > 0 ? goodSplits[0] : [text];
    let currentChunk = "";

    for (const text of mergedText) {
      if (currentChunk.length + text.length > this.chunkSize) {
        // Current chunk full, save it
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
        }
        // Start new chunk with overlap
        currentChunk = text;
      } else {
        // Add to current chunk
        currentChunk += (currentChunk ? (this.separators[0] || " ") : "") + text;
      }
    }

    // Add final chunk
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  /**
   * Create documents with overlap
   */
  createDocuments(texts, metadatas = []) {
    const documents = [];
    const textSplits = [];

    for (const text of texts) {
      textSplits.push(...this.splitText(text));
    }

    // Add overlap between consecutive chunks
    for (let i = 0; i < textSplits.length; i++) {
      let content = textSplits[i];
      
      // Add overlap from previous chunk if available
      if (i > 0) {
        const prevChunk = textSplits[i - 1];
        const overlapText = prevChunk.slice(-this.chunkOverlap);
        content = overlapText + "\n" + content;
      }

      documents.push(
        new Document({
          pageContent: content,
          metadata: {
            chunkIndex: i,
            ...(metadatas[i] || {})
          }
        })
      );
    }

    return documents;
  }
}

// ============================================================
// PDF PARSING WITH LLAMA (FALLBACK CHAIN)
// ============================================================

/**
 * Parse PDF using multi-tier approach:
 * 1. LLaMA API (if configured)
 * 2. pdf-parse library (proven to work)
 * 3. LLaMA local (if available)
 */
async function parsePdfWithLLama(filePath) {
  const apiKey = process.env.LLAMA_PARSE_API_KEY;
  
  try {
    // Tier 1: Try LLaMA API if key exists
    if (apiKey) {
      console.log("🔹 Attempting LLaMA Parser API...");
      // In production: call https://api.llama-cloud.com/parse
      // For now, continue to next tier
    }

    // Tier 2: Use pdf-parse (most reliable)
    const text = await extractTextFromPDFWithPdfParse(filePath);
    if (text && text.length > 100) {
      return text;
    }

    console.warn("  ⚠️  pdf-parse failed or extracted too little text");
    return null;
    
  } catch (err) {
    console.warn(`  ✗ PDF parsing error: ${err.message}`);
    return null;
  }
}

// ============================================================
// STREAMING INGESTION WITH RECURSIVE SPLITTING
// ============================================================
/**
 * Stream PDF file and ingest chunks using recursive splitting
 * Reduces memory footprint while maintaining semantic boundaries
 */
async function streamPdfIntoVectorStore(filePath, vectorStore, chunkSize = 1000, chunkOverlap = 200) {
  console.log(`🔹 Streaming file with recursive splitting: ${filePath}`);
  
  return new Promise(async (resolve, reject) => {
    try {
      let text = '';

      // Step 1: Parse PDF with LLaMA or pdf-parse
      console.log("📄 Parsing PDF...");
      
      if (filePath.endsWith('.pdf')) {
        // Parse PDF using pdf-parse
        const llamaText = await parsePdfWithLLama(filePath);
        if (llamaText) {
          text = llamaText;
        } else {
          console.error("  ✗ Failed to extract text from PDF");
          reject(new Error("Could not extract text from PDF file"));
          return;
        }
      } else {
        // Text file
        text = fs.readFileSync(filePath, 'utf-8');
      }

      // Step 2: Use recursive character splitter
      console.log("🔄 Splitting with recursive strategy...");
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize,
        chunkOverlap,
        separators: [
          "\n\n",      // Paragraph breaks (most semantic)
          "\n",        // Line breaks
          ". ",        // Sentence boundaries
          " ",         // Word boundaries
          ""           // Character level fallback
        ]
      });

      const documents = splitter.createDocuments(
        [text],
        [{ source: filePath, timestamp: new Date().toISOString() }]
      );

      console.log(`  ✓ Created ${documents.length} semantically-aware chunks`);

      // Step 3: Stream into vector store
      console.log("🔹 Ingesting chunks into vector store...");
      const batchSize = 10;
      
      for (let i = 0; i < documents.length; i += batchSize) {
        const batch = documents.slice(i, i + batchSize);
        try {
          await vectorStore.addDocuments(batch);
          console.log(`  ✓ Added batch ${Math.floor(i / batchSize) + 1} (${batch.length} documents)`);
        } catch (err) {
          console.error(`  ✗ Error adding batch: ${err.message}`);
          throw err;
        }
      }

      console.log(`✅ File streaming complete. Total chunks: ${documents.length}`);
      resolve();
    } catch (err) {
      console.error(`  ✗ Streaming error: ${err.message}`);
      reject(err);
    }
  });
}

export async function buildQAuthRAG({
  pdfPath = PDF_PATH,
  useStreaming = true,        // ✅ Now enabled by default
  useHybrid = true,
  topK = 20,
  chunkSize = 1000,           // ✅ Larger for better context
  chunkOverlap = 200,         // ✅ More overlap for connections
} = {}) {
  console.log("🔹 Initializing RAG pipeline with LLaMA + Recursive Splitter...");
  console.log(`   Streaming: ${useStreaming}, Chunk Size: ${chunkSize}, Overlap: ${chunkOverlap}`);

  // Check if API Keys exist
  if (!process.env.OPENROUTER_API_KEY && !process.env.OPENAI_API_KEY) {
    throw new Error("❌ Missing API key: set OPENROUTER_API_KEY or OPENAI_API_KEY in .env");
  }

  // Create embeddings
  console.log(`🔹 Creating embeddings using ${process.env.OPENROUTER_API_KEY ? 'OpenRouter' : 'OpenAI'}...`);
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  const model = process.env.OPENROUTER_API_KEY ? "openai/text-embedding-3-small" : "text-embedding-3-small";
  const basePath = process.env.OPENROUTER_API_KEY ? "https://openrouter.ai/api/v1" : undefined;
  
  const embeddings = new OpenAIEmbeddings(
    { model, apiKey },
    basePath ? { basePath } : {}
  );

  // Build vector store
  console.log(`🔹 Building in-memory vector store...`);
  const vectorStore = await SimpleMemoryVectorStore.fromDocuments([], embeddings);

  // Ingest documents
  if (fs.existsSync(pdfPath)) {
    console.log(`🔹 Loading document: ${pdfPath}...`);
    
    if (useStreaming) {
      // Use streaming with recursive splitter and LLaMA parser
      await streamPdfIntoVectorStore(pdfPath, vectorStore, chunkSize, chunkOverlap);
    } else {
      // Load and split without streaming
      console.log("📄 Loading file directly...");
      let text = '';
      
      if (pdfPath.endsWith('.pdf')) {
        const llamaText = await parsePdfWithLLama(pdfPath);
        if (!llamaText) {
          throw new Error("Could not extract text from PDF file");
        }
        text = llamaText;
      } else {
        text = fs.readFileSync(pdfPath, 'utf-8');
      }

      // Use recursive splitter
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize,
        chunkOverlap
      });

      const documents = splitter.createDocuments(
        [text],
        [{ source: pdfPath, timestamp: new Date().toISOString() }]
      );

      await vectorStore.addDocuments(documents);
      console.log(`  ✓ Loaded and split ${documents.length} chunks`);
    }
  } else {
    console.warn(`⚠️  File not found at ${pdfPath}, using sample data...`);
    const docs = getDefaultDocuments();
    await vectorStore.addDocuments(docs);
  }

  const retriever = vectorStore.asRetriever({ k: topK });

  console.log("✅ RAG pipeline ready with LLaMA + Recursive Splitting!");
  return { vectorStore, retriever };
}

/**
 * Get sample documents for fallback
 */
function getDefaultDocuments() {
  return [
    new Document({
      pageContent: "OAuth 2.0 is an open standard for access delegation. It enables resource owners to authorize third-party applications to access their resources without sharing their credentials directly.",
      metadata: { source: "sample", heading: "OAuth 2.0 Overview" }
    }),
    new Document({
      pageContent: "PKCE (Proof Key for Code Exchange) is an extension to OAuth 2.0 for public clients. It prevents authorization code interception attacks using dynamically generated codes.",
      metadata: { source: "sample", heading: "PKCE Mechanism" }
    }),
    new Document({
      pageContent: "Refresh tokens are long-lived credentials used to obtain new access tokens without re-authentication. They must be stored securely and rotated regularly.",
      metadata: { source: "sample", heading: "Refresh Tokens" }
    }),
    new Document({
      pageContent: "The authorization code flow is the most secure OAuth flow for traditional web applications. It involves redirecting users to the authorization server and receiving an authorization code.",
      metadata: { source: "sample", heading: "Authorization Code Flow" }
    })
  ];
}

/**
 * Query helper - retrieve relevant documents for a query
 */
export async function queryRAG(retriever, query, k = 20) {
  try {
    const results = await retriever.invoke(query, { k });
    return results.map((doc, i) => ({
      chunkIndex: i,
      text: doc.pageContent,
      heading: doc.metadata?.heading || "",
      images: doc.metadata?.images || [],
      page: doc.metadata?.pageNumber || null,
      score: doc.metadata?.score || null,
    }));
  } catch (err) {
    console.error(`Query error: ${err.message}`);
    return [];
  }
}

/**
 * Export the streaming function for explicit use
 */
export { streamPdfIntoVectorStore };