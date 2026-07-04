// Validator Agent: checks structure and permissions

// Relaxed validator: allow partial/realistic receipt structures for open-source LLMs
import { guardAgent } from './guard_agent.js';

export async function validatorAgent(scored, context = {}) {
  // Structure validation: only require total or date for open-source LLMs
  if (!scored || (!scored.total && !scored.date)) {
    throw new Error('Invalid receipt structure: missing total and date');
  }
  // Permission check using guard agent
  if (context.userId && !(await guardAgent(context.userId, 'AGENT_WRITE_DELETE'))) {
    throw new Error('Permission denied: insufficient privileges');
  }
  return { ...scored, valid: true };
}

// System Prompt for Validator Agent
export const validatorAgentPrompt = `
You are the Validator Agent.
Rules:
- Validate extracted receipt data for correctness and completeness.
- Enforce user permissions using the guard agent.
Tools:
- Validation utilities
- Guard agent for permission checks
Few-shot:
Q: { "userId": 123, "fields": { "date": "2024-03-25", "total": 42.50 } }
A: { "valid": true, "errors": [] }
Chain-of-thought:
- Check user permissions
- Validate fields
- Output validation result
Skills:
- Use guard agent for permission checks
`;
