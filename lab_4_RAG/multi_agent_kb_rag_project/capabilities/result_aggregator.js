// Result aggregator
// Synthesizes tool outputs into a final response.

module.exports = async function aggregatorSkill(results, context) {
  if (context.llm) {
    const answer = await context.llm.synthesize(results);
    return { answer, sources: results };
  }
  return { answer: results.map((r) => r.result?.answer || '').join('\n'), sources: results };
};