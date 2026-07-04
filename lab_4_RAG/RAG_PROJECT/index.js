import 'dotenv/config';

// Smoke test: import installed packages and report availability
async function main() {
  console.log('RAG_PROJECT smoke test');

  try {
    const openai = await import('@langchain/openai');
    console.log('Imported @langchain/openai:', Object.keys(openai).slice(0,10));
  } catch (e) {
    console.error('Failed to import @langchain/openai:', e.message);
  }

  try {
    const langchain = await import('langchain');
    console.log('Imported langchain:', Object.keys(langchain).slice(0,10));
  } catch (e) {
    console.error('Failed to import langchain:', e.message);
  }

  try {
    const chroma = await import('chromadb');
    console.log('Imported chromadb:', Object.keys(chroma).slice(0,10));
  } catch (e) {
    console.error('Failed to import chromadb:', e.message);
  }

  try {
    const llama = await import('llama-parse');
    console.log('Imported llama-parse:', Object.keys(llama).slice(0,10));
  } catch (e) {
    console.error('Failed to import llama-parse:', e.message);
  }

  console.log('Smoke test complete.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
