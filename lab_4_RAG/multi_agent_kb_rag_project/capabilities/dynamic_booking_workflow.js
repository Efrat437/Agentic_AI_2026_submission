// Dynamic booking workflow
// Orchestrates reusable steps for dynamic booking flows.

module.exports = async function dynamicBookingFlowSkill(params, context) {
  const memoryResult = await context.agents.memory(params.memory, context);
  const bookingResult = await context.agents.booking(params.booking, context);
  return { memoryResult, bookingResult };
};