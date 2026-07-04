import OpenAI from 'openai';
import 'dotenv/config';

// Provider wrapper for embeddings with Entropic (generic HTTP), OpenAI, and Xenova local fallback.
// Usage: import { getEmbeddings } from './providers.js';

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

async function tryEntropic(texts) {
  const defaultUrl = 'https://api.entropic.ai/v1/embeddings';
  const url = process.env.ENTROPIC_API_URL || defaultUrl;
  const key = process.env.ENTROPIC_API_KEY;
  if (!key) throw new Error('Entropic not configured (ENTROPIC_API_KEY)');
  const model = process.env.ENTROPIC_MODEL || 'embed-1536'; // user can override
  const body = {
    model,
    input: texts,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Entropic request failed ${res.status}: ${txt}`);
  }
  const json = await res.json();
  // Try common response shapes
  try {
    if (Array.isArray(json.data) && json.data[0] && json.data[0].embedding) return json.data.map(d => d.embedding);
    if (Array.isArray(json.embeddings)) return json.embeddings;
    if (json.output && Array.isArray(json.output) && json.output[0] && json.output[0].embedding) return json.output.map(o => o.embedding);
    if (Array.isArray(json)) return json;
  } catch (e) {
    // fall through to error below
  }
  // If nothing matched, include the raw response in the error for debugging
  throw new Error('Unrecognized Entropic response shape: ' + JSON.stringify(json).slice(0, 1000));
}

async function tryOpenAI(texts) {
  if (!openai) throw new Error('OpenAI not configured');
  const resp = await openai.embeddings.create({ model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small', input: texts });
  if (!resp || !resp.data) throw new Error('OpenAI embeddings failed');
  return resp.data.map(o => o.embedding);
}

async function tryXenova(texts) {
  // Local CPU fallback using @xenova/transformers — typically returns 384-dim
  const transformers = await import('@xenova/transformers');
  const model = process.env.XENOVA_MODEL || 'Xenova/all-MiniLM-L6-v2';
  const pipeline = await transformers.pipeline('feature-extraction', model);
  const out = [];
  for (const t of texts) {
    const res = await pipeline(t);
    // Normalize many possible shapes to a single 1D numeric array per input.
    try {
      // TypedArray response (Float32Array, etc.)
      if (ArrayBuffer.isView(res)) {
        out.push(Array.from(res).map(x => Number(x) || 0));
        continue;
      }

      // Object with dims and data (Xenova may return { dims: [...], type: 'float32', data: { '0':.. } })
      if (res && typeof res === 'object' && Array.isArray(res.dims) && res.data != null) {
        // Build flat numeric array from res.data (supports typed arrays, arrays, or numeric-keyed objects)
        let flat = [];
        const d = res.data;
        if (ArrayBuffer.isView(d)) {
          flat = Array.from(d).map(x => Number(x) || 0);
        } else if (Array.isArray(d)) {
          flat = d.flat(Infinity).map(x => Number(x) || 0);
        } else if (typeof d === 'object') {
          const keys = Object.keys(d).sort((a, b) => Number(a) - Number(b));
          flat = keys.map(k => Number(d[k]) || 0);
        }

        const dims = res.dims.map(Number);
        // dims: [batch, seq, dim] or [batch, dim] or [dim]
        if (dims.length === 3) {
          const [, seq, dim] = dims;
          // If flat length doesn't match expected, try to proceed with available data
          const rows = [];
          for (let i = 0; i < seq; i++) {
            const start = i * dim;
            rows.push(flat.slice(start, start + dim).map(x => Number(x) || 0));
          }
          // Mean-pool across sequence dimension
          const sums = new Array(rows[0]?.length || dim).fill(0);
          let count = 0;
          for (const row of rows) {
            if (!row || row.length === 0) continue;
            for (let j = 0; j < row.length; j++) sums[j] += Number(row[j]) || 0;
            count++;
          }
          if (count === 0) { out.push([]); continue; }
          out.push(sums.map(s => s / count));
          continue;
        }
        if (dims.length === 2) {
          const dim = dims[1];
          out.push(flat.slice(0, dim).map(x => Number(x) || 0));
          continue;
        }
        if (dims.length === 1) {
          const dim = dims[0];
          out.push(flat.slice(0, dim).map(x => Number(x) || 0));
          continue;
        }

        // fallback to flat
        out.push(flat.map(x => Number(x) || 0));
        continue;
      }

      // If nested arrays (sequence x hidden), mean-pool over sequence
      if (Array.isArray(res)) {
        if (res.length > 0 && Array.isArray(res[0])) {
          const seq = res;
          const hiddenSize = seq[0].length || 0;
          const sums = new Array(hiddenSize).fill(0);
          let count = 0;
          for (const row of seq) {
            if (!Array.isArray(row)) continue;
            for (let i = 0; i < hiddenSize; i++) sums[i] += Number(row[i]) || 0;
            count++;
          }
          if (count === 0) { out.push([]); continue; }
          out.push(sums.map(s => s / count));
          continue;
        }
        // 1D numeric array
        if (res.length > 0 && typeof res[0] === 'number') {
          out.push(res.map(x => Number(x) || 0));
          continue;
        }
      }

      // Unknown shape — print sample for debugging and return empty vector
      console.debug('tryXenova: unrecognized pipeline response shape for text:', String(t).slice(0, 60), 'response sample:', JSON.stringify(res).slice(0, 800));
      out.push([]);
    } catch (e) {
      console.error('tryXenova: error normalizing response:', e);
      out.push([]);
    }
  }
  return out;
}

async function tryAnthropic(texts) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Anthropic not configured (ANTHROPIC_API_KEY)');
  const url = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/embeddings';
  const model = process.env.ANTHROPIC_MODEL || 'claude-embed-2';
  const body = { model, input: texts };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Anthropic accepts API key as either Authorization or x-api-key depending on setup
      'Authorization': `Bearer ${key}`,
      'x-api-key': key,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Anthropic request failed ${res.status}: ${txt}`);
  }
  const json = await res.json();
  // common shapes
  if (Array.isArray(json.data) && json.data[0] && json.data[0].embedding) return json.data.map(d => d.embedding);
  if (Array.isArray(json.embeddings)) return json.embeddings;
  if (json.output && Array.isArray(json.output) && json.output[0] && json.output[0].embedding) return json.output.map(o => o.embedding);
  throw new Error('Unrecognized Anthropic response shape: ' + JSON.stringify(json).slice(0,1000));
}

// Add env flag: if set to 'true', try Xenova local model first to avoid cloud quotas
const PREFER_LOCAL = String(process.env.PREFER_LOCAL_EMBEDDINGS || process.env.PREFER_LOCAL || '').toLowerCase() === 'true';

export async function getEmbeddings(texts = []) {
  if (!Array.isArray(texts)) throw new Error('texts must be an array');

  const errors = [];

  // Optionally prefer local Xenova
  if (PREFER_LOCAL) {
    try {
      console.debug('PREFER_LOCAL=true — attempting Xenova local embeddings first');
      const out = await tryXenova(texts);
      console.debug(`Xenova returned embeddings dim=${(out && out[0] && out[0].length) || 'unknown'}`);
      return out;
    } catch (e) { errors.push({ provider: 'xenova', error: e.message || String(e) }); console.error('Xenova error:', e); }
  }

  // If Entropic is configured, prefer it and immediately fall back to Xenova on failure
  if (process.env.ENTROPIC_API_KEY) {
    try {
      console.debug('Attempting Entropic embeddings...');
      const out = await tryEntropic(texts);
      console.debug(`Entropic returned embeddings dim=${(out && out[0] && out[0].length) || 'unknown'}`);
      return out;
    } catch (e) {
      errors.push({ provider: 'entropic', error: e.message || String(e) });
      console.error('Entropic error:', e);
      // immediate local fallback to Xenova to avoid blocking on cloud provider
      try {
        console.debug('Entropic failed — attempting Xenova local embeddings as fallback');
        const out = await tryXenova(texts);
        console.debug(`Xenova returned embeddings dim=${(out && out[0] && out[0].length) || 'unknown'}`);
        return out;
      } catch (xe) { errors.push({ provider: 'xenova', error: xe.message || String(xe) }); console.error('Xenova error after Entropic failure:', xe); }
    }
  }

  // Anthropic next (if configured)
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      console.debug('Attempting Anthropic embeddings...');
      const out = await tryAnthropic(texts);
      console.debug(`Anthropic returned embeddings dim=${(out && out[0] && out[0].length) || 'unknown'}`);
      return out;
    } catch (e) { errors.push({ provider: 'anthropic', error: e.message || String(e) }); console.error('Anthropic error:', e); }
  }

  // OpenAI next
  if (process.env.OPENAI_API_KEY) {
    try {
      console.debug('Attempting OpenAI embeddings...');
      const out = await tryOpenAI(texts);
      console.debug(`OpenAI returned embeddings dim=${(out && out[0] && out[0].length) || 'unknown'}`);
      return out;
    } catch (e) { errors.push({ provider: 'openai', error: e.message || String(e) }); console.error('OpenAI error:', e); }
  }

  // Last-resort: Xenova local embeddings
  try {
    console.debug('Attempting Xenova local embeddings (last-resort)...');
    const out = await tryXenova(texts);
    console.debug(`Xenova returned embeddings dim=${(out && out[0] && out[0].length) || 'unknown'}`);
    return out;
  } catch (e) { errors.push({ provider: 'xenova', error: e.message || String(e) }); console.error('Xenova error:', e); }

  const msg = `All embedding providers failed: ${JSON.stringify(errors)}`;
  throw new Error(msg);
}
