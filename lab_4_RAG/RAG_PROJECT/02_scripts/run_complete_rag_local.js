import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { OpenAIEmbeddings } from "@langchain/openai";
import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";
import { BM25Retriever } from "@langchain/community/retrievers/bm25";
import { EnsembleRetriever } from "langchain/retrievers/ensemble";
import { CrossEncoderReranker } from "langchain/retrievers/document_compressors/cross_encoder";
import { ContextualCompressionRetriever } from "langchain/retrievers/contextual_compression";
import pkg from "pg";

const { Pool } = pkg;
const DATABASE_URL = process.env.DATABASE_URL;

// -----------------------------
// Build RAG
// -----------------------------
export async function buildQAuthRAG(pdfPath) {

  // Load PDF
  const loader = new PDFLoader(pdfPath);
  const rawDocs = await loader.load();

  // Split
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 800,
    chunkOverlap: 100
  });

  const docs = await splitter.splitDocuments(rawDocs);

  // Embeddings
  const embeddings = new OpenAIEmbeddings();

  const pool = new Pool({
    connectionString: DATABASE_URL
  });

  // Vector Store
  const vectorStore = await PGVectorStore.fromDocuments(
    docs,
    embeddings,
    {
      pool,
      tableName: "rag_documents"
    }
  );

  // Semantic Retriever (החשוב)
  const semanticRetriever = vectorStore.asRetriever({
    k: 10
  });

  // BM25 Retriever
  const bm25Retriever = BM25Retriever.fromDocuments(docs);
  bm25Retriever.k = 10;

  // Ensemble (Hybrid 0.7 / 0.3)
  const ensembleRetriever = new EnsembleRetriever({
    retrievers: [semanticRetriever, bm25Retriever],
    weights: [0.7, 0.3]
  });

  // Cross Encoder Reranker
  const reranker = new CrossEncoderReranker({
    model: "cross-encoder/ms-marco-MiniLM-L-6-v2",
    topK: 5
  });

  // Compression Layer (Hybrid → Rerank)
  const compressionRetriever =
    new ContextualCompressionRetriever({
      baseRetriever: ensembleRetriever,
      baseCompressor: reranker
    });

  return {
    retriever: compressionRetriever
  };
}

// -----------------------------
// Query
// -----------------------------
export async function queryRAG(ragData, query) {
  const results =
    await ragData.retriever.invoke(query);

  return results;
}