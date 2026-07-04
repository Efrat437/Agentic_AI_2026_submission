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
    
    console.log("textObj type:", typeof textObj);
    console.log("textObj keys:", Object.keys(textObj || {}).slice(0, 30));
    console.log("textObj.items?:", textObj.items ? "yes" : "no");
    console.log("textObj.items length:", textObj.items ? textObj.items.length : "N/A");
    
    if (textObj.items && Array.isArray(textObj.items) && textObj.items.length > 0) {
      console.log("\nFirst 3 items:");
      for (let i = 0; i < Math.min(3, textObj.items.length); i++) {
        console.log(`  [${i}]:`, textObj.items[i]);
      }
      
      // Extract text from items
      const text = textObj.items.map(item => item.str || "").join(" ");
      console.log(`\n✅ Combined ${text.length} characters`);
      console.log("First 500 chars:");
      console.log(text.substring(0, 500));
    }
    
  } catch (err) {
    console.log("Error:", err.message);
  }
}

test();
