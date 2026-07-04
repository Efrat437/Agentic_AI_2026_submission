import { createRequire } from "module";
const require = createRequire(import.meta.url);

const pdfParse = require("pdf-parse");
console.log("pdfParse type:", typeof pdfParse);
console.log("pdfParse keys:", Object.keys(pdfParse).slice(0, 20));
console.log("pdfParse.default type:", typeof pdfParse.default);
console.log("pdfParse.default keys:", pdfParse.default ? Object.keys(pdfParse.default).slice(0, 20) : "N/A");

// Check if pdf-parse/lib/pdf.js works
try {
  const pdf = require("pdf-parse/lib/pdf.js");
  console.log("\npdf-parse/lib/pdf.js loaded");
  console.log("pdf type:", typeof pdf);
} catch (e) {
  console.log("\npdf-parse/lib/pdf.js failed:", e.message);
}

// Check node_modules
import fs from "fs";
const pdfParsePackage = JSON.parse(fs.readFileSync("./node_modules/pdf-parse/package.json"));
console.log("\nMain export:", pdfParsePackage.main);
console.log("Exports:", pdfParsePackage.exports ? Object.keys(pdfParsePackage.exports) : "N/A");
