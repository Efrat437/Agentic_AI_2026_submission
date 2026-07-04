import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import dotenv from 'dotenv';

const rootDir = path.resolve(process.cwd());
const ragProjectDir = path.resolve(rootDir, '../RAG_PROJECT');
const receiptEnvPath = path.resolve(ragProjectDir, 'receipt_pipeline/.env');

function loadDatabaseUrlFromReceiptEnv() {
  if (!fs.existsSync(receiptEnvPath)) {
    return process.env.DATABASE_URL || null;
  }

  const parsed = dotenv.parse(fs.readFileSync(receiptEnvPath, 'utf8'));
  const user = parsed.DB_USER || process.env.DB_USER || 'langchain';
  const password = parsed.DB_PASSWORD || process.env.DB_PASSWORD || 'langchain';
  const host = parsed.DB_HOST || process.env.DB_HOST || 'localhost';
  const port = parsed.DB_PORT || process.env.DB_PORT || '5444';
  const database = parsed.DB_NAME || process.env.DB_NAME || 'langchain';

  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

function runNpmScript(scriptName, env) {
  const cmd = process.platform === 'win32' ? 'npm' : 'npm';
  const result = spawnSync(cmd, ['--prefix', ragProjectDir, 'run', scriptName], {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(`[rag:project:verify] Failed to run ${scriptName}:`, result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`[rag:project:verify] Script failed: ${scriptName} (exit ${result.status})`);
    process.exit(result.status || 1);
  }
}

const databaseUrl = loadDatabaseUrlFromReceiptEnv();
const env = { ...process.env };
if (databaseUrl) {
  env.DATABASE_URL = databaseUrl;
}

const args = new Set(process.argv.slice(2));
const pdfOnly = args.has('--pdf-only');
const receiptOnly = args.has('--receipt-only');

const start = Date.now();
console.log(`[rag:project:verify] Using RAG project: ${ragProjectDir}`);
if (env.DATABASE_URL) {
  console.log('[rag:project:verify] DATABASE_URL prepared from receipt_pipeline/.env');
}
if (!receiptOnly) {
  runNpmScript('agent:enhanced:pdf', env);
}
if (!pdfOnly) {
  runNpmScript('agent:enhanced:receipt', env);
}
const totalSec = ((Date.now() - start) / 1000).toFixed(2);

console.log(`rag:project:verify completed in ${totalSec}s`);
