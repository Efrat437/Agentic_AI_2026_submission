import fs from 'fs/promises';
import path from 'path';

const PAYMENT_BOUNDARY_EVIDENCE_DIR = path.resolve(process.cwd(), 'tmp', 'payment-provider-boundary');
const PAYMENT_BOUNDARY_LATEST_PATH = path.join(PAYMENT_BOUNDARY_EVIDENCE_DIR, 'latest.json');
const PAYMENT_HANDOFF_SCHEMA_VERSION = 'handoff-v1';
const TEL_AVIV_REDIRECT_ADAPTER_VERSION = 'tel-aviv-redirect-v1';

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateText(value = '', maxLength = 4000) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 16))}\n...[truncated]`;
}

function safeHost(url = '') {
  try {
    return new URL(String(url || '').trim()).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeObjectEntries(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entryValue]) => [String(key || '').trim(), String(entryValue ?? '').trim()])
      .filter(([key, entryValue]) => key && entryValue)
  );
}

function extractUrlParams(url = '') {
  try {
    return Object.fromEntries(new URL(String(url || '').trim()).searchParams.entries());
  } catch {
    return {};
  }
}

export function extractToken(url = '', params = {}) {
  const mergedParams = {
    ...extractUrlParams(url),
    ...normalizeObjectEntries(params),
  };
  const exactMatch = Object.entries(mergedParams).find(([key, value]) => /^(token|paymenttoken|session|sessionid|sid|reference|ref)$/i.test(String(key || '')) && String(value || '').trim());
  if (exactMatch) return String(exactMatch[1] || '').trim();
  const looseMatch = Object.entries(mergedParams).find(([key, value]) => /(token|session|auth|payment|queue|reference|ref)/i.test(String(key || '')) && String(value || '').trim());
  if (looseMatch) return String(looseMatch[1] || '').trim();
  const pathMatch = String(url || '').match(/(?:token|session|payment|reference)[=/]([A-Za-z0-9._~-]{6,})/i);
  return pathMatch?.[1] ? String(pathMatch[1]).trim() : '';
}

function normalizeRedirectChain(entries = [], fallbackUrl = '') {
  const list = Array.isArray(entries) ? entries : [];
  const normalized = list
    .map((entry) => (typeof entry === 'string' ? entry : entry?.url))
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  if (fallbackUrl) normalized.push(String(fallbackUrl).trim());
  return Array.from(new Set(normalized));
}

function getManualHandoffSeed(payload = {}) {
  if (payload?.handoff && typeof payload.handoff === 'object') return payload.handoff;
  if (payload?.realHandoff && typeof payload.realHandoff === 'object') return payload.realHandoff;
  const hasDirectHandoff = [payload?.handoffUrl, payload?.handoffSourceUrl, payload?.handoffHeaders, payload?.handoffRedirectChain, payload?.handoffParams].some(Boolean);
  if (!hasDirectHandoff) return null;
  return {
    url: payload?.handoffUrl,
    sourceUrl: payload?.handoffSourceUrl,
    headers: payload?.handoffHeaders,
    params: payload?.handoffParams,
    redirectChain: payload?.handoffRedirectChain,
    selectorFingerprints: payload?.selectorFingerprints,
    version: payload?.handoffVersion,
    flow: payload?.handoffFlow,
  };
}

export function normalizePaymentHandoff(payload = {}) {
  const url = String(payload?.url || payload?.paymentUrl || payload?.finalUrl || '').trim();
  const sourceUrl = String(payload?.sourceUrl || payload?.originUrl || payload?.entryUrl || '').trim();
  const params = {
    ...extractUrlParams(url),
    ...normalizeObjectEntries(payload?.params || {}),
  };
  const headers = normalizeObjectEntries(payload?.headers || payload?.requestHeaders || {});
  const redirectChain = normalizeRedirectChain(payload?.redirectChain || payload?.redirects || [], url);
  const selectorFingerprints = Array.isArray(payload?.selectorFingerprints)
    ? payload.selectorFingerprints.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 20)
    : [];
  const sourceHost = safeHost(sourceUrl || redirectChain.find((entry) => /tel-aviv\.gov\.il/i.test(String(entry || ''))) || '');
  const token = String(payload?.token || extractToken(url, params)).trim();
  if (!url && !sourceUrl && !Object.keys(headers).length && !Object.keys(params).length && !redirectChain.length) {
    return null;
  }
  return {
    version: String(payload?.version || PAYMENT_HANDOFF_SCHEMA_VERSION).trim() || PAYMENT_HANDOFF_SCHEMA_VERSION,
    flow: String(payload?.flow || 'redirect').trim() || 'redirect',
    url,
    sourceUrl,
    sourceHost,
    params,
    headers,
    redirectChain,
    selectorFingerprints,
    token: token || null,
    capturedAt: String(payload?.capturedAt || '').trim() || null,
  };
}

function summarizeHandoff(handoff = null) {
  const normalized = normalizePaymentHandoff(handoff || {});
  if (!normalized) return null;
  return {
    url: normalized.url || null,
    sourceUrl: normalized.sourceUrl || null,
    sourceHost: normalized.sourceHost || null,
    flow: normalized.flow || 'redirect',
    version: normalized.version || PAYMENT_HANDOFF_SCHEMA_VERSION,
    token: normalized.token || null,
    headerCount: Object.keys(normalized.headers || {}).length,
    paramCount: Object.keys(normalized.params || {}).length,
    redirectCount: Array.isArray(normalized.redirectChain) ? normalized.redirectChain.length : 0,
    selectorFingerprintCount: Array.isArray(normalized.selectorFingerprints) ? normalized.selectorFingerprints.length : 0,
  };
}

export function validateTelAvivPaymentHandoff({ handoff = null, providerSummary = {} } = {}) {
  const normalized = normalizePaymentHandoff(handoff || {});
  const issues = [];
  const warnings = [];
  if (!normalized?.url) issues.push('handoff-url-missing');
  if (normalized?.url && !/^https?:\/\//i.test(normalized.url)) issues.push('handoff-url-invalid');
  const handoffHost = safeHost(normalized?.url || '');
  const sourceLooksMunicipal = /tel-aviv\.gov\.il$/i.test(normalized?.sourceHost || '') || (normalized?.redirectChain || []).some((entry) => /tel-aviv\.gov\.il/i.test(String(entry || '')));
  if (normalized && !sourceLooksMunicipal) issues.push('handoff-source-not-tel-aviv');
  if (!handoffHost) warnings.push('handoff-host-missing');
  if (handoffHost && /tel-aviv\.gov\.il$/i.test(handoffHost)) warnings.push('handoff-still-municipal-host');
  if (!Object.keys(normalized?.headers || {}).length) warnings.push('handoff-headers-missing');
  if (!Array.isArray(normalized?.redirectChain) || normalized.redirectChain.length < 1) warnings.push('handoff-redirect-chain-missing');
  if (!normalized?.token) warnings.push('handoff-token-missing');
  if (!Array.isArray(normalized?.selectorFingerprints) || normalized.selectorFingerprints.length === 0) warnings.push('selector-fingerprints-missing');
  if (providerSummary?.handoffDetected === false && handoffHost && !/tel-aviv\.gov\.il$/i.test(handoffHost)) {
    warnings.push('provider-summary-handoff-mismatch');
  }
  return {
    isValid: issues.length === 0 && Boolean(normalized?.url),
    issues,
    warnings,
  };
}

function detectProviderKey(host = '', evidenceText = '') {
  const combined = `${String(host || '').toLowerCase()} ${String(evidenceText || '').toLowerCase()}`;
  const provider = [
    { key: 'meshulam', re: /meshulam/ },
    { key: 'payplus', re: /payplus/ },
    { key: 'creditguard', re: /creditguard|cgateway/ },
    { key: 'tranzila', re: /tranzila/ },
    { key: 'pelecard', re: /pelecard/ },
    { key: 'cardcom', re: /cardcom/ },
    { key: 'hyp', re: /hyp\.co\.il|hyp-pay/ },
  ].find((item) => item.re.test(combined));
  if (provider) return provider.key;
  if (host && !/tel-aviv\.gov\.il$/i.test(host)) return 'external-payment-provider';
  return 'tel-aviv';
}

export function summarizePaymentProvider(url = '', pageText = '') {
  const host = safeHost(url);
  const normalizedText = String(pageText || '').toLowerCase();
  return {
    provider: detectProviderKey(host, normalizedText),
    host: host || null,
    handoffDetected: Boolean(host && !/tel-aviv\.gov\.il$/i.test(host)),
    irreversibleBoundaryDetected: /credit|card number|cvv|expiry|payer|id number|תעודת זהות|מספר משלם|כרטיס אשראי|מספר כרטיס|תוקף|cvv/i.test(pageText || ''),
    loginRequired: /sign in|log in|login|authenticate|mydigitel|התחבר|כניסה|הזדהות|אימות/i.test(pageText || ''),
  };
}

function summarizeCookies(cookies = []) {
  const list = Array.isArray(cookies) ? cookies : [];
  return {
    count: list.length,
    names: list.map((item) => String(item?.name || '').trim()).filter(Boolean).slice(0, 20),
  };
}

function summarizeEvidence(evidence = {}) {
  const requests = Array.isArray(evidence?.requests) ? evidence.requests : [];
  const responses = Array.isArray(evidence?.responses) ? evidence.responses : [];
  return {
    requestCount: requests.length,
    responseCount: responses.length,
    cookies: summarizeCookies(evidence?.cookies || []),
    hasRequestHeaders: requests.some((entry) => entry?.headers && Object.keys(entry.headers).length > 0),
    hasResponseHeaders: responses.some((entry) => entry?.headers && Object.keys(entry.headers).length > 0),
    hasResponseBodyPreview: responses.some((entry) => String(entry?.bodyPreview || '').trim().length > 0),
    domSnapshotChars: Number(String(evidence?.domSnapshotPreview || '').length || 0),
  };
}

class PaymentProviderAdapter {
  constructor({ id, label, providerKeys = [], hostPatterns = [] } = {}) {
    this.id = id;
    this.label = label;
    this.providerKeys = providerKeys;
    this.hostPatterns = hostPatterns;
  }

  matches(providerSummary = {}, handoff = null) {
    const host = String(providerSummary?.host || '').toLowerCase();
    const provider = String(providerSummary?.provider || '').toLowerCase();
    if (this.providerKeys.some((key) => key === provider)) return true;
    return this.hostPatterns.some((pattern) => pattern.test(host));
  }

  getRequiredEvidence() {
    return [
      'request.url',
      'request.method',
      'request.headers',
      'response.status',
      'response.headers',
      'cookies',
      'domSnapshotPreview',
    ];
  }

  buildOperatorInstructions({ providerSummary = {}, intentText = '' } = {}) {
    const providerLabel = providerSummary?.provider || this.label || 'payment-provider';
    return [
      `Review the transferred ${providerLabel} page and confirm the payee, amount, and service match ${intentText || 'the requested municipal payment'}.`,
      'Keep the captured request, response headers, cookies, and DOM snapshot together so the host-specific adapter can be refined safely.',
      'Pause before entering card or bank credentials unless a human operator explicitly approves the irreversible payment step.',
      'After successful confirmation or manual completion, record the provider reference and update the linked government request.',
    ];
  }

  analyze({ providerSummary = {}, evidence = {}, intentText = '', handoff = null } = {}) {
    return {
      adapterId: this.id,
      adapterLabel: this.label,
      requiredEvidence: this.getRequiredEvidence(),
      operatorInstructions: this.buildOperatorInstructions({ providerSummary, evidence, intentText }),
      evidenceSummary: summarizeEvidence(evidence),
      adapterReady: Boolean(providerSummary?.handoffDetected || providerSummary?.irreversibleBoundaryDetected),
      handoffSummary: summarizeHandoff(handoff),
    };
  }
}

class TelAvivRedirectPaymentAdapter extends PaymentProviderAdapter {
  constructor() {
    super({
      id: 'tel-aviv-redirect-handoff',
      label: 'Tel Aviv Redirect Handoff',
    });
  }

  matches(providerSummary = {}, handoff = null) {
    const normalized = normalizePaymentHandoff(handoff || {});
    if (!normalized?.url) return false;
    return /tel-aviv\.gov\.il$/i.test(normalized?.sourceHost || '')
      || (Array.isArray(normalized?.redirectChain) && normalized.redirectChain.some((entry) => /tel-aviv\.gov\.il/i.test(String(entry || ''))))
      || /tel-aviv/i.test(String(providerSummary?.provider || ''));
  }

  getRequiredEvidence() {
    return [
      ...super.getRequiredEvidence(),
      'handoff.url',
      'handoff.sourceUrl',
      'handoff.headers',
      'handoff.redirectChain',
      'handoff.selectorFingerprints',
    ];
  }

  buildOperatorInstructions({ providerSummary = {}, intentText = '', handoff = null } = {}) {
    const normalized = normalizePaymentHandoff(handoff || {});
    return [
      `Validate the Tel Aviv redirect handoff for ${intentText || 'the active municipal payment'} before entering irreversible payment details.`,
      `Confirm the captured redirect URL ${normalized?.url || '(missing)'} and source ${normalized?.sourceUrl || '(missing)'} still point to the expected municipal payment transition.`,
      'Preserve the redirect URL, query params, request headers, redirect chain, and selector fingerprints together so the handoff adapter can be versioned safely.',
      `If validation fails or the target no longer matches ${providerSummary?.host || 'the expected provider host'}, force HITL and recapture the handoff from DevTools/network evidence.`,
    ];
  }

  analyze({ providerSummary = {}, evidence = {}, intentText = '', handoff = null } = {}) {
    const normalized = normalizePaymentHandoff(handoff || {});
    const validation = validateTelAvivPaymentHandoff({ handoff: normalized, providerSummary });
    return {
      adapterId: this.id,
      adapterLabel: this.label,
      adapterVersion: TEL_AVIV_REDIRECT_ADAPTER_VERSION,
      handoffVersion: normalized?.version || PAYMENT_HANDOFF_SCHEMA_VERSION,
      requiredEvidence: this.getRequiredEvidence(),
      operatorInstructions: this.buildOperatorInstructions({ providerSummary, evidence, intentText, handoff: normalized }),
      evidenceSummary: summarizeEvidence(evidence),
      adapterReady: validation.isValid,
      handoffSummary: summarizeHandoff(normalized),
      handoff: normalized ? {
        paymentUrl: normalized.url,
        token: normalized.token || null,
        flow: normalized.flow || 'redirect',
        sourceUrl: normalized.sourceUrl || null,
        sourceHost: normalized.sourceHost || null,
        headers: normalized.headers,
        params: normalized.params,
        redirectChain: normalized.redirectChain,
        selectorFingerprints: normalized.selectorFingerprints,
      } : null,
      validation,
    };
  }
}

class TelAvivInternalBoundaryAdapter extends PaymentProviderAdapter {
  constructor() {
    super({
      id: 'tel-aviv-internal-boundary',
      label: 'Tel Aviv Internal Boundary',
      providerKeys: ['tel-aviv'],
      hostPatterns: [/tel-aviv\.gov\.il$/i],
    });
  }

  buildOperatorInstructions({ providerSummary = {}, intentText = '' } = {}) {
    return [
      `Stay on the municipal host while confirming the requested payment branch for ${intentText || 'the active payment flow'}.`,
      'Capture the final municipal request, response headers, cookies, and DOM snapshot before crossing into a real payment provider.',
      'If the flow still requires municipal login or payer identification, resolve that first and only then continue to the external provider handoff.',
      `Once an external host appears, persist the handoff evidence so a provider-specific adapter can take over for ${providerSummary?.host || 'the payment provider'}.`,
    ];
  }
}

class ExternalPaymentProviderAdapter extends PaymentProviderAdapter {
  constructor() {
    super({
      id: 'external-payment-provider',
      label: 'Generic External Provider',
      providerKeys: ['external-payment-provider'],
    });
  }
}

class MeshulamPaymentAdapter extends PaymentProviderAdapter {
  constructor() {
    super({
      id: 'meshulam-payment-provider',
      label: 'Meshulam Provider',
      providerKeys: ['meshulam'],
      hostPatterns: [/meshulam/i],
    });
  }

  buildOperatorInstructions({ intentText = '' } = {}) {
    return [
      `Confirm the Meshulam handoff is still for ${intentText || 'the intended municipal payment'} before entering any payer details.`,
      'Keep the Meshulam request URL, headers, cookies, and first HTML response together so the adapter can be specialized against a real provider capture.',
      'Record any provider-side transaction or reference number after manual completion and attach it to the government request.',
    ];
  }
}

class PayPlusPaymentAdapter extends PaymentProviderAdapter {
  constructor() {
    super({
      id: 'payplus-payment-provider',
      label: 'PayPlus Provider',
      providerKeys: ['payplus'],
      hostPatterns: [/payplus/i],
    });
  }
}

const ADAPTERS = [
  new TelAvivRedirectPaymentAdapter(),
  new MeshulamPaymentAdapter(),
  new PayPlusPaymentAdapter(),
  new TelAvivInternalBoundaryAdapter(),
  new ExternalPaymentProviderAdapter(),
  new PaymentProviderAdapter({ id: 'fallback-payment-provider', label: 'Fallback Payment Provider' }),
];

export function resolvePaymentProviderAdapter(providerSummary = {}, handoff = null) {
  return ADAPTERS.find((adapter) => adapter.matches(providerSummary, handoff)) || ADAPTERS[ADAPTERS.length - 1];
}

export function analyzePaymentProviderBoundary({ providerSummary = {}, evidence = {}, intentText = '', handoff = null } = {}) {
  const normalizedHandoff = normalizePaymentHandoff(handoff || {});
  const adapter = resolvePaymentProviderAdapter(providerSummary, normalizedHandoff);
  const analysis = adapter.analyze({ providerSummary, evidence, intentText, handoff: normalizedHandoff });
  return {
    adapter: {
      id: adapter.id,
      label: adapter.label,
      version: analysis?.adapterVersion || null,
    },
    ...analysis,
  };
}

export async function savePaymentBoundaryEvidence(payload = {}) {
  const savedAt = new Date().toISOString();
  const evidenceId = String(payload?.evidenceId || `payment-boundary-${Date.now()}`).trim();
  const normalized = {
    ...payload,
    evidenceId,
    savedAt,
  };
  const filePath = path.join(PAYMENT_BOUNDARY_EVIDENCE_DIR, `${evidenceId}.json`);
  await fs.mkdir(PAYMENT_BOUNDARY_EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(normalized, null, 2), 'utf8');
  await fs.writeFile(PAYMENT_BOUNDARY_LATEST_PATH, JSON.stringify(normalized, null, 2), 'utf8');
  return {
    ok: true,
    evidenceId,
    filePath,
    savedAt,
    summary: summarizeEvidence(normalized?.evidence || {}),
  };
}

export async function getLatestPaymentBoundaryEvidence() {
  try {
    const raw = await fs.readFile(PAYMENT_BOUNDARY_LATEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ok: true,
      record: parsed,
      summary: summarizeEvidence(parsed?.evidence || {}),
    };
  } catch {
    return { ok: false, error: 'No saved payment boundary evidence found.' };
  }
}

export function normalizeManualPaymentBoundaryEvidence(payload = {}) {
  const handoff = normalizePaymentHandoff(getManualHandoffSeed(payload) || {});
  return {
    mode: String(payload?.mode || 'manual-payment-boundary-capture').trim() || 'manual-payment-boundary-capture',
    paymentUrl: String(payload?.paymentUrl || '').trim(),
    finalUrl: String(payload?.finalUrl || handoff?.url || '').trim(),
    intentText: String(payload?.intentText || '').trim(),
    paymentProvider: payload?.paymentProvider || summarizePaymentProvider(handoff?.url || payload?.finalUrl || payload?.paymentUrl || '', payload?.pageTextPreview || payload?.domSnapshotPreview || ''),
    pageTitle: String(payload?.pageTitle || '').trim(),
    handoff,
    evidence: {
      requests: Array.isArray(payload?.evidence?.requests) ? payload.evidence.requests : [],
      responses: Array.isArray(payload?.evidence?.responses) ? payload.evidence.responses : [],
      cookies: Array.isArray(payload?.evidence?.cookies) ? payload.evidence.cookies : [],
      domSnapshotPreview: truncateText(payload?.evidence?.domSnapshotPreview || payload?.domSnapshotPreview || '', 12000),
      pageTextPreview: truncateText(payload?.evidence?.pageTextPreview || payload?.pageTextPreview || '', 8000),
    },
    adapter: payload?.adapter || null,
  };
}

export function buildPaymentBoundaryUiSummary(record = {}) {
  const provider = record?.paymentProvider || {};
  const adapter = record?.adapter || {};
  const summary = summarizeEvidence(record?.evidence || {});
  const handoff = summarizeHandoff(record?.handoff || record?.adapterAnalysis?.handoff || null);
  const validation = record?.adapterAnalysis?.validation || record?.validation || {};
  return {
    provider: provider?.provider || null,
    host: provider?.host || null,
    handoffDetected: Boolean(provider?.handoffDetected),
    irreversibleBoundaryDetected: Boolean(provider?.irreversibleBoundaryDetected),
    loginRequired: Boolean(provider?.loginRequired),
    adapterId: adapter?.id || null,
    adapterLabel: adapter?.label || null,
    requestCount: summary.requestCount,
    responseCount: summary.responseCount,
    cookieCount: summary.cookies.count,
    hasResponseBodyPreview: summary.hasResponseBodyPreview,
    adapterVersion: adapter?.version || record?.adapterAnalysis?.adapterVersion || null,
    handoffUrl: handoff?.url || null,
    handoffToken: handoff?.token || null,
    handoffSourceHost: handoff?.sourceHost || null,
    handoffFlow: handoff?.flow || null,
    handoffVersion: handoff?.version || null,
    handoffHeaderCount: handoff?.headerCount ?? null,
    handoffRedirectCount: handoff?.redirectCount ?? null,
    validationIssues: Array.isArray(validation?.issues) ? validation.issues.length : 0,
    validationWarnings: Array.isArray(validation?.warnings) ? validation.warnings.length : 0,
  };
}