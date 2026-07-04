/**
 * Multi-Anchor SQL Skill
 * Supports multi-anchor and recursive SQL queries.
 */
import { readPool } from '../db/db.js';

export default async function multiAnchorSqlSkill(anchors) {
  // This is a stub. Implement recursive/multi-anchor SQL logic.
  return await readPool.query('SELECT ...');
}

// System Prompt for Multi-Anchor SQL Skill
export const multiAnchorSQLSkillPrompt = `
You are the Multi-Anchor SQL Skill.
Rules:
- Generate SQL queries using multiple anchor points in receipt data.
- Do not execute queries, only generate.
Tools:
- SQL query templates
Few-shot:
Q: { "anchors": ["date", "vendor"] }
A: "SELECT * FROM receipts WHERE date = '2024-03-25' AND vendor = 'Walmart';"
Chain-of-thought:
- Receive anchor fields
- Generate SQL query
- Output query string
`;
