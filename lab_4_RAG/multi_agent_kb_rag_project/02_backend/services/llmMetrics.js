const COMPLETION_MODEL_PRICING_USD_PER_1K = {
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4.1-mini': { input: 0.0004, output: 0.0016 },
  'gpt-4.1': { input: 0.002, output: 0.008 },
  'gpt-4o': { input: 0.0025, output: 0.01 },
};

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundCurrency(value) {
  return Number(toNumber(value, 0).toFixed(6));
}

function resolveCompletionPricing(model = '') {
  const normalized = String(model || '').trim().toLowerCase();
  if (!normalized) return null;
  if (COMPLETION_MODEL_PRICING_USD_PER_1K[normalized]) {
    return COMPLETION_MODEL_PRICING_USD_PER_1K[normalized];
  }
  const prefixMatch = Object.entries(COMPLETION_MODEL_PRICING_USD_PER_1K)
    .find(([known]) => normalized.startsWith(known));
  return prefixMatch ? prefixMatch[1] : null;
}

export function estimateCompletionCostUsd({ model = '', promptTokens = 0, completionTokens = 0 } = {}) {
  const pricing = resolveCompletionPricing(model);
  if (!pricing) return null;
  const inputCost = (toNumber(promptTokens, 0) / 1000) * pricing.input;
  const outputCost = (toNumber(completionTokens, 0) / 1000) * pricing.output;
  return roundCurrency(inputCost + outputCost);
}

export function createLlmCallMetric({
  label = '',
  model = '',
  promptTokens = 0,
  completionTokens = 0,
  totalTokens = null,
  estimatedCostUsd = null,
} = {}) {
  const normalizedPromptTokens = toNumber(promptTokens, 0);
  const normalizedCompletionTokens = toNumber(completionTokens, 0);
  const normalizedTotalTokens = totalTokens != null
    ? toNumber(totalTokens, normalizedPromptTokens + normalizedCompletionTokens)
    : (normalizedPromptTokens + normalizedCompletionTokens);
  const computedCost = estimatedCostUsd != null
    ? roundCurrency(estimatedCostUsd)
    : estimateCompletionCostUsd({
      model,
      promptTokens: normalizedPromptTokens,
      completionTokens: normalizedCompletionTokens,
    });

  return {
    label: String(label || '').trim() || 'llm_call',
    model: String(model || '').trim() || null,
    promptTokens: normalizedPromptTokens,
    completionTokens: normalizedCompletionTokens,
    totalTokens: normalizedTotalTokens,
    estimatedCostUsd: computedCost,
  };
}

export function metricFromChatCompletionResponse(response, { label = '' } = {}) {
  const usage = response?.usage || {};
  return createLlmCallMetric({
    label,
    model: response?.model || null,
    promptTokens: usage?.prompt_tokens || 0,
    completionTokens: usage?.completion_tokens || 0,
    totalTokens: usage?.total_tokens || null,
  });
}

function toCallArray(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.filter(Boolean);
  if (Array.isArray(input.calls)) return input.calls.filter(Boolean);
  if (input.label || input.model || input.totalTokens != null) return [input];
  return [];
}

export function buildLlmMetrics(calls = []) {
  const normalizedCalls = toCallArray(calls).map((call) => createLlmCallMetric(call));
  const summary = normalizedCalls.reduce((acc, call) => {
    acc.callCount += 1;
    acc.promptTokens += toNumber(call.promptTokens, 0);
    acc.completionTokens += toNumber(call.completionTokens, 0);
    acc.totalTokens += toNumber(call.totalTokens, 0);
    acc.estimatedCostUsd += toNumber(call.estimatedCostUsd, 0);
    return acc;
  }, {
    callCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
  });

  summary.estimatedCostUsd = roundCurrency(summary.estimatedCostUsd);
  return {
    calls: normalizedCalls,
    summary,
  };
}

export function emptyLlmMetrics() {
  return buildLlmMetrics([]);
}

export function combineLlmMetrics(...collections) {
  const calls = collections.flatMap((collection) => toCallArray(collection));
  return buildLlmMetrics(calls);
}