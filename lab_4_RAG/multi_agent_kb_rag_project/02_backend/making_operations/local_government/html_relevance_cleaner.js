import { load } from 'cheerio';

const DEFAULT_RELEVANCE_TERMS = [
  // English
  'waste', 'trash', 'garbage', 'recycling',
  'parking', 'permit', 'permits',
  'opening hours', 'hours', 'office hours',
  'appointment', 'service center', 'city office', 'municipality',
  'payment', 'bills', 'arnona',
  // Hebrew (common local-government terms)
  'אשפה', 'פסולת', 'מיחזור',
  'חניה', 'תו חניה', 'היתר',
  'שעות קבלה', 'שעות פתיחה',
  'זימון תור', 'קביעת תור',
  'תשלום', 'ארנונה', 'עירייה',
];

function normalizeLine(text = '') {
  return String(text)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[ \t]+$/g, '')
    .trim();
}

function scoreRelevance(text = '', relevanceTerms = DEFAULT_RELEVANCE_TERMS) {
  const lower = String(text || '').toLowerCase();
  let score = 0;
  for (const term of relevanceTerms) {
    if (!term) continue;
    if (lower.includes(String(term).toLowerCase())) score += 1;
  }
  return score;
}

function toMarkdownSections(items = []) {
  const lines = [];
  for (const item of items) {
    if (item.kind === 'heading') {
      lines.push(`## ${item.text}`);
      continue;
    }
    if (item.kind === 'list') {
      lines.push(`- ${item.text}`);
      continue;
    }
    lines.push(item.text);
  }
  return lines.join('\n\n');
}

export function cleanRelevantHtmlToMarkdown(html = '', { relevanceTerms = DEFAULT_RELEVANCE_TERMS, minScore = 1 } = {}) {
  const $ = load(String(html || ''));
  $('script, style, noscript, header, footer, nav, form, aside, iframe, svg').remove();

  const candidates = [];

  $('h1,h2,h3,h4').each((_, el) => {
    const text = normalizeLine($(el).text());
    if (text) candidates.push({ kind: 'heading', text, score: scoreRelevance(text, relevanceTerms) + 1 });
  });

  $('p').each((_, el) => {
    const text = normalizeLine($(el).text());
    if (text && text.length >= 20) {
      candidates.push({ kind: 'paragraph', text, score: scoreRelevance(text, relevanceTerms) });
    }
  });

  $('li').each((_, el) => {
    const text = normalizeLine($(el).text());
    if (text && text.length >= 8) {
      candidates.push({ kind: 'list', text, score: scoreRelevance(text, relevanceTerms) });
    }
  });

  const dedup = new Set();
  const kept = [];
  for (const c of candidates) {
    const key = c.text.toLowerCase();
    if (dedup.has(key)) continue;
    dedup.add(key);
    if (c.kind === 'heading' || c.score >= minScore) kept.push(c);
  }

  const markdown = toMarkdownSections(kept);
  const plainText = kept.map((x) => x.text).join('\n\n');

  return {
    markdown,
    plainText,
    keptItems: kept.length,
    droppedItems: Math.max(0, candidates.length - kept.length),
    relevanceTerms,
  };
}
