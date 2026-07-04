import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const uiRoot = path.resolve(repoRoot, '01_fronted');

const UI_HOST = process.env.UI_HOST || '127.0.0.1';
const UI_PORT = Number(process.env.UI_PORT || '5173');
const BACKEND_BASE_URL = process.env.BACKEND_BASE_URL || 'http://127.0.0.1:3000';
const UI_PROXY_TIMEOUT_MS = Number(process.env.UI_PROXY_TIMEOUT_MS || '180000');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use(express.static(uiRoot));

async function proxyToBackend(req, res) {
  try {
    const target = `${BACKEND_BASE_URL}${req.originalUrl}`;
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body || {});
    const forwardedHeaders = Object.fromEntries(
      Object.entries(req.headers || {}).filter(([key, value]) => {
        if (value == null) return false;
        const lowerKey = String(key || '').toLowerCase();
        return !['host', 'connection', 'content-length'].includes(lowerKey);
      }),
    );
    if (body) {
      forwardedHeaders['content-type'] = 'application/json';
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, UI_PROXY_TIMEOUT_MS));

    const upstream = await fetch(target, {
      method: req.method,
      headers: forwardedHeaders,
      body,
      signal: controller.signal,
    });

    const text = await upstream.text();
    clearTimeout(timeout);
    res.status(upstream.status);

    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    res.setHeader('content-type', contentType);
    res.send(text);
  } catch (err) {
    if (err?.name === 'AbortError') {
      return res.status(504).json({
        error: `UI proxy timeout after ${UI_PROXY_TIMEOUT_MS}ms`,
        details: `Backend did not respond in time at ${BACKEND_BASE_URL}`,
      });
    }
    res.status(502).json({
      error: `UI proxy failed to reach backend at ${BACKEND_BASE_URL}`,
      details: err.message,
    });
  }
}

app.all('/ask', proxyToBackend);
app.all('/api/*', proxyToBackend);

app.get('*', (_req, res) => {
  res.sendFile(path.join(uiRoot, 'index.html'));
});

app.listen(UI_PORT, UI_HOST, () => {
  console.log(`UI server listening http://${UI_HOST}:${UI_PORT}`);
  console.log(`Serving static UI from: ${uiRoot}`);
  console.log(`Proxying /ask and /api/* to ${BACKEND_BASE_URL}`);
});
