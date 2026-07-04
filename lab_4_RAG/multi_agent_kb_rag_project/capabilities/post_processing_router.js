// Post-processing router
// Applies business rules, redaction, or downstream routing to answers.

module.exports = async function postProcessingRouterSkill(answer, context) {
  if (context.businessRules) {
    return context.businessRules(answer, context);
  }
  return answer;
};