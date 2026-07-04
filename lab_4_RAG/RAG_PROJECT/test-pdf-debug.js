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
    
    console.log("Getting text with different methods...");
    
    // Try different methods
    console.log("\n1. getText():");
    const text1 = await pdfParser.getText();
    console.log("   Type:", typeof text1);
    console.log("   Is Array:", Array.isArray(text1));
    console.log("   Length:", text1 ? text1.length : "undefined");
    if (Array.isArray(text1) && text1.length > 0) {
      console.log("   First item:", text1[0]);
    }
    
    console.log("\n2. Checking getPageText:");
    const pageText = await pdfParser.getPageText(1);
    console.log("   Type:", typeof pageText);
    console.log("   Is Array:", Array.isArray(pageText));
    console.log("   Length:", pageText ? pageText.length : "undefined");
    if (Array.isArray(pageText) && pageText.length > 0) {
      console.log("   First item:", pageText[0]);
      const combined = pageText.map(p => p.text || p.str || p).join(" ");
      console.log("   Combined length:", combined.length);
      console.log("   First 300 chars:", combined.substring(0, 300));
    }
    
  } catch (err) {
    console.log("Error:", err.message);
    console.log(err.stack);
  }
}

test();
