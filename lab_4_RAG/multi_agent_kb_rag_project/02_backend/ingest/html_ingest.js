import fs from 'fs';
import path from 'path';
import { load } from 'cheerio';
import { pipeline } from 'stream/promises';

function cleanText(text) {
  // basic cleaning: normalize whitespace, remove scripts/styles, trim
  return text
    .replace(/\s+/g, ' ')
    .replace(/\u00A0/g, ' ')
    .trim();
}

export function extractTextFromHtmlFile(filePath) {
  const html = fs.readFileSync(filePath, 'utf8');
  const $ = load(html);

  // remove non-content elements
  $('script, style, noscript, header, footer, nav, form, aside').remove();

  // optionally extract microdata/ld+json
  const ld = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      ld.push(JSON.parse($(el).text()));
    } catch (e) {}
  });

  // extract main content heuristically
  const paragraphs = $('p')
    .map((i, el) => $(el).text())
    .get()
    .map(cleanText)
    .filter(Boolean);

  const headings = $('h1,h2,h3').map((i, el) => $(el).text()).get().map(cleanText).filter(Boolean);

  const text = headings.concat(paragraphs).join('\n\n');

  return { text, ld };
}

export function chunkHtmlContent(text, chunkSize = 1000, chunkOverlap = 150) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize - chunkOverlap) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks.map((c, idx) => ({ pageContent: c, metadata: { chunkIndex: idx } }));
}
