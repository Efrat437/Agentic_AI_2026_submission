import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);

const { PDFParse } = require("pdf-parse");
console.log("PDFParse type:", typeof PDFParse);

// Try to extract from PDF
const filePath = "./03_data/the-modern-guide-to-oauth.pdf";
const fileBuffer = fs.readFileSync(filePath);

try {
  const pdfParser = new PDFParse(fileBuffer);
  console.log("\nExtracting text...");
  
  // PDFParse has a getTextContent method
  const textContent = await pdfParser.getTextContent();
  console.log("Text content type:", typeof textContent);
  console.log("Text content keys:", Object.keys(textContent || {}).slice(0, 10));
  
  // Extract text from items
  if (textContent && textContent.items) {
    const text = textContent.items.map(item => item.str || "").join(" ");
    console.log(`\nExtracted ${text.length} characters`);
    console.log("First 500 chars:");
    console.log(text.substring(0, 500));
  }
} catch (err) {
  console.log("Error:", err.message);
  console.log(err.stack);
}
