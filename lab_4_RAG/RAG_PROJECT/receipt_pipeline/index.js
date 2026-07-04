// Main entry point for the receipt pipeline API
import express from 'express';
import uploadRouter from './api/upload.js';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());
app.use('/api', uploadRouter);

app.listen(PORT, () => {
  console.log(`Receipt pipeline API running on port ${PORT}`);
});
