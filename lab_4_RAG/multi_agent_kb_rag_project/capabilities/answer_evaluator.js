// Answer evaluator
// Assesses result quality and indicates whether a retry is needed.

module.exports = async function evaluatorSkill(answer, context) {
  if (context.llm) {
    const evalResult = await context.llm.evaluate(answer);
    return { ...answer, evalResult, needs_retry: evalResult.needs_retry };
  }
  return { ...answer, needs_retry: !answer.answer };
};