import http from 'http';
import { randomUUID } from 'crypto';

const RESERVATION_MODES = new Set(['atomic', 'none']);
const DEFAULT_RESERVATION_TTL_MS = 5 * 60 * 1000;
const MIN_RESERVATION_TTL_MS = 50;
const DEFAULT_CLEANUP_INTERVAL_MS = 100;
const MAX_TRACKED_BOOKED_SLOT_IDS = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pickDelay(config = {}) {
  const base = Math.max(0, toInt(config.latencyMs, 0));
  const jitter = Math.max(0, toInt(config.latencyJitterMs, 0));
  return base + (jitter ? Math.floor(Math.random() * (jitter + 1)) : 0);
}

function chance(probability = 0) {
  return Math.random() < Math.max(0, Math.min(1, Number(probability) || 0));
}

function normalizeReservationMode(value = 'atomic') {
  const normalized = String(value || 'atomic').trim().toLowerCase() || 'atomic';
  if (!RESERVATION_MODES.has(normalized)) {
    throw new TypeError(`Invalid reservationMode "${value}". Expected one of: ${Array.from(RESERVATION_MODES).join(', ')}`);
  }
  return normalized;
}

function makeSlotId(index, now = Date.now()) {
  return new Date(now + (index + 1) * 30 * 60 * 1000).toISOString();
}

function normalizeScenarioConfig(config = {}) {
  return {
    slotProbability: Math.max(0, Math.min(1, Number(config.slotProbability ?? 0.8))),
    minSlots: Math.max(0, toInt(config.minSlots, 1)),
    maxSlots: Math.max(1, toInt(config.maxSlots, 3)),
    failureProbability: Math.max(0, Math.min(1, Number(config.failureProbability ?? 0))),
    disappearProbability: Math.max(0, Math.min(1, Number(config.disappearProbability ?? 0))),
    latencyMs: Math.max(0, toInt(config.latencyMs, 0)),
    latencyJitterMs: Math.max(0, toInt(config.latencyJitterMs, 0)),
    healAfterFailures: Math.max(0, toInt(config.healAfterFailures, 0)),
    disappearFirstBookingOnly: Boolean(config.disappearFirstBookingOnly),
    reservationMode: normalizeReservationMode(config.reservationMode ?? 'atomic'),
    reservationTtlMs: Math.max(MIN_RESERVATION_TTL_MS, toInt(config.reservationTtlMs, DEFAULT_RESERVATION_TTL_MS)),
    name: String(config.name || 'mock-booking').trim() || 'mock-booking',
  };
}

function createInitialState(config = {}) {
  return {
    config: normalizeScenarioConfig(config),
    slotInventory: new Map(),
    reservations: new Map(),
    mutationQueue: Promise.resolve(),
    stats: {
      appointmentsCalls: 0,
      bookCalls: 0,
      successfulBookings: 0,
      failedBookings: 0,
      falsePositives: 0,
      availabilityFailures: 0,
      totalRequests: 0,
      generatedSlots: 0,
      disappearedSlots: 0,
      reservationsIssued: 0,
      reservationBookings: 0,
      lastAdvertisedSlots: [],
      bookedSlotIds: [],
    },
  };
}

function appendBounded(list = [], value, limit = MAX_TRACKED_BOOKED_SLOT_IDS) {
  const next = [...(Array.isArray(list) ? list : []), value];
  const boundedLimit = Math.max(1, Number(limit) || MAX_TRACKED_BOOKED_SLOT_IDS);
  return next.slice(-boundedLimit);
}

function cloneSlot(slot = {}) {
  return { ...slot };
}

function listCurrentSlots(state) {
  return Array.from(state.slotInventory.values()).map((slot) => cloneSlot(slot));
}

function snapshotReservations(state) {
  return Object.fromEntries(
    Array.from(state.reservations.entries()).map(([token, reservation]) => [token, { ...reservation }]),
  );
}

function getEffectiveFailureProbability(state) {
  const healAfterFailures = Math.max(0, Number(state?.config?.healAfterFailures || 0));
  if (healAfterFailures > 0 && Number(state?.stats?.availabilityFailures || 0) >= healAfterFailures) {
    return 0;
  }
  return Math.max(0, Math.min(1, Number(state?.config?.failureProbability || 0)));
}

function withStateLock(state, work) {
  const run = state.mutationQueue.then(() => work());
  state.mutationQueue = run.catch(() => {});
  return run;
}

function cloneScenarioConfig(state) {
  return { ...(state?.config || {}) };
}

function buildReservation(state, slotId) {
  const token = `rsv-${randomUUID()}`;
  const expiresAt = new Date(Date.now() + Math.max(MIN_RESERVATION_TTL_MS, Number(state.config.reservationTtlMs) || DEFAULT_RESERVATION_TTL_MS)).toISOString();
  state.reservations.set(token, { slotId, expiresAt, claimed: false });
  state.stats.reservationsIssued += 1;
  return { token, expiresAt };
}

function clearReservations(state) {
  state.reservations = new Map();
}

function pruneReservationForSlot(state, slotId) {
  for (const [token, reservation] of state.reservations.entries()) {
    if (String(reservation?.slotId || '') === String(slotId || '')) {
      state.reservations.delete(token);
    }
  }
}

function removeSlotFromInventory(state, slotId) {
  const normalizedSlotId = String(slotId || '').trim();
  if (!normalizedSlotId) return false;
  const removed = state.slotInventory.delete(normalizedSlotId);
  if (removed) {
    pruneReservationForSlot(state, normalizedSlotId);
  }
  return removed;
}

function rotateReservationForSlot(state, slotId) {
  const slot = state.slotInventory.get(String(slotId || '').trim());
  if (!slot || state.config.reservationMode !== 'atomic') return null;
  pruneReservationForSlot(state, slot.id);
  const reservation = buildReservation(state, slot.id);
  const nextSlot = {
    ...slot,
    reservationToken: reservation.token,
    reservationExpiresAt: reservation.expiresAt,
  };
  state.slotInventory.set(nextSlot.id, nextSlot);
  return reservation;
}

function pruneExpiredReservations(state, now = Date.now()) {
  let pruned = 0;
  for (const [token, reservation] of Array.from(state.reservations.entries())) {
    if (reservation?.claimed) {
      state.reservations.delete(token);
      pruned += 1;
      continue;
    }
    if (Date.parse(reservation?.expiresAt || '') <= now) {
      state.reservations.delete(token);
      pruned += 1;
      if (state.config.reservationMode === 'atomic' && state.slotInventory.has(String(reservation?.slotId || '').trim())) {
        rotateReservationForSlot(state, reservation.slotId);
      }
    }
  }
  return pruned;
}

function generateSlots(state) {
  const { config } = state;
  state.stats.appointmentsCalls += 1;

  pruneExpiredReservations(state);
  if (chance(getEffectiveFailureProbability(state))) {
    state.stats.availabilityFailures += 1;
    return { ok: false, statusCode: 503, body: { ok: false, error: 'temporary-upstream-failure' } };
  }

  const shouldExposeSlots = chance(config.slotProbability);
  if (!shouldExposeSlots) {
    state.slotInventory = new Map();
    clearReservations(state);
    state.stats.lastAdvertisedSlots = [];
    return { ok: true, statusCode: 200, body: { ok: true, slots: [], generatedAt: new Date().toISOString() } };
  }

  const slotCount = Math.max(config.minSlots, Math.min(config.maxSlots, config.minSlots + Math.floor(Math.random() * Math.max(1, config.maxSlots - config.minSlots + 1))));
  const nextInventory = new Map();
  clearReservations(state);
  const nextSlots = Array.from({ length: slotCount }, (_, index) => {
    const slotId = makeSlotId(index);
    const slotDate = new Date(slotId);
    const slotTime = slotDate.toISOString().slice(11, 19);
    const slotDay = slotDate.toISOString().slice(0, 10);
    const slot = {
      id: slotId,
      slotId,
      label: `Appointment ${index + 1}`,
      value: slotId,
      date: slotDay,
      time: slotTime,
      dateTime: slotId,
    };
    if (config.reservationMode === 'atomic') {
      const reservation = buildReservation(state, slotId);
      slot.reservationToken = reservation.token;
      slot.reservationExpiresAt = reservation.expiresAt;
    }
    nextInventory.set(slot.id, slot);
    return slot;
  });
  state.slotInventory = nextInventory;
  state.stats.generatedSlots += nextSlots.length;
  state.stats.lastAdvertisedSlots = nextSlots.map((slot) => slot.id);
  return {
    ok: true,
    statusCode: 200,
    body: {
      ok: true,
      slots: nextSlots,
      generatedAt: new Date().toISOString(),
    },
  };
}

function extractSelectedSlot(body = {}) {
  const raw = body?.selectedSlot;
  if (raw && typeof raw === 'object') {
    return String(raw.slotId || raw.id || raw.value || raw.raw?.slotId || raw.raw?.id || raw.raw?.value || '').trim();
  }
  return String(raw || '').trim();
}

function extractReservationToken(body = {}) {
  const raw = body?.selectedSlot;
  if (raw && typeof raw === 'object') {
    return String(raw.reservationToken || raw.token || raw.raw?.reservationToken || raw.raw?.token || '').trim();
  }
  return String(body?.reservationToken || body?.token || '').trim();
}

function getReservationRecord(state, reservationToken = '', slotId = '') {
  if (!reservationToken) return null;
  pruneExpiredReservations(state);
  const record = state.reservations.get(reservationToken) || null;
  if (!record || record.claimed) return null;
  if (slotId && String(record.slotId || '') !== String(slotId)) return null;
  return record;
}

function handleBook(state, body = {}) {
  state.stats.bookCalls += 1;
  pruneExpiredReservations(state);
  const requestedSlotId = extractSelectedSlot(body);
  const reservationToken = extractReservationToken(body);
  const reservation = getReservationRecord(state, reservationToken, requestedSlotId);
  const slotId = requestedSlotId || String(reservation?.slotId || '').trim();
  const available = state.slotInventory.get(String(slotId || '').trim()) || null;

  if (!slotId || !available) {
    state.stats.failedBookings += 1;
    return { ok: false, statusCode: 409, body: { ok: false, error: 'slot-unavailable', reason: 'not-advertised' } };
  }

  if (state.config.reservationMode === 'atomic' && !reservation) {
    state.stats.failedBookings += 1;
    return { ok: false, statusCode: 409, body: { ok: false, error: 'reservation-required', slotId } };
  }

  if (chance(getEffectiveFailureProbability(state))) {
    state.stats.failedBookings += 1;
    return { ok: false, statusCode: 503, body: { ok: false, error: 'booking-upstream-failure' } };
  }

  if (!reservation && state.config.disappearFirstBookingOnly && state.stats.falsePositives === 0) {
    removeSlotFromInventory(state, slotId);
    state.stats.falsePositives += 1;
    state.stats.disappearedSlots += 1;
    state.stats.failedBookings += 1;
    return { ok: false, statusCode: 409, body: { ok: false, error: 'slot-disappeared', slotId, mode: 'disappear-first-booking-only' } };
  }

  if (!reservation && chance(state.config.disappearProbability)) {
    removeSlotFromInventory(state, slotId);
    state.stats.falsePositives += 1;
    state.stats.disappearedSlots += 1;
    state.stats.failedBookings += 1;
    return { ok: false, statusCode: 409, body: { ok: false, error: 'slot-disappeared', slotId } };
  }

  if (reservation && reservationToken && state.reservations.has(reservationToken)) {
    state.reservations.set(reservationToken, {
      ...reservation,
      claimed: true,
    });
    state.stats.reservationBookings += 1;
  }
  removeSlotFromInventory(state, slotId);
  state.stats.successfulBookings += 1;
  state.stats.bookedSlotIds = appendBounded(state.stats.bookedSlotIds, slotId);
  return {
    ok: true,
    statusCode: 200,
    body: {
      ok: true,
      status: 'confirmed',
      appointmentId: `appt-${slotId}`,
      slotId,
      reservationTokenUsed: reservationToken || null,
    },
  };
}

function renderMockBookingPortalHtml() {
  return [
    '<!doctype html>',
    '<html>',
    '  <head><title>Mock Booking Portal</title></head>',
    '  <body>',
    '    <h1>Mock Booking Portal</h1>',
    '    <p>Available endpoints: <code>/appointments</code> and <code>/book</code></p>',
    '    <form action="/appointments" method="get">',
    '      <input name="kind" value="slots" />',
    '      <button type="submit">Check availability</button>',
    '    </form>',
    '    <form action="/book" method="post">',
    '      <input name="selectedSlot" value="2026-01-01T09:00:00.000Z" />',
    '      <button type="submit">Book appointment</button>',
    '    </form>',
    '    <script>',
    "      window.__BOOKING_ENDPOINTS__ = ['/appointments?kind=slots', '/book'];",
    "      fetch('/appointments?kind=slots').catch(() => null);",
    '    </script>',
    '  </body>',
    '</html>',
  ].join('\n');
}

function sendJson(res, statusCode, body) {
  let payload = '';
  let finalStatusCode = statusCode;
  try {
    payload = JSON.stringify(body);
  } catch {
    finalStatusCode = 500;
    payload = JSON.stringify({ ok: false, error: 'response-serialization-failed' });
  }

  try {
    res.writeHead(finalStatusCode, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(payload);
  } catch {
    if (!res.headersSent) {
      res.writeHead(500, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
    }
    res.end('{"ok":false,"error":"response-write-failed"}');
  }
}

function json(res, statusCode, body) {
  return sendJson(res, statusCode, body);
}

function html(res, body) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function replaceState(state, scenario = {}) {
  const nextState = createInitialState(scenario);
  return withStateLock(state, async () => {
    state.config = nextState.config;
    state.slotInventory = nextState.slotInventory;
    state.reservations = nextState.reservations;
    state.stats = nextState.stats;
    return { scenario: state.config, stats: state.stats };
  });
}

function startReservationCleanupJob(state) {
  const timer = setInterval(() => {
    withStateLock(state, async () => {
      pruneExpiredReservations(state);
    }).catch(() => {});
  }, DEFAULT_CLEANUP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

export async function startMockBookingServer({ port = 0, scenario = {} } = {}) {
  const state = createInitialState(scenario);
  const cleanupTimer = startReservationCleanupJob(state);

  const server = http.createServer(async (req, res) => {
    const requestSnapshot = await withStateLock(state, async () => {
      state.stats.totalRequests += 1;
      return {
        config: cloneScenarioConfig(state),
      };
    });
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const delayMs = pickDelay(requestSnapshot.config);
    if (delayMs > 0) await sleep(delayMs);

    if (req.method === 'GET' && url.pathname === '/') {
      return html(res, renderMockBookingPortalHtml());
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, scenario: state.config.name });
    }

    if (req.method === 'GET' && url.pathname === '/stats') {
      const snapshot = await withStateLock(state, async () => ({
        ok: true,
        scenario: state.config,
        effectiveFailureProbability: getEffectiveFailureProbability(state),
        stats: state.stats,
        currentSlots: listCurrentSlots(state),
        reservations: snapshotReservations(state),
      }));
      return json(res, 200, snapshot);
    }

    if (req.method === 'POST' && url.pathname === '/reset') {
      const body = await readBody(req);
      try {
        const currentScenario = await withStateLock(state, async () => cloneScenarioConfig(state));
        const resetResult = await replaceState(state, { ...currentScenario, ...(body?.scenario || {}) });
        return json(res, 200, { ok: true, scenario: resetResult.scenario });
      } catch (error) {
        return json(res, 400, { ok: false, error: error?.message || String(error) });
      }
    }

    if (req.method === 'GET' && url.pathname === '/appointments') {
      const result = await withStateLock(state, async () => generateSlots(state));
      return json(res, result.statusCode, result.body);
    }

    if (req.method === 'POST' && url.pathname === '/book') {
      const body = await readBody(req);
      const result = await withStateLock(state, async () => handleBook(state, body));
      return json(res, result.statusCode, result.body);
    }

    return json(res, 404, { ok: false, error: 'not-found', path: url.pathname });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const address = server.address();
  const selectedPort = typeof address === 'object' && address ? address.port : port;
  const baseUrl = `http://127.0.0.1:${selectedPort}`;

  return {
    port: selectedPort,
    baseUrl,
    scenario: state.config,
    async getStats() {
      return withStateLock(state, async () => ({
        scenario: state.config,
        effectiveFailureProbability: getEffectiveFailureProbability(state),
        stats: state.stats,
        currentSlots: listCurrentSlots(state),
        reservations: snapshotReservations(state),
      }));
    },
    async reset(nextScenario = null) {
      const currentScenario = await withStateLock(state, async () => cloneScenarioConfig(state));
      return replaceState(state, { ...currentScenario, ...(nextScenario || {}) });
    },
    async stop() {
      clearInterval(cleanupTimer);
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}