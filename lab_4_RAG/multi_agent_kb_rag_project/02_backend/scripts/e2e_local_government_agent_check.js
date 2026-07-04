import 'dotenv/config';

const MCP_BASE = process.env.MCP_BASE_URL || `http://${process.env.MCP_HOST || '127.0.0.2'}:${process.env.MCP_PORT || '4000'}`;
const MCP_KEY = process.env.MCP_SHARED_KEY || '';

function headers() {
  const h = { 'content-type': 'application/json' };
  if (MCP_KEY) h['x-mcp-key'] = MCP_KEY;
  return h;
}

async function callTool(name, args = {}) {
  const res = await fetch(`${MCP_BASE}/mcp/call`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ name, args }),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, ok: res.ok, data };
}

async function main() {
  const out = {};

  out.health = await fetch(`${MCP_BASE}/mcp/health`).then(async (r) => ({ status: r.status, ok: r.ok, data: await r.json() }));

  out.newRequest = await callTool('new_request_for_goverment', {
    userId: 'verify-user',
    description: 'i would like to schedule an appointment in the city office to pay my bills',
  });

  const newId = out.newRequest?.data?.result?.request?.id;
  out.getStatus = newId
    ? await callTool('get_request_status', { id: newId })
    : { ok: false, error: 'no id from create request' };

  // Optional lightweight ingestion check on one page.
  out.ingestWebToRag = await callTool('ingest_municipality_web_to_rag', {
    urls: ['https://www.ashdod.muni.il/he-il/%d7%90%d7%aa%d7%a8-%d7%94%d7%a2%d7%99%d7%a8/'],
    truncate: false,
    chunkSize: 800,
    chunkOverlap: 100,
  });

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
