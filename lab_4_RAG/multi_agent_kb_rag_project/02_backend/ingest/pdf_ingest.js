import fs from 'fs';
import { PDFParse } from 'pdf-parse';

export async function extractTextFromPdfBuffer(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const parsed = await parser.getText();
    return String(parsed?.text || '').trim();
  } finally {
    await parser.destroy();
  }
}

export async function extractTextFromPdfFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  return extractTextFromPdfBuffer(buffer);
}
