import path from 'path';
import { smartPdfParser } from './rag_process_v2.js';

const filePath = path.resolve(process.cwd(), '03_data', 'the-modern-guide-to-oauth.pdf');

console.log('Testing smartPdfParser on:', filePath);

(async () => {
  try {
    const text = await smartPdfParser(filePath, { preferredParser: 'auto', isScanned: false });
    if (!text) {
      console.error('No text extracted by smartPdfParser');
      process.exit(2);
    }
    console.log('\n--- Extracted Length ---');
    console.log(text.length);
    console.log('\n--- Preview (first 2000 chars) ---');
    console.log(text.substring(0, 2000));
  } catch (err) {
    console.error('Extraction test failed:', err.message);
    process.exit(1);
  }
})();
