import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

try {
    const pdfPath = path.join(__dirname, '..', '03_data', 'the-modern-guide-to-oauth.pdf');
    const dataBuffer = fs.readFileSync(pdfPath);
    console.log('Buffer size:', dataBuffer.length);

    console.log('Loading pdfjs-dist...');
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(dataBuffer) });
    const pdfDoc = await loadingTask.promise;
    console.log('Pages:', pdfDoc.numPages);

    let fullText = '';
    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
        const page = await pdfDoc.getPage(pageNum);
        const textContent = await page.getTextContent();
        fullText += textContent.items.map(item => item.str).join(' ') + '\n';
    }

    console.log('Total chars:', fullText.length);
    console.log('Text sample:', fullText.slice(0, 500));
} catch (e) {
    console.error('FAILED:', e.message);
    console.error(e.stack);
}