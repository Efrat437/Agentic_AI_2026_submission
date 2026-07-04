import { load } from 'cheerio';

function cleanText(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\u00A0/g, ' ')
    .trim();
}

export async function fetchUrlContent(url, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'AgenticRAG/1.0' }, signal: controller.signal });
    if (!res.ok) throw new Error(`Fetch failed ${res.status} ${res.statusText}`);
    const html = await res.text();
    return html;
  } finally {
    clearTimeout(id);
  }
}

export function extractTextFromHtmlString(html) {
  const $ = load(html);
  $('script, style, noscript, header, footer, nav, form, aside').remove();

  const ld = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    try { ld.push(JSON.parse($(el).text())); } catch (e) {}
  });

  const paragraphs = $('p').map((i, el) => $(el).text()).get().map(cleanText).filter(Boolean);
  const headings = $('h1,h2,h3').map((i, el) => $(el).text()).get().map(cleanText).filter(Boolean);
  const text = headings.concat(paragraphs).join('\n\n');
  return { text, ld };
}

export function chunkText(text, chunkSize = 1000, chunkOverlap = 150) {
  const chunks = [];
  if (!text || !text.length) return [];
  for (let i = 0, idx = 0; i < text.length; i += chunkSize - chunkOverlap, idx++) {
    const slice = text.slice(i, i + chunkSize);
    chunks.push({ pageContent: slice, metadata: { chunkIndex: idx } });
  }
  return chunks;
}

function extractStringsFromObject(obj) {
  const out = [];
  function walk(v) {
    if (!v && typeof v !== 'boolean' && typeof v !== 'number') return;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out.push(String(v));
    } else if (Array.isArray(v)) {
      for (const it of v) walk(it);
    } else if (typeof v === 'object') {
      for (const k of Object.keys(v)) walk(v[k]);
    }
  }
  walk(obj);
  return out.join('\n');
}

export async function fetchApiAndExtractText(url, options = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), options.timeout || 15000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'AgenticRAG/1.0', Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`API fetch failed ${res.status} ${res.statusText}`);
    const json = await res.json();
    const text = extractStringsFromObject(json);
    return text;
  } finally {
    clearTimeout(id);
  }
}
