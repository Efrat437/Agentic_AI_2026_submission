// Multi-tool orchestrator
// Coordinates execution of multiple tool or agent calls in sequence.

module.exports = async function multiToolOrchestrator(plan, context) {
  const results = [];
  for (const step of plan) {
    if (context.permissionSkill && !(await context.permissionSkill(step.tool, context))) {
      results.push({ tool: step.tool, error: 'Permission denied' });
      continue;
    }
    if (context.agents && context.agents[step.tool]) {
      const result = await context.agents[step.tool](step.params, context);
      results.push({ tool: step.tool, result });
    } else {
      results.push({ tool: step.tool, error: 'Tool not found' });
    }
  }
  return results;
};