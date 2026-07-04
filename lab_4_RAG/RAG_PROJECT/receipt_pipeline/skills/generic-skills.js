// Generic Skills: reusable, domain-agnostic skills for agents
export async function permissionCheckSkill(context) {
  // Check user permissions (stub)
  return context && context.userRole === 'writer';
}

export async function jwtDecodeSkill(token) {
  // Decode JWT and extract claims (stub)
  return { userId: 'demo', permissions: ['read', 'write'] };
}

export async function validationSkill(data) {
  // Validate structure and required fields (stub)
  return { valid: true, missing: [] };
}

// Currency conversion skill: USD <-> NIS (ILS)
export async function currencyExchangeSkill({ amount, from = 'USD', to = 'NIS' }) {
  // Simple fixed rate for demo; in production, use a real API
  const USD_TO_NIS = 3.6;
  const NIS_TO_USD = 1 / USD_TO_NIS;
  if (from === to) return { amount, currency: to };
  if (from === 'USD' && to === 'NIS') return { amount: +(amount * USD_TO_NIS).toFixed(2), currency: 'NIS' };
  if (from === 'NIS' && to === 'USD') return { amount: +(amount * NIS_TO_USD).toFixed(2), currency: 'USD' };
  return { error: 'Unsupported currency conversion' };
}

export default {
  permissionCheckSkill,
  jwtDecodeSkill,
  validationSkill,
  currencyExchangeSkill,
};