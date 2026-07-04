
import express from 'express';
import skills from '../skills/skillsRegistry.js';
import { readPool } from '../db/db.js';

const app = express();
app.use(express.json());

// Endpoint: Get last extracted receipt or by ID
app.get('/mcp/receipts/last', async (req, res) => {
  try {
    const { id } = req.query;
    let sql, params;
    if (id) {
      sql = 'SELECT * FROM receipts WHERE id = $1 ORDER BY created_at DESC LIMIT 1';
      params = [id];
    } else {
      sql = 'SELECT * FROM receipts ORDER BY created_at DESC LIMIT 1';
      params = [];
    }
    const { rows } = await readPool.query(sql, params);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, receipt: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Currency conversion endpoint
app.post('/mcp/currency-exchange', async (req, res) => {
  try {
    const { amount, from = 'USD', to = 'NIS' } = req.body;
    if (typeof amount !== 'number' || isNaN(amount)) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    const result = await skills.currencyExchangeSkill({ amount, from, to });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/mcp/embedding', async (req, res) => {
  const { text } = req.body;
  const embedding = await skills.embeddingSkill(text);
  res.json({ embedding });
});

// System Prompt for MCP Server
export const mcpServerPrompt = `
You are the MCP Server interface.
Rules:
- Expose endpoints for orchestrated receipt ingestion and query flows.
- Enforce permission checks for all API calls.
Tools:
- All orchestrator and agent endpoints
Few-shot:
Q: { "userId": 123, "action": "upload_receipt" }
A: { "status": "success", "recordId": 456 }
Chain-of-thought:
- Receive API call
- Route to orchestrator
- Enforce permission checks
- Output API response
`;

// Add endpoints for all skills and orchestrator as needed

// Endpoint: Upload receipt via MCP
import { receiptIngestionPipeline } from '../orchestrator/langgraph_pipeline.js';
import path from 'path';
import multer from 'multer';
import { saveFile } from '../utils/file_utils.js';
const upload = multer();

app.post('/mcp/receipts/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file || path.extname(req.file.originalname).toLowerCase() !== '.png') {
      return res.status(400).json({ error: 'Only PNG files are supported.' });
    }
    const destDir = path.resolve('uploads');
    const imagePath = await saveFile(req.file, destDir);
    const context = { userRole: 'writer', userId: req.body.userId || 'mcp_user' };
    const dbResult = await receiptIngestionPipeline(imagePath, context);
    res.json({ ok: true, receipt: dbResult });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Endpoint: Query receipts (SQL)
app.post('/mcp/receipts/query-sql', async (req, res) => {
  try {
    const { sql, userId } = req.body;
    // TODO: Add permission check for userId
    const result = await readPool.query(sql);
    res.json({ ok: true, rows: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Endpoint: Query receipts (Semantic RAG)
app.post('/mcp/receipts/query-rag', async (req, res) => {
  try {
    const { query, userId } = req.body;
    const ragResult = await skills.semanticRAGSkill(query, userId);
    res.json({ ok: true, answer: ragResult.answer });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Endpoint: Query receipts (SQL RAG)
app.post('/mcp/receipts/query-sqlrag', async (req, res) => {
  try {
    const { userQuery, userId } = req.body;
    const sqlRagResult = await skills.sqlRAGSkill(userQuery, userId);
    res.json({ ok: true, answer: sqlRagResult.answer });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Endpoint: Query receipts (Hybrid RAG)
app.post('/mcp/receipts/query-hybridrag', async (req, res) => {
  try {
    const { userQuery, userId } = req.body;
    const hybridRagResult = await skills.hybridRAGSkill(userQuery, userId);
    res.json({ ok: true, answer: hybridRagResult.answer });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(5000, () => console.log('MCP server running on port 5000'));
