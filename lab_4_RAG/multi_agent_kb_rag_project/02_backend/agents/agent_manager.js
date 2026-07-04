import { chatCompletion } from '../services/llmService.js';
import { buildAgentSecurityPromptFramework } from './prompt_security_framework.js';

export async function runAgentManagerFlow({ userRequest, context = {} }) {
  const systemPromptBase = `You are an agent_manager with privileged database access.
You can:
1. CREATE_USER: Create a new user with firstName, lastName, username, password
2. DELETE_USER: Permanently remove a user by userId or username
3. ACTIVATE_USER: Re-activate a previously deactivated user by userId or username
4. DEACTIVATE_USER: Temporarily disable a user account by userId or username
5. ASSIGN_PERMISSION: Grant a permission code to a user

When the user asks to create, delete, activate, or deactivate a user, respond with a JSON action.
Examples:
- User says "create me a new user, first name shiran last name oren, password 1-10"
  Response: {"action":"CREATE_USER","firstName":"shiran","lastName":"oren","username":"shiran_oren","password":"1-10","createdBy":"agent_manager"}
- User says "delete user shiran"
  Response: {"action":"DELETE_USER","username":"shiran","deletedBy":"agent_manager"}
- User says "activate user shiran" or "re-enable user shiran"
  Response: {"action":"ACTIVATE_USER","username":"shiran","activatedBy":"agent_manager"}
- User says "deactivate user shiran" or "suspend user shiran"
  Response: {"action":"DEACTIVATE_USER","username":"shiran","deactivatedBy":"agent_manager"}

Always include required fields. Respond with ONLY valid JSON.`;
  const systemPrompt = `${systemPromptBase}

${buildAgentSecurityPromptFramework({
  agentName: 'agent_manager',
  goal: 'Transform manager-intent requests into strict JSON actions for user/permission administration.',
  tools: [
    'CREATE_USER action contract',
    'DELETE_USER action contract',
    'ACTIVATE_USER action contract',
    'DEACTIVATE_USER action contract',
    'ASSIGN_PERMISSION action contract',
  ],
  outputContract: 'Respond with ONLY valid JSON for one manager action.',
})}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: String(userRequest || '').trim() },
  ];

  const result = await chatCompletion({
    messages,
    temperature: 0.3,
    model: 'gpt-3.5-turbo',
  });

  const responseText = result?.choices?.[0]?.message?.content || '';

  try {
    const action = JSON.parse(responseText);
    return {
      ok: true,
      action: action.action,
      params: action,
      rawResponse: responseText,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'parse-failed',
      rawResponse: responseText,
      error: String(err?.message || err),
    };
  }
}

export async function runAgentStatsFlow({ query, context = {} }) {
  const systemPromptBase = `You are agent_stats with access to audit and query logs.
You can retrieve:
1. Logged-in users in current month
2. Audit login summary (by success/failure)
3. Query log summary (by pool and command)

When asked for statistics, respond with a JSON request for the appropriate endpoint.
Examples:
- User asks "How many users logged in this month?"
  Response: {"stat":"logged_in_users_current_month"}
- User asks "Show me login attempts summary"
  Response: {"stat":"audit_summary","days":30}
- User asks "What queries were run?"
  Response: {"stat":"query_log_summary","limit":50}

Respond with ONLY valid JSON.`;
  const systemPrompt = `${systemPromptBase}

${buildAgentSecurityPromptFramework({
  agentName: 'agent_stats',
  goal: 'Map statistics questions to strict stats endpoint request JSON.',
  tools: [
    'logged_in_users_current_month',
    'audit_summary',
    'query_log_summary',
  ],
  outputContract: 'Respond with ONLY valid JSON for one stats request.',
})}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: String(query || '').trim() },
  ];

  const result = await chatCompletion({
    messages,
    temperature: 0.3,
    model: 'gpt-3.5-turbo',
  });

  const responseText = result?.choices?.[0]?.message?.content || '';

  try {
    const request = JSON.parse(responseText);
    return {
      ok: true,
      statType: request.stat,
      params: request,
      rawResponse: responseText,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'parse-failed',
      rawResponse: responseText,
      error: String(err?.message || err),
    };
  }
}
