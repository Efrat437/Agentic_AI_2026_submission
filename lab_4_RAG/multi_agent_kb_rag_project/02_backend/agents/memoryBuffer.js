import 'dotenv/config';

const MAX_ITEMS_PER_AGENT = parseInt(process.env.AGENT_BUFFER_MAX_ITEMS || '20', 10);

const buffers = new Map();

function normalize(value, fallback = 'anonymous') {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function makeKey(agent, userId) {
  return `${normalize(agent)}::${normalize(userId)}`;
}

export function appendBufferEntry({ agent, userId = 'anonymous', type = 'event', payload = {} }) {
  const key = makeKey(agent, userId);
  const current = buffers.get(key) || [];
  current.unshift({
    ts: new Date().toISOString(),
    type,
    payload,
  });

  if (current.length > MAX_ITEMS_PER_AGENT) current.length = MAX_ITEMS_PER_AGENT;
  buffers.set(key, current);
  return current[0];
}

export function readBuffer({ agent, userId = 'anonymous', limit = 5 } = {}) {
  const key = makeKey(agent, userId);
  const current = buffers.get(key) || [];
  return current.slice(0, Math.max(0, limit));
}

export function getBufferSnapshot({ userId = 'anonymous' } = {}) {
  const normalizedUser = normalize(userId);
  const snapshot = {};
  for (const [key, entries] of buffers.entries()) {
    const [agent, uid] = key.split('::');
    if (uid !== normalizedUser) continue;
    snapshot[agent] = entries;
  }
  return snapshot;
}

export function clearBuffer({ agent = null, userId = 'anonymous' } = {}) {
  const normalizedUser = normalize(userId);
  if (agent != null && agent !== '') {
    buffers.delete(makeKey(agent, normalizedUser));
    return;
  }

  for (const key of Array.from(buffers.keys())) {
    const [, uid] = key.split('::');
    if (uid === normalizedUser) {
      buffers.delete(key);
    }
  }
}
