import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);

const { PDFParse } = require("pdf-parse");

const filePath = "./03_data/the-modern-guide-to-oauth.pdf";
const fileBuffer = fs.readFileSync(filePath);
const uint8array = new Uint8Array(fileBuffer);

try {
  const pdfParser = new PDFParse(uint8array);
  console.log("Loading PDF...");
  await pdfParser.load();
  
  console.log("Getting text...");
  const text = await pdfParser.getText();
  
  console.log("Text type:", typeof text);
  console.log("Text keys:", Object.keys(text || {}).slice(0, 20));
  console.log("Text is Array:", Array.isArray(text));
  console.log("Text length:", (text || []).length);
  
  if (Array.isArray(text)) {
    console.log("\nFirst item:", text[0]);
    const combined = text.join(" ");
    console.log(`\n✅ Combined ${combined.length} characters`);
    console.log("First 500 chars:");
    console.log(combined.substring(0, 500));
  } else if (typeof text === 'string') {
    console.log(`\n✅ Extracted ${text.length} characters`);
    console.log("First 500 chars:");
    console.log(text.substring(0, 500));
  } else {
    console.log("Text:", text);
  }
  
} catch (err) {
  console.log("Error:", err.message);
}
