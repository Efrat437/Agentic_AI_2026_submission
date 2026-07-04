const DEFAULT_TIMEOUT_MS = Number(process.env.WEB_FETCH_TIMEOUT_MS || '25000');

const ALLOWED_URIS = [
  'https://www.tel-aviv.gov.il/pages/homepage.aspx',
  'https://www.ganeytikva.org.il/',
  'https://www.gov.il/he/departments/population_and_immigration_authority/govil-landing-page',
  'https://mavat.iplan.gov.il/SV1',
  'https://www.govmap.gov.il/?c=219143.61,618345.06',
  'https://www.cbs.gov.il/he/cbsnewbrand/Pages/default.aspx',
  'https://www.gov.il/he/departments/israel_tax_authority/govil-landing-page',
  'https://www.mizrahi-tefahot.co.il/',
];

function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  return raw.endsWith('/') ? raw : raw;
}

function isAllowedUrl(url) {
  const n = normalizeUrl(url);
  if (!n) return false;
  return ALLOWED_URIS.includes(n);
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripHtmlToText(html) {
  const withoutScripts = String(html || '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gims, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gims, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gims, ' ');

  const text = withoutScripts
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return decodeHtmlEntities(text);
}

function extractTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeHtmlEntities(m[1]).trim() : '';
}

function extractMetaDescription(html) {
  const m = String(html || '').match(/<meta\s+name=["']description["']\s+content=["']([\s\S]*?)["'][^>]*>/i);
  return m ? decodeHtmlEntities(m[1]).trim() : '';
}

function extractLinks(html, max = 20) {
  const links = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gim;
  let match = re.exec(String(html || ''));
  while (match && links.length < max) {
    const href = String(match[1] || '').trim();
    if (href) links.push(href);
    match = re.exec(String(html || ''));
  }
  return links;
}

async function fetchUri(url, maxChars) {
  const normalized = normalizeUrl(url);
  if (!isAllowedUrl(normalized)) {
    return {
      ok: false,
      url: normalized,
      error: 'URL is not in allowed URI list',
      allowedUris: ALLOWED_URIS,
    };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(normalized, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'user-agent': 'urban-ai-mcp-web-fetch/1.0',
      },
      signal: controller.signal,
    });

    const text = await response.text();
    const contentType = response.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');

    let parsedJson = null;
    if (isJson) {
      try {
        parsedJson = JSON.parse(text);
      } catch {
        parsedJson = null;
      }
    }

    const plainText = isJson ? JSON.stringify(parsedJson || text) : stripHtmlToText(text);
    const snippetLimit = Math.max(200, Math.min(Number(maxChars) || 4000, 50000));

    return {
      ok: response.ok,
      status: response.status,
      url: normalized,
      elapsedMs: Date.now() - startedAt,
      contentType,
      title: isJson ? '' : extractTitle(text),
      metaDescription: isJson ? '' : extractMetaDescription(text),
      links: isJson ? [] : extractLinks(text, 20),
      textSnippet: plainText.slice(0, snippetLimit),
      textLength: plainText.length,
      rawLength: text.length,
      json: parsedJson,
    };
  } catch (err) {
    return {
      ok: false,
      url: normalized,
      elapsedMs: Date.now() - startedAt,
      error: err?.name === 'AbortError' ? `Request timed out after ${DEFAULT_TIMEOUT_MS}ms` : (err.message || 'Request failed'),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPublicUriJson({ url, maxChars = 4000 } = {}) {
  return fetchUri(url, maxChars);
}

export async function fetchPublicUrisJson({ urls = [], maxChars = 2500 } = {}) {
  const input = Array.isArray(urls) ? urls : [];
  const unique = Array.from(new Set(input.map((u) => normalizeUrl(u)).filter(Boolean)));
  const selected = unique.length > 0 ? unique : ALLOWED_URIS;

  const results = [];
  for (const url of selected) {
    const result = await fetchUri(url, maxChars);
    results.push(result);
  }

  return {
    ok: true,
    total: results.length,
    allowedUris: ALLOWED_URIS,
    results,
  };
}

export function getAllowedPublicUris() {
  return ALLOWED_URIS;
}
