import { reactAgent } from './reactAgent.js';

export async function runToolCallingAgent({ plan = [], userQuery, userId = null } = {}) {
  return reactAgent(plan, userQuery, { userId });
}

export async function runReactExecutionAgent({ plan = [], userQuery, userId = null } = {}) {
  return runToolCallingAgent({ plan, userQuery, userId });
}
