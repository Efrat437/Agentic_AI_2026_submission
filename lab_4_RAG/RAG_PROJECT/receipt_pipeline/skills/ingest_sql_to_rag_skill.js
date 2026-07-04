/**
 * Ingest SQL Tables to RAG Skill
 * Converts SQL table rows to text chunks, computes embeddings, and stores in vector DB.
 */
import embeddingSkill from './embedding_skill.js';
import { readPool } from '../db/db.js';

export default async function ingestSqlToRagSkill(tableName) {
  // This is a stub. Implement logic to fetch rows, chunk, embed, and store.
  return true;
}

// System Prompt for Ingest SQL to RAG Skill
export const ingestSQLToRAGSkillPrompt = `
You are the Ingest SQL to RAG Skill.
Rules:
- Ingest SQL data into the RAG (Retrieval-Augmented Generation) pipeline.
- Do not modify original SQL data.
Tools:
- SQL reader
- RAG ingestion utilities
Few-shot:
Q: { "sql": "SELECT * FROM receipts;" }
A: { "ingested": true, "records": 100 }
Chain-of-thought:
- Receive SQL query
- Ingest data into RAG
- Output ingestion result
`;
