// Local government workflow
// Orchestrates reusable steps for local-government request flows.

module.exports = async function localGovFlowSkill(params, context) {
  const memoryResult = await context.agents.memory(params.memory, context);
  const actionResult = await context.agents.action(params.action, context);
  const requestResult = await context.agents.request(params.request, context);
  return { memoryResult, actionResult, requestResult };
};