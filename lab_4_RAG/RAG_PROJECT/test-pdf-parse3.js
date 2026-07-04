import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);

const { PDFParse } = require("pdf-parse");

const filePath = "./03_data/the-modern-guide-to-oauth.pdf";
const fileBuffer = fs.readFileSync(filePath);

try {
  const pdfParser = new PDFParse(fileBuffer);
  console.log("PDFParser instance keys:", Object.keys(pdfParser).slice(0, 20));   console.log("PDFParser prototype methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(pdfParser)).slice(0, 20));
  
} catch (err) {
  console.log("Error:", err.message);
}
