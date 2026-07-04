// Smart result aggregator
// Deduplicates, ranks, and optionally applies business logic to multi-tool results.

module.exports = async function smartAggregator(results, context) {
  const seen = new Set();
  const deduped = [];
  for (const r of results) {
    const text = r.result && r.result.answer ? r.result.answer : JSON.stringify(r.result);
    if (!seen.has(text)) {
      seen.add(text);
      deduped.push(r);
    }
  }
  if (context.businessLogic) {
    return context.businessLogic(deduped, context);
  }
  return deduped;
};