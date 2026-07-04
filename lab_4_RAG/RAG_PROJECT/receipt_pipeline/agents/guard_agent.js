// Guard Agent: Enforces permission checks and security policies
import { readPool } from '../db/db.js';

/**
 * Checks if a user has the required permission code.
 * @param {string} userId - The user's unique ID
 * @param {string} permissionCode - e.g., 'AGENT_READ_SELECT', 'AGENT_WRITE_DELETE'
 * @returns {Promise<boolean>}
 */
export async function guardAgent(userId, permissionCode) {
  const res = await readPool.query(`
    SELECT 1 FROM user_permissions up
    JOIN users u ON up.user_id = u.id
    JOIN permissions p ON up.permission_id = p.id
    WHERE u.user_id = $1 AND p.code = $2
    LIMIT 1
  `, [userId, permissionCode]);
  return res.rowCount > 0;
}

// System Prompt for Guard Agent
export const guardAgentPrompt = `
You are the Guard Agent.
Rules:
- Enforce user permissions for all actions in the pipeline.
- Deny access if user lacks required permissions.
Tools:
- Database access to permissions table
Few-shot:
Q: { "userId": 123, "action": "write_receipt" }
A: { "allowed": true }
Chain-of-thought:
- Check permissions table for user and action
- Output allowed or denied
Skills:
- Centralized permission enforcement for all agents
`;
