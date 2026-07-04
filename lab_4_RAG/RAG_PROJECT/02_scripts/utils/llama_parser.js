import { LlamaParseReader } from "llamaindex";

export async function parseWithLlama(pdfPath) {
  const parser = new LlamaParseReader({
    apiKey: process.env.LLAMA_PARSE_API_KEY,
    resultType: "markdown", 
    verbose: true,
    parsingInstruction: `
      Extract all text.
      Preserve tables in markdown format.
      Perform OCR on images and tables.
      perform tesseract OCR to extract text from images and tables
      extract text and semantic content from images and tables within pdf files
      Extract captions and structured data.
    `,
  });

  const documents = await parser.loadData(pdfPath);

  return documents.map(doc => ({
    pageContent: doc.text,
    metadata: {
      source: "llama_parse",
      file: pdfPath,
    },
  }));
}