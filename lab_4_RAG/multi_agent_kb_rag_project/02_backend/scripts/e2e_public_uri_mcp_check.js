import 'dotenv/config';

const MCP_BASE = process.env.MCP_BASE_URL || `http://${process.env.MCP_HOST || '127.0.0.2'}:${process.env.MCP_PORT || '4000'}`;
const MCP_KEY = process.env.MCP_SHARED_KEY || '';

function headers() {
  const h = { 'content-type': 'application/json' };
  if (MCP_KEY) h['x-mcp-key'] = MCP_KEY;
  return h;
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
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

  out.health = await requestJson(`${MCP_BASE}/mcp/health`);

  out.single = await requestJson(`${MCP_BASE}/mcp/call`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      name: 'fetch_public_uri_json',
      args: { url: 'https://www.tel-aviv.gov.il/pages/homepage.aspx', maxChars: 1200 },
    }),
  });

  out.batch = await requestJson(`${MCP_BASE}/mcp/call`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      name: 'fetch_public_uris_json',
      args: {
        urls: [
          'https://www.tel-aviv.gov.il/pages/homepage.aspx',
          'https://www.gov.il/he/departments/population_and_immigration_authority/govil-landing-page',
        ],
        maxChars: 900,
      },
    }),
  });

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
