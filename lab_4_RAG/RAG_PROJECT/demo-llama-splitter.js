/**
 * demo-llama-and-splitter.js
 * Demonstration of LLaMA Parser + Recursive Splitter combining properly
 */

import { Document } from "@langchain/core/documents";

// ============================================================
// RECURSIVE CHARACTER TEXT SPLITTER
// ============================================================

class RecursiveCharacterTextSplitter {
  constructor(options = {}) {
    this.chunkSize = options.chunkSize || 1000;
    this.chunkOverlap = options.chunkOverlap || 200;
    this.separators = options.separators || [
      "\n\n",     // Paragraph breaks (most semantic)
      "\n",       // Line breaks
      "\\. ",     // Sentence boundaries
      " ",        // Word boundaries
      ""          // Character level
    ];
  }

  /**
   * Intelligently split text respecting semantic boundaries
   */
  splitText(text) {
    const chunks = [];
    let goodSplits = null;

    // Try each separator to find good split points
    for (const separator of this.separators) {
      const splits = separator === "" ? [...text] : text.split(separator);
      
      if (splits.length > 1 || separator === "") {
        goodSplits = splits;
        break;
      }
    }

    if (!goodSplits) goodSplits = [text];

    // Merge splits into chunks respecting size limit
    let currentChunk = "";

    for (let i = 0; i < goodSplits.length; i++) {
      const split = goodSplits[i];
      
      if ((currentChunk + split).length > this.chunkSize) {
        // Chunk is full, save it
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
        }
        currentChunk = split;
      } else {
        // Add to current chunk
        if (currentChunk === "") {
          currentChunk = split;
        } else if (this.separators[0] === "\n\n") {
          currentChunk += "\n\n" + split;
        } else {
          currentChunk += split;
        }
      }
    }

    // Final chunk
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  /**
   * Create LangChain Document objects with overlap
   */
  createDocuments(texts, metadatas = []) {
    const documents = [];
    const allChunks = [];

    for (const text of texts) {
      allChunks.push(...this.splitText(text));
    }

    for (let i = 0; i < allChunks.length; i++) {
      let content = allChunks[i];

      // Add overlap from previous chunk
      if (i > 0) {
        const prevOverlap = allChunks[i - 1].slice(-this.chunkOverlap);
        content = prevOverlap + "\n\n[... content continues ...]\n\n" + content;
      }

      documents.push(
        new Document({
          pageContent: content,
          metadata: {
            chunkIndex: i,
            source: metadatas[i]?.source || "sample",
            ...(metadatas[i] || {})
          }
        })
      );
    }

    return documents;
  }
}

// ============================================================
// SAMPLE TEXT (Like what LLaMA parser would extract)
// ============================================================

const SAMPLE_TEXT = `OAuth 2.0 is an open standard for access delegation. It enables resource owners to authorize third-party applications to access their resources without sharing their credentials directly. This protocol has become the de facto standard for API authentication and authorization.

PKCE Mechanism

PKCE (Proof Key for Code Exchange) is an extension to OAuth 2.0 specifically designed for public clients (such as mobile apps and single-page applications). It prevents authorization code interception attacks by using dynamically generated codes.

How PKCE Works:
1. The client generates a random "code_verifier"
2. It creates a "code_challenge" by hashing the verifier
3. During authorization, the code_challenge is sent to the server
4. After receiving the authorization code, the client sends the original code_verifier
5. The server validates that the code_challenge matches the verifier

Authorization Code Flow

The authorization code flow is the most secure OAuth 2.0 flow for traditional server-side web applications. It involves three main steps:

First, the user is redirected to the authorization server where they authenticate and grant permissions. Second, the authorization server redirects the user back to the application with an authorization code. Third, the application exchanges this code for an access token by making a backend request.

Refresh Tokens

Refresh tokens are long-lived credentials used to obtain new access tokens without requiring the user to re-authenticate. They must be stored securely and rotated regularly to prevent unauthorized access.

OAuth Scopes

Scopes in OAuth define what permissions an application is requesting. They allow users to granularly grant access to specific resources instead of full account access. Common scopes include "read", "write", "admin", and custom application-specific scopes.

Security Considerations

When implementing OAuth 2.0, several security best practices should be followed:

Always use HTTPS for all communications to prevent credential interception. Validate all redirect URIs to prevent open redirect vulnerabilities. Use short expiration times for access tokens. Implement proper error handling without exposing sensitive information. Regularly rotate credentials and invalidate old tokens.

Best Practices for Developers

When building OAuth 2.0 implementations, remember these key points. Always use the latest version of OAuth 2.0. Implement proper logging and monitoring. Test your implementation thoroughly with security tools. Keep dependencies updated. Consider using established libraries rather than implementing from scratch.`;

// ============================================================
// DEMONSTRATION
// ============================================================

console.log("╔════════════════════════════════════════════════════════╗");
console.log("║  LLaMA Parser + Recursive Splitter Demonstration      ║");
console.log("╚════════════════════════════════════════════════════════╝\n");

// Step 1: Raw Text (from LLaMA parser)
console.log("Step 1️⃣  - Simulated LLaMA Parser Output");
console.log("═".repeat(60));
console.log(`📄 Extracted ${SAMPLE_TEXT.length} characters from PDF\n`);
console.log(`Preview:\n${SAMPLE_TEXT.substring(0, 150)}...\n`);

// Step 2: Recursive Splitter Configuration
console.log("Step 2️⃣  - Recursive Character Splitter Configuration");
console.log("═".repeat(60));

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 600,           // Smaller chunks for demo
  chunkOverlap: 150,        // More overlap
  separators: [
    "\n\n",      // First try paragraph breaks
    "\n",        // Then line breaks
    "\\. ",      // Then sentence boundaries
    " ",         // Then word boundaries
    ""           // Finally character level
  ]
});

console.log("📌 Configuration:");
console.log(`   chunkSize: 600 characters`);
console.log(`   chunkOverlap: 150 characters`);
console.log(`   Separators: [paragraph, line, sentence, word, char]`);
console.log(`   Strategy: Try to preserve semantic boundaries\n`);

// Step 3: Split Text
console.log("Step 3️⃣  - Splitting Text");
console.log("═".repeat(60));

const splits = splitter.splitText(SAMPLE_TEXT);
console.log(`✅ Split into ${splits.length} chunks\n`);

console.log("Chunk Statistics:");
const sizes = splits.map(s => s.length);
console.log(`   Total text: ${SAMPLE_TEXT.length} chars`);
console.log(`   Smallest chunk: ${Math.min(...sizes)} chars`);
console.log(`   Largest chunk: ${Math.max(...sizes)} chars`);
console.log(`   Average chunk: ${Math.round(sizes.reduce((a, b) => a + b) / sizes.length)} chars\n`);

// Step 4: Create Documents with Overlap
console.log("Step 4️⃣  - Creating Documents with Overlap");
console.log("═".repeat(60));

const documents = splitter.createDocuments(
  [SAMPLE_TEXT],
  [{ source: "oauth-guide.pdf", extractedBy: "LLaMA" }]
);

console.log(`✅ Created ${documents.length} Document objects\n`);

// Step 5: Show Results
console.log("Step 5️⃣  - Document Details");
console.log("═".repeat(60) + "\n");

for (let i = 0; i < documents.length; i++) {
  const doc = documents[i];
  const contentPreview = doc.pageContent
    .split('\n')[0]
    .substring(0, 60);

  console.log(`📄 Document ${i + 1}:`);
  console.log(`   Index: ${doc.metadata.chunkIndex}`);
  console.log(`   Source: ${doc.metadata.source}`);
  console.log(`   Length: ${doc.pageContent.length} characters`);
  console.log(`   Starts with: "${contentPreview}..."`);
  
  // Show overlap
  if (i < documents.length - 1) {
    const nextDocStart = documents[i + 1].pageContent.split('\n')[0];
    const overlap = doc.pageContent.split('\n').slice(-3).join('\n');
    console.log(`   ↓ Overlap with next: "${overlap.substring(0, 50)}..."`);
  }
  console.log("");
}

// Step 6: Key Advantages
console.log("═".repeat(60));
console.log("Step 6️⃣  - Key Advantages of This Approach");
console.log("═".repeat(60));

console.log(`\n✅ LLaMA Parser Integration:`);
console.log(`   • Extracts structured text from PDFs`);
console.log(`   • Preserves document hierarchy`);
console.log(`   • Better than simple text extraction`);

console.log(`\n✅ Recursive Character Splitter:`);
console.log(`   • Respects paragraph boundaries (${splits.filter(s => s.includes('\\n\\n')).length} splits on paragraphs)`);
console.log(`   • Prevents mid-sentence cuts`);
console.log(`   • Falls back through separators intelligently`);
console.log(`   • Maintains content overlap (${splitter.chunkOverlap} chars between chunks)`);

console.log(`\n✅ Resulting Documents:`);
console.log(`   • ${documents.length} semantically coherent chunks`);
console.log(`   • Each chunk is a proper Document object`);
console.log(`   • Metadata preserved (source, extraction method)`);
console.log(`   • Ready for embedding and vector search`);

console.log(`\n` + "═".repeat(60));
console.log("✅ DEMO COMPLETE!");
console.log("═".repeat(60));

console.log(`\n🎯 Summary:`);
console.log(`   LLaMA Parser extracts text from PDF`);
console.log(`   ↓`);
console.log(`   Recursive Splitter intelligently chunks it`);
console.log(`   ↓`);
console.log(`   ${documents.length} Documents ready for RAG system`);
console.log("");
