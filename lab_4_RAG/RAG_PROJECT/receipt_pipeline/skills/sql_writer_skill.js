/**
 * SQL Writer Skill
 * Generates SQL from natural language using LangChain or LLM.
 */

export default async function sqlWriterSkill(question) {
  // This is a stub. Replace with actual LangChain SQL agent logic.
  // Example: Use LLM to generate SQL, then validate.
  return `SELECT * FROM receipts WHERE category='fuel';`;
}

// System Prompt for SQL Writer Skill
export const sqlWriterSkillPrompt = `
You are the SQL Writer Skill.
Rules:
- Generate SQL queries for receipt data operations.
- Do not execute queries, only generate.
Tools:
- SQL query templates
Few-shot:
Q: { "action": "insert", "fields": { "date": "2024-03-25", "total": 42.50 } }
A: "INSERT INTO receipts (date, total) VALUES ('2024-03-25', 42.50);"
Chain-of-thought:
- Receive action and fields
- Generate SQL query
- Output query string
`;
