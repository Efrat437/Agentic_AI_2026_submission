import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import express from "express";
import { fileURLToPath, URL } from "url";
import { buildStreamingRAG as buildQAuthRAG } from "../02_scripts/rag_process_enhanced.js";
import { answerWithRAG, debugAnswer } from "../01_agent/rag_agent.js";

// ============================================================
// DIRNAME (needed for static files in ES modules)
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ============================================================
// LOAD ENV
// ============================================================

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
console.log("Resolved .env path:", envPath);

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.log("Loaded .env from  :", envPath);
} else {
  console.warn(".env not found at:", envPath);
}

console.log("DATABASE_URL      :", process.env.DATABASE_URL);
console.log("ANTHROPIC_API_KEY :", process.env.ANTHROPIC_API_KEY ? "set" : "NOT SET");

// ============================================================
// EXPRESS APP
// ============================================================

const app = express();
app.use(express.json());

// Serve static files from /public folder — this serves index.html
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// RAG STATE
// ============================================================

let ragData   = null;
let agent     = null;
let initError = null;

// ============================================================
// HEALTH
// ============================================================

app.get('/health', (req, res) => {
  if (initError)          return res.status(500).json({ status: 'error',        message: initError.message });
  if (!ragData || !agent) return res.status(503).json({ status: 'initializing', message: 'RAG pipeline loading' });
  res.json({ status: 'ready', message: 'RAG agent ready' });
});

// ============================================================
// ASK
// ============================================================

app.post('/ask', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question)          return res.status(400).json({ error: 'Missing field: question' });
    if (initError)          return res.status(500).json({ error: initError.message });
    if (!ragData || !agent) return res.status(503).json({ error: 'Still initializing, please wait' });

    console.log('\n[Server] Question: "' + question + '"');
    const { answer, chunks } = await answerWithRAG(ragData, question);
    res.json({ question, answer, chunks, timestamp: new Date().toISOString() });

  } catch (err) {
    console.error('[Server] /ask error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// DEBUG
// ============================================================

app.post('/debug', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question)          return res.status(400).json({ error: 'Missing field: question' });
    if (!ragData || !agent) return res.status(503).json({ error: 'Still initializing, please wait' });

    console.log('\n[Server] Debug: "' + question + '"');
    const { answer, chunks } = await debugAnswer(ragData, question);
    res.json({ question, answer, chunks, timestamp: new Date().toISOString() });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n[Server] Running on http://127.0.0.1:' + PORT);
  console.log('  GET  /       — browser UI');
  console.log('  GET  /health — status check');
  console.log('  POST /ask    — ask a question');
  console.log('  POST /debug  — debug mode');
  console.log('\n[Server] RAG pipeline initializing in background...');
});

// ============================================================
// RAG INITIALIZATION
// ============================================================

const initStartTime = Date.now();

(async () => {
  try {
    console.log('\n[Init] Starting RAG pipeline...');

    ragData = await buildQAuthRAG(
      'C:/Users/ADMIN/Desktop/Agentic_AI_2026/lab_4_RAG/RAG_PROJECT/03_data/the-modern-guide-to-oauth.pdf'
    );

    agent = {
      invoke: async ({ question }) => await answerWithRAG(ragData, question),
      debug : async (question, opts) => await debugAnswer(ragData, question, opts)
    };

    const elapsed = ((Date.now() - initStartTime) / 1000).toFixed(1);
    console.log('\n[Init] RAG ready in ' + elapsed + 's');
    console.log('[Init] Open http://127.0.0.1:' + PORT + ' in your browser');

  } catch (err) {
    initError = err;
    console.error('[Init] Error:', err.message);
  }
})();

// ============================================================
// KEEP ALIVE
// ============================================================

process.stdin.resume();

process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err.message);
});

process.on('unhandledRejection', (err) => {
  console.error('[Server] Unhandled rejection:', err && err.message ? err.message : err);
});

setInterval(function() {}, 30000);