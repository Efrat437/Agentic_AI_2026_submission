import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CHUNK_SIZE = 1000;
export const CHUNK_OVERLAP = 200;

export async function streamTextIntoChunks(filePath) {
    console.log(`Starting Extraction: ${filePath}`);
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

    const dataBuffer = fs.readFileSync(filePath);

    try {
        const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(dataBuffer) });
        const pdfDoc = await loadingTask.promise;
        let fullText = '';

        for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
            const page = await pdfDoc.getPage(pageNum);
            const textContent = await page.getTextContent();
            fullText += textContent.items.map(item => item.str).join(' ') + '\n';
        }

        console.log(`PDF extracted via pdfjs-dist (${pdfDoc.numPages} pages, ${fullText.length} chars)`);
        return fullText;
    } catch (e) {
        throw new Error(`PDF extraction failed: ${e.message}`);
    }
}

export function extractSectionsFromChunks(text) {
    if (typeof text !== 'string') return [text];

    const words = text.split(' ');
    const sections = [];
    let currentChunk = [];
    const targetWordCount = 150;

    for (const word of words) {
        currentChunk.push(word);
        if (currentChunk.length >= targetWordCount && (word.endsWith('.') || word.endsWith('?'))) {
            sections.push(createSectionObject(currentChunk.join(' '), sections.length));
            currentChunk = [];
        }
    }

    if (currentChunk.length > 0) {
        sections.push(createSectionObject(currentChunk.join(' '), sections.length));
    }

    return sections;
}

function createSectionObject(content, index) {
    const heading = content.split(' ').slice(0, 7).join(' ').replace(/[^\w\s]/gi, '') + '...';
    return {
        id: `chunk-${index}`,
        text: content,
        content: content,
        heading: heading.toUpperCase(),
        images: []
    };
}