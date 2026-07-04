// API endpoint for receipt upload
import express from 'express';
import multer from 'multer';
import path from 'path';
import { receiptIngestionPipeline } from '../orchestrator/langgraph_pipeline.js';
import { saveFile } from '../utils/file_utils.js';

const router = express.Router();
const upload = multer();

router.post('/receipts/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file || path.extname(req.file.originalname).toLowerCase() !== '.png') {
      return res.status(400).json({ error: 'Only PNG files are supported.' });
    }
    // Save file to disk
    const destDir = path.resolve('uploads');
    const imagePath = await saveFile(req.file, destDir);
    // Simulate user context (for permissions)
    // In production, extract userId from JWT/session
    const context = { userRole: 'writer', userId: req.body.userId || 'demo_user' };
    // Run pipeline
    const dbResult = await receiptIngestionPipeline(imagePath, context);
    res.json({ ok: true, receipt: dbResult });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
