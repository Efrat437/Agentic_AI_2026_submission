const base = process.env.BASE_URL || 'http://localhost:3000';

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function run() {
  const start = await request('/api/government/appointments/attended/start', {
    method: 'POST',
    body: JSON.stringify({
      userId: 'ui-smoke',
      description: 'Attended smoke test for Arnona appointment',
      notes: 'smoke run',
      applicant: { notes: 'smoke applicant' },
      headless: true,
      timeoutMs: 90000,
    }),
  });
  const summarize = (label, payload) => {
    const body = payload?.body || {};
    const session = body?.session || {};
    const request = body?.request || {};
    const result = body?.result || {};
    console.log(label, JSON.stringify({
      status: payload?.status,
      ok: body?.ok,
      mode: body?.mode,
      requestId: request?.id || session?.requestId || null,
      requestStatus: request?.status || null,
      token: session?.token || null,
      state: session?.state || result?.state || null,
      submitted: session?.submitted ?? null,
      requiresHuman: session?.requiresHuman ?? null,
      approval: session?.approval || null,
      antiBotDetected: session?.antiBotDetected ?? null,
      noteTail: Array.isArray(session?.notes) ? session.notes.slice(-2) : [],
    }));
  };

  summarize('START', start);

  const token = start?.body?.session?.token;
  console.log('TOKEN', token || '');
  if (!token) return;

  const status1 = await request(`/api/government/appointments/attended/${encodeURIComponent(token)}/status`);
  summarize('STATUS1', status1);

  const resume = await request(`/api/government/appointments/attended/${encodeURIComponent(token)}/resume`, {
    method: 'POST',
    body: JSON.stringify({ applicant: { notes: 'smoke resume' } }),
  });
  summarize('RESUME', resume);

  const approve = await request(`/api/government/appointments/attended/${encodeURIComponent(token)}/approve-submit`, {
    method: 'POST',
    body: JSON.stringify({ approvedBy: 'smoke-human', reason: 'smoke approval gate check' }),
  });
  summarize('APPROVE', approve);

  const submit = await request(`/api/government/appointments/attended/${encodeURIComponent(token)}/submit`, {
    method: 'POST',
    body: '{}',
  });
  summarize('SUBMIT', submit);

  const stop = await request(`/api/government/appointments/attended/${encodeURIComponent(token)}/stop`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'smoke cleanup' }),
  });
  summarize('STOP', stop);
}

run().catch((err) => {
  console.error('SMOKE_ERROR', err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
