import { readPool } from '../db/db.js';

// Semantic RAG Agent for receipts
export async function runSemanticRAG({ query }) {
  // Only answer if the query is about receipts
  if (!/receipt|total|amount|item|category|date/i.test(query)) {
    return { answer: 'No relevant documents found.' };
  }
  // Example: fallback to SQL for demo
  if (/total amount/i.test(query)) {
    const result = await readPool.query('SELECT total FROM receipts ORDER BY created_at DESC LIMIT 1');
    const total = result.rows[0]?.total;
    return { answer: total !== undefined ? `The total amount is ${total}.` : 'No receipts found.' };
  }
  // Fallback: generic
  return { answer: 'Semantic RAG: No relevant answer found.' };
}
