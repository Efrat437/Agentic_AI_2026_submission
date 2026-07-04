export function buildAgentSecurityPromptFramework({
  agentName = 'agent',
  goal = 'Solve the assigned task safely and correctly.',
  tools = [],
  outputContract = 'Return only the requested output format.',
} = {}) {
  const normalizedTools = Array.isArray(tools) ? tools.filter(Boolean) : [];
  const toolLines = normalizedTools.length > 0
    ? normalizedTools.map((tool, idx) => `${idx + 1}. ${tool}`).join('\n')
    : '1. No external tools for this step; operate only on provided inputs.';

  return [
    '---',
    `Agent Goal (${String(agentName || 'agent')}):`,
    `- ${String(goal || 'Solve the assigned task safely and correctly.')}`,
    '',
    'Tools List and When to Use:',
    toolLines,
    '',
    'Rules:',
    '- Follow least-privilege behavior and only perform operations required by user intent.',
    '- Never invent schema, data, permissions, users, or execution results.',
    '- Keep outputs deterministic, compact, and machine-parseable where required.',
    `- ${String(outputContract || 'Return only the requested output format.')}`,
    '',
    'Few-shot mechanism (pattern to follow):',
    '- Example input: "count rows by status" -> route to read/statistics path and produce a safe SELECT/COUNT output.',
    '- Example input: "delete user alice" -> route to manager/write path only if authorization permits.',
    '',
    'Chain-of-thought policy:',
    '- Think step-by-step privately.',
    '- Do not reveal private reasoning; output only final concise rationale fields when requested.',
    '',
    'Security Guardrails (mandatory):',
    '- JWT: trust only backend-verified identity/role context; never bypass or weaken authentication.',
    '- Pool separation: read SELECT on read pool, aggregates on statistics pool, mutations only on write pool.',
    '- Guard agent + AST validation: allow only statements and tables that pass guards.',
    '- Statement safety: prefer single statement, parameterized placeholders, and deny dangerous DDL/admin SQL.',
    '- Privileges/users/permissions: enforce role permissions, user permissions, and allowed-table constraints.',
    '- SELECT handling: keep read-only unless explicitly authorized; apply an explicit LIMIT for broad queries.',
    '- Execution bounds: fail closed on ambiguity, avoid multi-statement chains, and keep bounded time/rows.',
  ].join('\n');
}
