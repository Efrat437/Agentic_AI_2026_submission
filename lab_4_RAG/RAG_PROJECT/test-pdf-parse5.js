import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);

const { PDFParse } = require("pdf-parse");

const filePath = "./03_data/the-modern-guide-to-oauth.pdf";
const fileBuffer = fs.readFileSync(filePath);

// Convert Buffer to Uint8Array
const uint8array = new Uint8Array(fileBuffer);

try {
  const pdfParser = new PDFParse(uint8array);
  
  console.log("Loading PDF...");
  
  // Load the PDF first
  await pdfParser.load();
  
  console.log("PDF loaded. Getting text...");
  
  // Get all text
  const text = await pdfParser.getText();
  
  console.log(`\n✅ Successfully extracted ${text.length} characters!\n`);
  console.log("First 1000 chars:");
  console.log(text.substring(0, 1000));
  console.log("\n...\n");
  console.log("Last 500 chars:");
  console.log(text.substring(text.length - 500));
  
} catch (err) {
  console.log("Error:", err.message);
  console.log(err.stack);
}
