// vision_llm_nanollava_agent.js
// Agent for Xenova nanoLLaVA (open source)
// Requires xenova/transformers.js or similar library

const { pipeline } = require('transformers');

let model;

async function loadModel() {
    if (!model) {
        model = await pipeline('image-to-text', 'Xenova/nano-llava-v1-hf');
    }
    return model;
}


// Helper: parse text to structured receipt fields (reuse from Xenova)
function parseReceiptText(text) {
    const dateMatch = text.match(/(\d{2}[\/\-]\d{2}[\/\-]\d{4})/);
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
        source: 'nanollava',
        raw_text: text
    };
}

async function extractReceiptData(imageBuffer) {
    const model = await loadModel();
    const result = await model(imageBuffer);
    const text = result.generated_text || result.text || (typeof result === 'string' ? result : '');
    return parseReceiptText(text);
}

module.exports = { extractReceiptData };
