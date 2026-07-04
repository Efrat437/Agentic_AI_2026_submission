import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);

const { PDFParse } = require("pdf-parse");

const filePath = "./03_data/the-modern-guide-to-oauth.pdf";
const fileBuffer = fs.readFileSync(filePath);
const uint8array = new Uint8Array(fileBuffer);

async function test() {
  try {
    const pdfParser = new PDFParse(uint8array);
    console.log("Loading PDF...");
    await pdfParser.load();
    
    console.log("Getting text...");
    const textObj = await pdfParser.getText();
    
    console.log("textObj.text type:", typeof textObj.text);
    console.log("textObj.text length:", textObj.text ? textObj.text.length : "N/A");
    console.log("textObj.total:", textObj.total);
    console.log("textObj.pages length:", textObj.pages ? textObj.pages.length : "N/A");
    
    if (typeof textObj.text === 'string' && textObj.text.length > 0) {
      console.log(`\n✅ Got ${textObj.text.length} characters!`);
      console.log("\nFirst 1000 chars:");
      console.log(textObj.text.substring(0, 1000));
      console.log("\n...\n");
      console.log("Last 300 chars:");
      console.log(textObj.text.substring(textObj.text.length - 300));
    } else if (textObj.pages && Array.isArray(textObj.pages)) {
      const combined = textObj.pages.map(p => p.text || p).join(" ");
      console.log(`\n✅ Combined from pages: ${combined.length} characters`);
      console.log("First 500 chars:");
      console.log(combined.substring(0, 500));
    }
    
  } catch (err) {
    console.log("Error:", err.message);
    console.log(err.stack);
  }
}

test();
