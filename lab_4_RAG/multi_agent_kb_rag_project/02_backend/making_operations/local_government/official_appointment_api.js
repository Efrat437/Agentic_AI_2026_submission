import http from 'node:http';
import https from 'node:https';

const DEFAULT_PUBLIC_BOOKING_URL = 'https://www.tel-aviv.gov.il/Contact/Pages/Appointments.aspx';

const TRUE_LIKE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_LIKE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);
const CONFIRMED_APPOINTMENT_STATUSES = new Set(['confirmed', 'approved', 'booked', 'scheduled', 'success', 'completed']);

function toBool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  const normalized = String(v).trim().toLowerCase();
  if (TRUE_LIKE_VALUES.has(normalized)) return true;
  if (FALSE_LIKE_VALUES.has(normalized)) return false;
  return fallback;
}

function pick(obj, keys = []) {
  for (const key of keys) {
    if (obj && obj[key] != null) {
      return obj[key];
    }
  }
  return null;
}

function normalizePublicBookingUrl(url) {
  const normalized = String(url || '').trim();
  if (!normalized) return DEFAULT_PUBLIC_BOOKING_URL;
  return normalized.replace(/\/Apointments\.aspx(?=\?|#|$)/i, '/Appointments.aspx');
}

function normalizeOptionalString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function normalizeOptionalNumber(value, fallback = 0) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : fallback;
}

function buildIsolatedHttpResponse({ statusCode = 500, statusMessage = '', body = '' } = {}) {
  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: Number(statusCode || 500),
    statusText: String(statusMessage || ''),
    async text() {
      return String(body || '');
    },
  };
}

function fetchWithIsolatedTls(url, { method = 'GET', headers = {}, body = null, timeoutMs = 20000, allowInsecureTls = false } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'http:' ? http : https;
    const req = transport.request(target, {
      method,
      headers,
      rejectUnauthorized: allowInsecureTls ? false : true,
      timeout: Math.max(1000, Number(timeoutMs) || 20000),
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        resolve(buildIsolatedHttpResponse({
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
    });

    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

export class MunicipalityApiUnavailableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'MunicipalityApiUnavailableError';
    this.statusCode = 501;
    this.details = details;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class MunicipalityApiCallError extends Error {
  constructor(message, statusCode = 502, details = {}) {
    super(message);
    this.name = 'MunicipalityApiCallError';
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export function getTelAvivOfficialAppointmentApiConfig(overrides = {}) {
  const baseUrl = normalizeOptionalString(overrides?.baseUrl, String(process.env.TEL_AVIV_APPOINTMENT_API_BASE_URL || '').trim());
  const createPath = normalizeOptionalString(overrides?.createPath, String(process.env.TEL_AVIV_APPOINTMENT_API_CREATE_PATH || '/appointments').trim()) || '/appointments';
  const apiKey = normalizeOptionalString(overrides?.apiKey, String(process.env.TEL_AVIV_APPOINTMENT_API_KEY || '').trim());
  const apiKeyHeader = normalizeOptionalString(overrides?.apiKeyHeader, String(process.env.TEL_AVIV_APPOINTMENT_API_KEY_HEADER || 'x-api-key').trim()) || 'x-api-key';
  const bearerToken = normalizeOptionalString(overrides?.bearerToken, String(process.env.TEL_AVIV_APPOINTMENT_API_BEARER_TOKEN || '').trim());
  const timeoutMs = Math.max(2000, normalizeOptionalNumber(overrides?.timeoutMs, Number(process.env.TEL_AVIV_APPOINTMENT_API_TIMEOUT_MS || 20000)));
  const allowInsecureTls = overrides?.allowInsecureTls == null
    ? toBool(process.env.TEL_AVIV_APPOINTMENT_API_ALLOW_INSECURE_TLS, false)
    : toBool(overrides.allowInsecureTls, false);
  const publicBookingUrl = normalizePublicBookingUrl(overrides?.publicBookingUrl ?? process.env.TEL_AVIV_APPOINTMENT_PUBLIC_URL ?? DEFAULT_PUBLIC_BOOKING_URL);

  return {
    provider: 'tel-aviv-yafo',
    baseUrl,
    createPath,
    apiKey,
    apiKeyHeader,
    bearerToken,
    timeoutMs,
    allowInsecureTls,
    publicBookingUrl,
    configured: !!baseUrl && (!!apiKey || !!bearerToken),
    configScope: Object.keys(overrides || {}).length > 0 ? 'request' : 'environment',
  };
}

export function normalizeCreateUrl(baseUrl, createPath) {
  const normalizedBase = String(baseUrl || '').trim().replace(/\/+$/, '');
  const normalizedPath = String(createPath || '/appointments');
  if (!normalizedBase) return '';
  if (!/^https?:\/\//i.test(normalizedBase)) return '';
  if (/^https?:\/\//i.test(normalizedPath)) return normalizedPath;
  return `${normalizedBase}${normalizedPath.startsWith('/') ? '' : '/'}${normalizedPath}`;
}

function validateRequestInput({ userId, description, notes = null, category = 'arnona', city = 'Tel Aviv-Yafo' } = {}) {
  const normalizedDescription = String(description || '').trim();
  if (!normalizedDescription) {
    throw new MunicipalityApiCallError('description is required', 400);
  }

  const normalizedUserId = userId == null ? null : String(userId).trim() || null;
  const normalizedNotes = notes == null ? null : String(notes).trim() || null;
  const normalizedCategory = String(category || 'arnona').trim() || 'arnona';
  const normalizedCity = String(city || 'Tel Aviv-Yafo').trim() || 'Tel Aviv-Yafo';

  return {
    userId: normalizedUserId,
    description: normalizedDescription,
    notes: normalizedNotes,
    category: normalizedCategory,
    city: normalizedCity,
  };
}

export function buildRequestBody(input = {}) {
  const { userId, description, notes, category, city } = validateRequestInput(input);
  const createdAtIso = new Date().toISOString();

  return {
    city,
    serviceCategory: category,
    description,
    userId,
    requester: {
      userId,
    },
    notes,
    createdAt: createdAtIso,
    createdAtIso,
    requestedAtIso: createdAtIso,
  };
}

function deriveAppointmentStatus(upstreamPayload = null) {
  const parsed = upstreamPayload && typeof upstreamPayload === 'object' ? upstreamPayload : {};
  const explicitConfirmation = pick(parsed, ['confirmed', 'isConfirmed', 'appointmentConfirmed']);
  const explicitSuccess = pick(parsed, ['success', 'ok']);
  const rawStatus = pick(parsed, ['status', 'state', 'result', 'appointmentStatus', 'bookingStatus']);
  const normalizedStatus = String(rawStatus || 'accepted').trim().toLowerCase().replace(/\s+/g, '_');
  const statusTokens = normalizedStatus.split(/[^a-z0-9]+/).filter(Boolean);
  const impliedConfirmation = statusTokens.some((token) => CONFIRMED_APPOINTMENT_STATUSES.has(token));

  if (explicitConfirmation != null) {
    return {
      upstreamStatus: normalizedStatus,
      confirmed: toBool(explicitConfirmation, Boolean(explicitConfirmation)),
    };
  }
  if (explicitSuccess != null) {
    return {
      upstreamStatus: normalizedStatus,
      confirmed: toBool(explicitSuccess, Boolean(explicitSuccess)),
    };
  }
  return {
    upstreamStatus: normalizedStatus,
    confirmed: impliedConfirmation,
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function scheduleTelAvivAppointmentOfficial({ userId, description, notes = null, category = 'arnona', officialApiConfig = null } = {}) {
  const config = getTelAvivOfficialAppointmentApiConfig(officialApiConfig || {});
  if (!config.configured) {
    throw new MunicipalityApiUnavailableError('Official Tel Aviv appointment API is not configured.', {
      provider: config.provider,
      publicBookingUrl: config.publicBookingUrl,
      configScope: config.configScope,
      requiredEnv: [
        'TEL_AVIV_APPOINTMENT_API_BASE_URL',
        'TEL_AVIV_APPOINTMENT_API_CREATE_PATH (optional, default /appointments)',
        'TEL_AVIV_APPOINTMENT_API_KEY or TEL_AVIV_APPOINTMENT_API_BEARER_TOKEN, or provide officialApiConfig per request',
      ],
    });
  }

  const url = normalizeCreateUrl(config.baseUrl, config.createPath);
  if (!url) {
    throw new MunicipalityApiCallError('Invalid official appointment API URL configuration.', 500, {
      provider: config.provider,
    });
  }

  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
  };

  if (config.apiKey) {
    headers[config.apiKeyHeader || 'x-api-key'] = config.apiKey;
  }
  if (config.bearerToken) {
    headers.authorization = `Bearer ${config.bearerToken}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const fetchOptions = {
      method: 'POST',
      headers,
      body: JSON.stringify(buildRequestBody({ userId, description, notes, category })),
      signal: controller.signal,
    };

    const response = config.allowInsecureTls
      ? await fetchWithIsolatedTls(url, {
        method: fetchOptions.method,
        headers: fetchOptions.headers,
        body: fetchOptions.body,
        timeoutMs: config.timeoutMs,
        allowInsecureTls: true,
      })
      : await fetch(url, fetchOptions);
    const rawText = await response.text();
    const parsed = safeJsonParse(rawText);

    if (!response.ok) {
      throw new MunicipalityApiCallError(`Official appointment API responded ${response.status}.`, 502, {
        provider: config.provider,
        endpoint: url,
        upstreamStatus: response.status,
        upstreamBody: parsed || rawText,
      });
    }

    const externalRequestId = pick(parsed || {}, [
      'id',
      'appointmentId',
      'requestId',
      'bookingId',
      'referenceId',
      'reference',
      'confirmationNumber',
    ]);

    const { upstreamStatus, confirmed } = deriveAppointmentStatus(parsed);

    return {
      ok: true,
      provider: config.provider,
      mode: 'official-api',
      endpoint: url,
      publicBookingUrl: config.publicBookingUrl,
      configScope: config.configScope,
      transport: config.allowInsecureTls ? 'isolated-insecure-tls-agent' : 'default-fetch',
      appointment: {
        externalRequestId,
        upstreamStatus,
        confirmed,
      },
      upstream: parsed || rawText,
    };
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new MunicipalityApiCallError(`Official appointment API timed out after ${config.timeoutMs}ms.`, 504, {
        provider: config.provider,
        endpoint: url,
      });
    }
    if (err instanceof MunicipalityApiCallError || err instanceof MunicipalityApiUnavailableError) {
      throw err;
    }
    throw new MunicipalityApiCallError(`Official appointment API call failed: ${err.message}`, 502, {
      provider: config.provider,
      endpoint: url,
    });
  } finally {
    clearTimeout(timer);
  }
}
