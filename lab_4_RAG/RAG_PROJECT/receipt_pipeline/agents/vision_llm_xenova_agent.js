// vision_llm_xenova_agent.js
// Agent for Xenova Vision LLM (open source)
// Requires xenova/transformers.js or similar library

const { pipeline } = require('transformers');

let model;

async function loadModel() {
    if (!model) {
        model = await pipeline('image-to-text', 'Xenova/llava-v1.5-7b-hf');
    }
    return model;
}


// Helper: parse text to structured receipt fields
function parseReceiptText(text) {
    // Extract date
    const dateMatch = text.match(/(\d{2}[\/\-]\d{2}[\/\-]\d{4})/);
    // Extract total (look for lines with 'total', 'credit', or $)
    let total = null;
    let currency = null;
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        if (/total|credit|amount|paid|sum/i.test(line)) {
            const numMatch = line.match(/([\d]+[.][\d]+)/);
            if (numMatch) total = parseFloat(numMatch[1]);
            if (line.includes('$')) currency = 'USD';
        }
        if (!currency && /USD|CAD|GBP|EUR/.test(line)) {
            currency = line.match(/USD|CAD|GBP|EUR/)[0];
        }
    }
    // Fallback: largest $-amount
    if (!total) {
        const moneyMatches = Array.from(text.matchAll(/\$([\d,.]+)/g)).map(m => parseFloat(m[1].replace(/,/g, '')));
        if (moneyMatches.length > 0) total = Math.max(...moneyMatches);
        if (text.includes('$')) currency = 'USD';
    }
    return {
        date: dateMatch ? dateMatch[1] : null,
        total,
        currency,
        items: [],
        source: 'xenova',
        raw_text: text
    };
}

async function extractReceiptData(imageBuffer) {
    const model = await loadModel();
    const result = await model(imageBuffer);
    // result is usually { generated_text: ... }
    const text = result.generated_text || result.text || (typeof result === 'string' ? result : '');
    return parseReceiptText(text);
}

module.exports = { extractReceiptData };
