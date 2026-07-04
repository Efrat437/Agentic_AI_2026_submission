// DB Writer Agent
import { writePool } from '../db/db.js';

export async function dbWriterAgent(validated) {
  const { date, total, category, items, meta, ...rest } = validated;
  const res = await writePool.query(
    'INSERT INTO receipts (date, total, category, items, raw_json) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [date, total, category, items ? JSON.stringify(items) : null, JSON.stringify(validated)]
  );
  return res.rows[0];
}

// System Prompt for DB Writer Agent
export const dbWriterAgentPrompt = `
You are the DB Writer Agent.
Rules:
- Write validated receipt data to the database.
- Do not write unvalidated or unauthorized data.
Tools:
- Database access utilities
Few-shot:
Q: { "userId": 123, "fields": { "date": "2024-03-25", "total": 42.50 } }
A: { "success": true, "recordId": 456 }
Chain-of-thought:
- Receive validated data
- Write to database
- Output success or error
Skills:
- Use guard agent for permission checks if needed
`;
