import { readPool } from '../db/db.js';

// SQL RAG Agent for receipts
export async function runSQLRAG({ userQuery }) {
  // Handle specific queries for demo
  if (/how many receipts/i.test(userQuery)) {
    const result = await readPool.query('SELECT COUNT(*) AS count FROM receipts');
    const count = result.rows[0]?.count || 0;
    return { answer: count === 1 ? 'I have only one receipt.' : `I have ${count} receipts.` };
  }
  if (/total amount/i.test(userQuery)) {
    const result = await readPool.query('SELECT total, currency FROM receipts ORDER BY created_at DESC LIMIT 1');
    const row = result.rows[0];
    if (row && row.total !== undefined && row.currency) {
      return { answer: `The total amount is ${row.total} ${row.currency}.` };
    } else if (row && row.total !== undefined) {
      return { answer: `The total amount is ${row.total}.` };
    } else {
      return { answer: 'No receipts found.' };
    }
  }
  // Fallback: generic
  return { answer: 'No matching SQL RAG logic for this question.' };
}
