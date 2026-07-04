/**
 * self_extending_agent.js
 *
 * Self-Extending Agent Architecture using LangGraph.
 *
 * This agent autonomously:
 *   1. Discovers APIs from any website (browser automation + JS scan)
 *   2. Creates DynamicApiTool instances at runtime for every discovered endpoint
 *   3. Executes the full booking flow:
 *        discover_api → check_availability → decide → notify_user → human_gate → book_slot → otp_validate → done
 *        with retry loops and error handling at every step
 *   4. Heals broken CSS selectors by asking the LLM to inspect the live DOM
 *      and suggest replacements automatically
 *
 * Graph topology:
 *   START → discover_api → check_availability → decide → [notify_user → human_gate → book_slot | book_slot | wait_before_retry]
 *                                                                     ↘                              ↘
 *                                                                       done                           otp_validate → done
 *                        ↓ (max retries exceeded)
 *                       error → END
 *
 * @module self_extending_agent
 */

import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import OpenAI from 'openai';
import { updateGovernmentRequestStatus } from '../../agents/dbTools.js';
import { inspectBookingSiteNetwork } from './browser_appointment_agent.js';
import {
  deriveBookingDecision,
  mapBookingStatusToRequestStatus,
  normalizeBookingState,
  normalizeSelectedBookingSlot,
  selectPreferredBookingSlot,
} from './booking_workflow.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const AGENT_RUN_STORE = path.resolve(process.cwd(), 'tmp', 'self-extending-agent-runs.json');
const AGENT_LEARNING_STORE = path.resolve(process.cwd(), 'tmp', 'self-extending-agent-learning.json');
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TOOL_TIMEOUT_MS = 30000;
const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 2;
const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 350;
const MAX_SLOT_TOOLS = 3;
const MAX_BOOK_TOOLS = 3;
const MAX_OTP_TOOLS = 2;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeJson(text = '', fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function safeHostFromUrl(url = '') {
  try {
    return new URL(String(url || '')).host || '';
  } catch {
    return '';
  }
}

function normalizeEndpointKey(method = 'GET', url = '') {
  return `${String(method || 'GET').toUpperCase()} ${String(url || '').trim()}`;
}

function toIsoNow() {
  return new Date().toISOString();
}

function defaultResilienceMetrics() {
  return {
    circuitBreakerOpenedCount: 0,
    circuitBreakerSkippedCount: 0,
    transientRecoveryCount: 0,
    learnedEndpointsUpdated: 0,
    learningBoostedCandidates: 0,
  };
}

function mergeFlowLogs(state = {}, patch = {}) {
  return [
    ...(Array.isArray(state.flowLog) ? state.flowLog : []),
    ...(Array.isArray(patch.flowLog) ? patch.flowLog : []),
  ];
}

function buildLearningConfig(endpointHarvesting = {}) {
  const circuitBreaker = endpointHarvesting?.circuitBreaker;
  return {
    enabled: endpointHarvesting?.selfLearning !== false,
    circuitBreakerEnabled: circuitBreaker?.enabled !== false,
    circuitBreakerThreshold: Math.max(1, Number(circuitBreaker?.failureThreshold || DEFAULT_CIRCUIT_BREAKER_THRESHOLD) || DEFAULT_CIRCUIT_BREAKER_THRESHOLD),
    circuitBreakerCooldownMs: Math.max(100, Number(circuitBreaker?.cooldownMs || DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS) || DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS),
  };
}

function buildPersistenceSnapshot(state = {}, patch = {}, nodeName = '') {
  const mergedState = {
    ...state,
    ...patch,
    flowLog: mergeFlowLogs(state, patch),
  };
  const bookingState = normalizeBookingState({
    priorState: state.bookingState || null,
    availableSlots: mergedState.availableSlots || [],
    selectedSlot: mergedState.selectedSlot || null,
    bookingStatus: mergedState.bookingStatus || state.bookingStatus || 'initialized',
    currentStep: mergedState.currentStep || nodeName || state.currentStep || null,
    completed: Boolean(mergedState.completed),
    lastChecked: mergedState.lastChecked || state.lastChecked || null,
    userConfirmation: Boolean(mergedState.userConfirmation),
    autoBook: Boolean(mergedState.autoBook),
    decision: mergedState.decision || null,
    nextCheckAt: mergedState.nextCheckAt || null,
    notification: mergedState.notificationResult || state.notificationResult || null,
    confirmationGranted: extractConfirmationGranted(mergedState.applicantPayload),
    requiresHumanGate: Boolean(mergedState.humanGateResult?.pending),
    preferredSlot: mergedState.applicantPayload?.selectedSlot || mergedState.applicantPayload?.preferredSlot || state.bookingState?.preferred_slot || '',
    preferredDate: mergedState.applicantPayload?.preferredDate || state.bookingState?.preferred_date || '',
    preferredTimeRanges: mergedState.applicantPayload?.preferredTimeRanges || state.bookingState?.preferred_time_ranges || [],
    preferredTimeWindow: mergedState.applicantPayload?.preferredTimeWindow || null,
    retry: {
      retry_count: Number(mergedState.retryCount || 0),
      transient_failure_count: Number(mergedState.transientFailureCount || 0),
      last_failure_kind: mergedState.lastFailureKind || null,
    },
    timeZone: mergedState.applicantPayload?.slotTimeZone || state.bookingState?.slot_timezone || state.bookingState?.timezone || 'Asia/Jerusalem',
  });

  return {
    status: mapBookingStatusToRequestStatus(bookingState.booking_status),
    notes: {
      source: 'self-extending-agent',
      websiteUrl: mergedState.websiteUrl,
      runId: mergedState.runId,
      currentNode: nodeName || mergedState.currentStep || null,
      bookingState,
      resilience: {
        metrics: mergedState.resilienceMetrics || defaultResilienceMetrics(),
        circuitBreakerState: mergedState.circuitBreakerState || {},
        lastFailureKind: mergedState.lastFailureKind || null,
      },
      selfLearning: mergedState.learningContext || null,
      latestStep: {
        step: nodeName || mergedState.currentStep || null,
        bookingStatus: bookingState.booking_status,
        completed: Boolean(mergedState.completed),
        finalError: mergedState.finalError || null,
      },
      flowTail: mergeFlowLogs(state, patch).slice(-8),
    },
  };
}

async function persistTrackedRequestState(state = {}, patch = {}, nodeName = '') {
  const requestId = Number(state.requestId);
  if (!Number.isInteger(requestId) || requestId <= 0) return;
  try {
    const snapshot = buildPersistenceSnapshot(state, patch, nodeName);
    await updateGovernmentRequestStatus({
      id: requestId,
      status: snapshot.status,
      notes: snapshot.notes,
    });
  } catch {
    // Persistence is best-effort; booking flow should continue.
  }
}

function withTrackedPersistence(nodeName, handler) {
  return async function trackedNode(state) {
    const patch = await handler(state);
    await persistTrackedRequestState(state, patch, nodeName);
    return patch;
  };
}

async function readLearningStore() {
  try {
    const raw = await fs.readFile(AGENT_LEARNING_STORE, 'utf8');
    const parsed = safeJson(raw, {});
    return {
      updatedAt: parsed?.updatedAt || null,
      hosts: parsed?.hosts && typeof parsed.hosts === 'object' ? parsed.hosts : {},
    };
  } catch {
    return { updatedAt: null, hosts: {} };
  }
}

async function writeLearningStore(store = {}) {
  await fs.mkdir(path.dirname(AGENT_LEARNING_STORE), { recursive: true });
  await fs.writeFile(AGENT_LEARNING_STORE, JSON.stringify({
    updatedAt: toIsoNow(),
    hosts: store?.hosts && typeof store.hosts === 'object' ? store.hosts : {},
  }, null, 2), 'utf8');
}

function applyLearningToApis(apis = [], hostLearning = {}) {
  let boostedCount = 0;
  const endpoints = hostLearning?.endpoints && typeof hostLearning.endpoints === 'object' ? hostLearning.endpoints : {};
  const learned = (Array.isArray(apis) ? apis : []).map((api) => {
    const endpointKey = normalizeEndpointKey(api?.method, api?.url);
    const record = endpoints[endpointKey] || null;
    const successCount = Number(record?.successCount || 0);
    const failureCount = Number(record?.failureCount || 0);
    const transientFailureCount = Number(record?.transientFailureCount || 0);
    const reliability = successCount / Math.max(1, successCount + failureCount);
    const learningBonus = successCount > 0
      ? Math.round(reliability * 18) + Math.min(10, successCount)
      : (transientFailureCount > 0 ? -Math.min(8, transientFailureCount * 2) : 0);
    if (learningBonus !== 0) boostedCount += 1;
    return {
      ...api,
      endpointKey,
      learnedStats: record,
      learningBonus,
      score: Number(api?.score || 0) + learningBonus,
    };
  }).sort((a, b) => (Number(b.score || 0) - Number(a.score || 0)));

  return { apis: learned, boostedCount };
}

function getToolEndpointKey(tool = {}) {
  return normalizeEndpointKey(tool?.endpoint?.method || tool?.method || 'GET', tool?.endpoint?.url || tool?.url || '');
}

function getCircuitSnapshot(state = {}, tool = {}) {
  const endpointKey = getToolEndpointKey(tool);
  const current = state?.circuitBreakerState?.[endpointKey] || {};
  return {
    endpointKey,
    state: {
      consecutiveFailures: Math.max(0, Number(current?.consecutiveFailures || 0)),
      openedUntil: Number(current?.openedUntil || 0),
      halfOpen: Boolean(current?.halfOpen),
      lastFailureKind: current?.lastFailureKind || null,
      openedCount: Math.max(0, Number(current?.openedCount || 0)),
    },
  };
}

function shouldSkipForCircuitBreaker(state = {}, tool = {}) {
  const config = buildLearningConfig(state.endpointHarvesting || {});
  if (!config.circuitBreakerEnabled) {
    return { skip: false, endpointKey: getToolEndpointKey(tool), breakerState: getCircuitSnapshot(state, tool).state };
  }
  const snapshot = getCircuitSnapshot(state, tool);
  if (snapshot.state.openedUntil > Date.now()) {
    return { skip: true, endpointKey: snapshot.endpointKey, breakerState: snapshot.state };
  }
  if (snapshot.state.openedUntil && snapshot.state.openedUntil <= Date.now()) {
    return {
      skip: false,
      endpointKey: snapshot.endpointKey,
      breakerState: { ...snapshot.state, halfOpen: true },
    };
  }
  return { skip: false, endpointKey: snapshot.endpointKey, breakerState: snapshot.state };
}

function markCircuitBreakerSuccess(state = {}, tool = {}, priorState = null) {
  const endpointKey = getToolEndpointKey(tool);
  return {
    ...(state.circuitBreakerState || {}),
    [endpointKey]: {
      consecutiveFailures: 0,
      openedUntil: 0,
      halfOpen: false,
      lastFailureKind: null,
      openedCount: Math.max(0, Number(priorState?.openedCount || 0)),
    },
  };
}

function markCircuitBreakerFailure(state = {}, tool = {}, failureKind = 'hard_failure', priorState = null) {
  const config = buildLearningConfig(state.endpointHarvesting || {});
  const endpointKey = getToolEndpointKey(tool);
  const base = priorState || getCircuitSnapshot(state, tool).state;
  const consecutiveFailures = Math.max(0, Number(base?.consecutiveFailures || 0)) + 1;
  const shouldOpen = config.circuitBreakerEnabled && failureKind === 'transient_upstream' && consecutiveFailures >= config.circuitBreakerThreshold;
  return {
    nextState: {
      ...(state.circuitBreakerState || {}),
      [endpointKey]: {
        consecutiveFailures,
        openedUntil: shouldOpen ? Date.now() + config.circuitBreakerCooldownMs : Number(base?.openedUntil || 0),
        halfOpen: false,
        lastFailureKind: failureKind,
        openedCount: Math.max(0, Number(base?.openedCount || 0)) + (shouldOpen ? 1 : 0),
      },
    },
    opened: shouldOpen,
  };
}

async function persistEndpointLearning({ websiteUrl = '', events = [] } = {}) {
  const host = safeHostFromUrl(websiteUrl);
  if (!host || !Array.isArray(events) || events.length === 0) {
    return { host, updatedEndpoints: 0 };
  }

  const store = await readLearningStore();
  const hostEntry = store.hosts?.[host] && typeof store.hosts[host] === 'object'
    ? store.hosts[host]
    : { endpoints: {}, updatedAt: null };
  const endpoints = hostEntry.endpoints && typeof hostEntry.endpoints === 'object' ? { ...hostEntry.endpoints } : {};
  const touched = new Set();

  for (const event of events) {
    const endpointKey = normalizeEndpointKey(event?.method, event?.url);
    if (!String(endpointKey).trim()) continue;
    const current = endpoints[endpointKey] || {
      method: String(event?.method || 'GET').toUpperCase(),
      url: String(event?.url || '').trim(),
      role: String(event?.role || '').trim() || null,
      successCount: 0,
      failureCount: 0,
      transientFailureCount: 0,
      slotConflictCount: 0,
      hardFailureCount: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureKind: null,
    };
    if (event?.ok) {
      current.successCount = Math.max(0, Number(current.successCount || 0)) + 1;
      current.lastSuccessAt = event.recordedAt || toIsoNow();
      current.lastFailureKind = null;
    } else {
      current.failureCount = Math.max(0, Number(current.failureCount || 0)) + 1;
      current.lastFailureAt = event.recordedAt || toIsoNow();
      current.lastFailureKind = event.failureKind || 'hard_failure';
      if (event.failureKind === 'transient_upstream') current.transientFailureCount = Math.max(0, Number(current.transientFailureCount || 0)) + 1;
      else if (event.failureKind === 'slot_conflict') current.slotConflictCount = Math.max(0, Number(current.slotConflictCount || 0)) + 1;
      else current.hardFailureCount = Math.max(0, Number(current.hardFailureCount || 0)) + 1;
    }
    current.updatedAt = toIsoNow();
    endpoints[endpointKey] = current;
    touched.add(endpointKey);
  }

  store.hosts = {
    ...(store.hosts || {}),
    [host]: {
      ...hostEntry,
      updatedAt: toIsoNow(),
      endpoints,
    },
  };
  await writeLearningStore(store);
  return { host, updatedEndpoints: touched.size };
}

function detectApiKind(url = '', method = 'GET') {
  const u = String(url || '').toLowerCase();
  const m = String(method || 'GET').toUpperCase();
  if (/(slot|avail|available|availables|calendar|times?|free|open|possibleappointments)/.test(u) && m === 'GET') return 'slots';
  if (/(\/appointments([/?]|$)|\bappointments\b)/.test(u) && m === 'GET') return 'slots';
  if (/(book|schedule|reserve|submit|create|appoint)/.test(u) && ['POST', 'PUT', 'PATCH'].includes(m)) return 'schedule';
  if (/otp|verify|confirm|validate|code/.test(u)) return 'otp';
  return 'unknown';
}

function scoreApi(url = '', method = 'GET') {
  const u = String(url || '').toLowerCase();
  const m = String(method || 'GET').toUpperCase();
  let score = 0;
  if (/\/api\//.test(u)) score += 25;
  if (/appointments\/api\//.test(u)) score += 18;
  if (/\.svc\/|_vti_bin/.test(u)) score += 12;
  if (/analytics|clarity|tiktok|facebook|google-analytics|hotjar|pixel/.test(u)) return -99;
  if (/slot|avail|available|availables|calendar|times?|possibleappointments/.test(u)) score += 20;
  if (/(\/appointments([/?]|$)|\bappointments\b)/.test(u) && m === 'GET') score += 18;
  if (/book|schedule|reserve|submit|create/.test(u)) score += 20;
  if (/departmentid=|date=|time=|select-date=/.test(u)) score += 10;
  if (/kind=slots/.test(u)) score += 12;
  if (/otp|verify|confirm/.test(u)) score += 15;
  if (m === 'POST') score += 5;
  return score;
}

function flattenAvailabilityMap(map = {}, source = 'availability-map') {
  const slots = [];
  for (const [date, values] of Object.entries(map || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '').trim())) continue;
    if (!Array.isArray(values) || values.length === 0) continue;
    for (const entry of values) {
      const time = String(entry?.time || entry?.start || entry || '').trim();
      if (!time) continue;
      const dateTime = `${date}T${time}`;
      slots.push({
        id: dateTime,
        slotId: dateTime,
        date,
        time,
        dateTime,
        label: `${date} ${time}`,
        source,
      });
    }
  }
  return slots;
}

export function extractSlots(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data.slice(0, 50);
  if (Array.isArray(data?.slots)) return data.slots.slice(0, 50);
  if (Array.isArray(data?.data)) return data.data.slice(0, 50);
  if (Array.isArray(data?.times)) return data.times.slice(0, 50);
  if (Array.isArray(data?.availableTimes)) return data.availableTimes.slice(0, 50);
  for (const [key, value] of Object.entries(data || {})) {
    if (!value || Array.isArray(value) || typeof value !== 'object') continue;
    const flattened = flattenAvailabilityMap(value, key);
    if (flattened.length) return flattened.slice(0, 50);
  }
  if (typeof data === 'object') {
    const flattened = flattenAvailabilityMap(data, 'root');
    if (flattened.length) return flattened.slice(0, 50);
  }
  return [];
}

function normalizeSlotRecord(slot, index = 0) {
  if (slot && typeof slot === 'object') {
    const rawSlot = slot.raw && typeof slot.raw === 'object' ? slot.raw : slot;
    const label = String(
      slot.label
      || slot.display
      || slot.title
      || slot.datetime
      || slot.dateTime
      || slot.start
      || slot.time
      || slot.date
      || `slot-${index + 1}`,
    ).trim();
    const value = String(
      slot.value
      || slot.id
      || slot.slotId
      || slot.datetime
      || slot.dateTime
      || slot.start
      || label,
    ).trim();
    return { label, value, raw: rawSlot };
  }

  const text = String(slot || `slot-${index + 1}`).trim();
  return { label: text, value: text, raw: slot };
}

function selectPreferredSlot(state = {}, slots = []) {
  const bookingState = state?.bookingState && typeof state.bookingState === 'object' ? state.bookingState : {};
  return selectPreferredBookingSlot({
    selectedSlot: state?.selectedSlot || null,
    availableSlots: slots,
    preferredSlot: state?.applicantPayload?.selectedSlot || state?.applicantPayload?.preferredSlot || bookingState?.preferred_slot || '',
    preferredDate: state?.applicantPayload?.preferredDate || bookingState?.preferred_date || '',
    preferredTimeRanges: state?.applicantPayload?.preferredTimeRanges || bookingState?.preferred_time_ranges || [],
    preferredTimeWindow: state?.applicantPayload?.preferredTimeWindow || null,
    timeZone: state?.applicantPayload?.slotTimeZone || bookingState?.slot_timezone || bookingState?.timezone || 'Asia/Jerusalem',
  });
}

function slotMatchesSelected(slot, selectedSlot) {
  const selected = normalizeSelectedBookingSlot(selectedSlot);
  if (!slot || !selected) return false;
  const selectedStrong = [
    String(selected.value || '').trim(),
    String(selected.raw?.id || '').trim(),
    String(selected.raw?.slotId || '').trim(),
    String(selected.raw?.dateTime || '').trim(),
    String(selected.raw?.start || '').trim(),
  ].filter(Boolean);
  const slotStrong = [
    String(slot.value || '').trim(),
    String(slot.raw?.id || '').trim(),
    String(slot.raw?.slotId || '').trim(),
    String(slot.raw?.dateTime || '').trim(),
    String(slot.raw?.start || '').trim(),
  ].filter(Boolean);

  if (selectedStrong.length && slotStrong.length) {
    const selectedSet = new Set(selectedStrong);
    return slotStrong.some((value) => selectedSet.has(value));
  }

  return String(slot.label || '').trim() === String(selected.label || '').trim();
}

async function revalidateSlotBeforeBooking(state = {}) {
  const slotTools = Object.values(state.toolRegistry || {}).filter((tool) => tool.role === 'check_slots');
  if (!slotTools.length) return { ok: false, reason: 'no_slot_tools' };

  for (const tool of slotTools) {
    const result = await tool.invoke({});
    if (!result.ok) continue;

    const slots = extractSlots(result.data).map(normalizeSlotRecord);
    const selectedSlot = normalizeSelectedBookingSlot(state.selectedSlot);
    const matchedSlot = selectedSlot ? slots.find((slot) => slotMatchesSelected(slot, selectedSlot)) || null : null;
    const stillAvailable = Boolean(matchedSlot) || (!selectedSlot && slots.length > 0);
    const nextSelectedSlot = matchedSlot
      ? matchedSlot
      : selectPreferredSlot({ ...state, selectedSlot: null }, slots);

    return {
      ok: true,
      toolUsed: tool.name,
      slots,
      selectedSlot: nextSelectedSlot,
      stillAvailable,
    };
  }

  return { ok: false, reason: 'all_slot_tools_failed' };
}

function classifyToolFailure(result = {}) {
  const status = Number(result?.status || 0);
  const text = JSON.stringify(result?.data || result?.error || '').toLowerCase();
  if (status >= 500 || /temporary-upstream-failure|booking-upstream-failure|timeout|timed out|abort|fetch failed|network/.test(text)) {
    return 'transient_upstream';
  }
  if (/slot-disappeared|slot-unavailable|not-advertised/.test(text) || status === 409) {
    return 'slot_conflict';
  }
  return 'hard_failure';
}

function computeAdaptiveRetryBudget(state = {}) {
  const baseRetries = Math.max(1, Number(state.maxRetries) || DEFAULT_MAX_RETRIES);
  const observedLatencyMs = Math.max(0, Number(state.maxObservedToolLatencyMs) || 0);
  const transientFailureCount = Math.max(0, Number(state.transientFailureCount) || 0);
  let bonusRetries = 0;

  if (observedLatencyMs >= 700) bonusRetries += 2;
  else if (observedLatencyMs >= 350) bonusRetries += 1;

  if (transientFailureCount >= 1) bonusRetries += 1;
  if (String(state.lastFailureKind || '').trim() === 'slot_conflict') bonusRetries += 1;

  return Math.min(7, baseRetries + bonusRetries);
}

function buildBookingCandidateSlots(selectedSlot, availableSlots = [], maxCandidates = 3) {
  const ordered = [];
  const normalizedSelected = normalizeSelectedBookingSlot(selectedSlot);
  if (normalizedSelected) ordered.push(normalizedSelected);

  for (const slot of Array.isArray(availableSlots) ? availableSlots : []) {
    const normalized = normalizeSelectedBookingSlot(slot);
    if (!normalized) continue;
    if (ordered.some((existing) => slotMatchesSelected(normalized, existing))) continue;
    ordered.push(normalized);
  }

  return ordered.slice(0, Math.max(1, Number(maxCandidates) || 3));
}

async function invokeSlotToolWithResilience(tool, state = {}) {
  return invokeToolWithResilience(tool, {}, state, { maxAttempts: 3, retryTransient: true });
}

async function invokeToolWithResilience(tool, params = {}, state = {}, options = {}) {
  const attempts = [];
  const invocationEvents = [];
  let circuitBreakerState = { ...(state.circuitBreakerState || {}) };
  let resilienceMetrics = { ...defaultResilienceMetrics(), ...(state.resilienceMetrics || {}) };
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 1));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const circuitDecision = shouldSkipForCircuitBreaker({ ...state, circuitBreakerState }, tool);
    if (circuitDecision.skip) {
      attempts.push({ ok: false, skippedByCircuitBreaker: true, failureKind: 'circuit_open', elapsedMs: 0 });
      resilienceMetrics.circuitBreakerSkippedCount = Math.max(0, Number(resilienceMetrics.circuitBreakerSkippedCount || 0)) + 1;
      await new Promise((resolve) => setTimeout(resolve, Math.max(100, Number((state.endpointHarvesting?.circuitBreaker?.cooldownMs || DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS) / 2) || 100)));
      continue;
    }

    const result = await tool.invoke(params);
    attempts.push(result);
    if (result.ok) {
      circuitBreakerState = markCircuitBreakerSuccess({ ...state, circuitBreakerState }, tool, circuitDecision.breakerState);
      if (attempt > 1) {
        resilienceMetrics.transientRecoveryCount = Math.max(0, Number(resilienceMetrics.transientRecoveryCount || 0)) + 1;
      }
      invocationEvents.push({
        recordedAt: toIsoNow(),
        method: result?.method || tool?.endpoint?.method || 'GET',
        url: result?.url || tool?.endpoint?.url || '',
        role: tool?.role || null,
        ok: true,
        attempt,
      });
      return { result, attempts, failureKind: null, circuitBreakerState, resilienceMetrics, invocationEvents };
    }

    const failureKind = classifyToolFailure(result);
    const failureState = markCircuitBreakerFailure({ ...state, circuitBreakerState }, tool, failureKind, circuitDecision.breakerState);
    circuitBreakerState = failureState.nextState;
    if (failureState.opened) {
      resilienceMetrics.circuitBreakerOpenedCount = Math.max(0, Number(resilienceMetrics.circuitBreakerOpenedCount || 0)) + 1;
    }
    invocationEvents.push({
      recordedAt: toIsoNow(),
      method: result?.method || tool?.endpoint?.method || 'GET',
      url: result?.url || tool?.endpoint?.url || '',
      role: tool?.role || null,
      ok: false,
      attempt,
      failureKind,
    });
    if (failureKind !== 'transient_upstream' || options.retryTransient === false || attempt >= maxAttempts) {
      return { result, attempts, failureKind, circuitBreakerState, resilienceMetrics, invocationEvents };
    }

    await new Promise((resolve) => setTimeout(resolve, 150 * attempt + 100));
  }

  const lastResult = attempts[attempts.length - 1] || { ok: false, error: 'unknown-slot-tool-failure' };
  return {
    result: lastResult,
    attempts,
    failureKind: classifyToolFailure(lastResult),
    circuitBreakerState,
    resilienceMetrics,
    invocationEvents,
  };
}

function detectOtpRequired(data) {
  if (!data) return false;
  const text = JSON.stringify(data || {}).toLowerCase();
  return /otp|one.?time|verification.?code|sms.?code|2fa|two.?factor|אימות/.test(text);
}

function detectBookingSuccess(data) {
  if (!data) return false;
  const text = JSON.stringify(data || {}).toLowerCase();
  return /success|confirmed|approved|booked|scheduled|confirmation|appointment.?id/.test(text);
}

function extractConfirmationGranted(payload = null) {
  if (!payload || typeof payload !== 'object') return false;
  return Boolean(
    payload.confirmedBooking
    || payload.bookingApproved
    || payload.userApprovedBooking
    || payload.confirmBooking,
  );
}

function buildSlotNotification(state = {}) {
  const slots = Array.isArray(state.availableSlots) ? state.availableSlots : [];
  return {
    type: 'slots_found',
    requiresHuman: true,
    message: slots.length
      ? `Found ${slots.length} slot(s). Awaiting human confirmation before booking.`
      : 'No slots available right now.',
    slotCount: slots.length,
    selectedSlot: state.selectedSlot || null,
    availableSlots: slots,
    notifiedAt: new Date().toISOString(),
  };
}

// ─── LLM DOM Selector Healing ─────────────────────────────────────────────────

/**
 * When a CSS selector cascade fails, this function gets the live DOM from the
 * Playwright page, sends it to the LLM, and asks for new selector suggestions.
 *
 * @param {object} opts
 * @param {object} opts.page            - Playwright Page instance
 * @param {string} opts.intent          - What we're trying to click / find
 * @param {string[]} opts.failedSelectors - Selectors that already failed
 * @param {string} opts.openaiApiKey    - OpenAI API key
 * @returns {Promise<{ok:boolean, selectors:string[], rawDomLength:number}>}
 */
export async function healSelectorWithLLM({ page, intent = '', failedSelectors = [], openaiApiKey = '' } = {}) {
  if (!page || !openaiApiKey) {
    return { ok: false, selectors: [], reason: !page ? 'no_page' : 'no_api_key', rawDomLength: 0 };
  }

  let domSnapshot = '';
  try {
    domSnapshot = await page.evaluate(() => {
      // Trim to interactive elements only — much cheaper to send to LLM
      const interactiveEls = Array.from(
        document.querySelectorAll('button,a,[role="button"],input,select,form,label,[tabindex]'),
      ).slice(0, 300);
      return interactiveEls
        .map((el) => {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `id="${el.id}"` : '';
          const cls = el.className ? `class="${String(el.className).trim().split(/\s+/).slice(0, 4).join(' ')}"` : '';
          const role = el.getAttribute('role') ? `role="${el.getAttribute('role')}"` : '';
          const type = el.getAttribute('type') ? `type="${el.getAttribute('type')}"` : '';
          const text = String(el.innerText || el.textContent || el.getAttribute('aria-label') || el.value || '').trim().slice(0, 80);
          return `<${tag} ${[id, cls, role, type].filter(Boolean).join(' ')}>${text}</${tag}>`;
        })
        .join('\n')
        .slice(0, 7000);
    });
  } catch {
    // If page evaluation fails, try getting full HTML (truncated)
    try {
      const html = await page.content();
      domSnapshot = String(html || '').slice(0, 7000);
    } catch {
      return { ok: false, selectors: [], reason: 'dom_snapshot_failed', rawDomLength: 0 };
    }
  }

  const prompt = [
    'You are a browser automation expert analyzing a DOM structure.',
    `Goal: Find a CSS selector for: "${intent}"`,
    failedSelectors.length ? `Already tried (failed): ${failedSelectors.map((s) => `"${s}"`).join(', ')}` : '',
    '',
    'Relevant DOM elements:',
    '```html',
    domSnapshot,
    '```',
    '',
    'Return ONLY a JSON array of 4 CSS selectors, most specific first.',
    'Example: ["#submit-btn", "button.booking-submit", "form button[type=submit]", "button"]',
  ].filter((l) => l !== undefined).join('\n');

  try {
    const openai = new OpenAI({ apiKey: openaiApiKey });
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 250,
      temperature: 0.1,
    });

    const text = String(response.choices?.[0]?.message?.content || '').trim();
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      const parsed = safeJson(match[0], []);
      if (Array.isArray(parsed) && parsed.length) {
        const selectors = parsed
          .filter((s) => typeof s === 'string' && s.trim())
          .map((s) => s.trim())
          .slice(0, 4);
        return { ok: true, selectors, reason: 'llm_suggested', rawDomLength: domSnapshot.length };
      }
    }
    return { ok: false, selectors: [], reason: 'llm_parse_failed', rawText: text.slice(0, 200), rawDomLength: domSnapshot.length };
  } catch (err) {
    return { ok: false, selectors: [], reason: String(err?.message || err), rawDomLength: domSnapshot.length };
  }
}

// ─── Dynamic Tool Factory ─────────────────────────────────────────────────────

/**
 * Creates a callable tool object from a discovered API endpoint.
 * The tool is created at runtime — this is the "self-extending" mechanism.
 */
function createDynamicApiTool({ id, url, method, kind, score } = {}) {
  const toolId = id || randomUUID();
  const role = kind === 'otp' ? 'otp_validate' : (kind === 'schedule' ? 'book_slot' : 'check_slots');
  const name = `${role}_${toolId.slice(0, 8)}`;
  const capability = role === 'check_slots' ? 'list_slots' : (role === 'book_slot' ? 'reserve_slot' : 'verify_otp');
  const description = `Auto-discovered ${role} tool → ${method} ${url} [kind=${kind}, score=${score}]`;

  async function invoke(params = {}) {
    const resolvedMethod = role === 'book_slot' ? 'POST' : (String(method || 'GET').toUpperCase());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TOOL_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const resp = await fetch(url, {
        method: resolvedMethod,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain;q=0.8, */*;q=0.5',
        },
        body: resolvedMethod === 'GET' ? undefined : JSON.stringify(params || {}),
        signal: controller.signal,
      });
      const text = await resp.text();
      const data = safeJson(text, { raw: text.slice(0, 3000) });
      return { ok: resp.ok, status: resp.status, url, method: resolvedMethod, data, elapsedMs: Date.now() - startedAt };
    } catch (err) {
      return { ok: false, url, method: resolvedMethod, error: String(err?.message || err), elapsedMs: Date.now() - startedAt };
    } finally {
      clearTimeout(timer);
    }
  }

  return { name, role, capability, toolId, endpoint: { id: toolId, url, method, kind, score, capability }, description, invoke };
}

/**
 * Builds a tool registry from an array of discovered API endpoints.
 * Returns {registry: {[name]: tool}, extensionLog: string[]}
 */
function buildToolRegistry(apis = []) {
  const registry = {};
  const extensionLog = [];

  const slotApis = apis.filter((a) =>
    a.kind === 'slots' || (a.method === 'GET' && /slot|avail|calendar|times?|free/.test(String(a.url || '').toLowerCase())),
  ).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, MAX_SLOT_TOOLS);

  const bookApis = apis.filter((a) =>
    a.kind === 'schedule' || (['POST', 'PUT', 'PATCH'].includes(String(a.method || 'GET').toUpperCase()) &&
      /book|schedule|reserv|submit|create|appoint/.test(String(a.url || '').toLowerCase())),
  ).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, MAX_BOOK_TOOLS);

  const otpApis = apis.filter((a) =>
    a.kind === 'otp' || /otp|verify|confirm|validate/.test(String(a.url || '').toLowerCase()),
  ).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, MAX_OTP_TOOLS);

  // Fallback: use top-scored APIs when specific kinds are absent
  const sortedApis = [...apis].sort((a, b) => (b.score || 0) - (a.score || 0));
  const effectiveSlots = slotApis.length ? slotApis : sortedApis.filter((a) => String(a.method || 'GET').toUpperCase() === 'GET').slice(0, Math.min(2, MAX_SLOT_TOOLS));
  const effectiveBook = bookApis.length ? bookApis : sortedApis.filter((a) => ['POST', 'PUT', 'PATCH'].includes(String(a.method || 'GET').toUpperCase())).slice(0, Math.min(2, MAX_BOOK_TOOLS));

  for (const api of effectiveSlots) {
    const tool = createDynamicApiTool({ ...api, kind: 'slots' });
    registry[tool.name] = tool;
    extensionLog.push(`TOOL_CREATED kind=check_slots name=${tool.name} url=${api.url}`);
  }
  for (const api of effectiveBook) {
    const tool = createDynamicApiTool({ ...api, kind: 'schedule' });
    registry[tool.name] = tool;
    extensionLog.push(`TOOL_CREATED kind=book_slot name=${tool.name} url=${api.url}`);
  }
  for (const api of otpApis) {
    const tool = createDynamicApiTool({ ...api, kind: 'otp' });
    registry[tool.name] = tool;
    extensionLog.push(`TOOL_CREATED kind=otp_validate name=${tool.name} url=${api.url}`);
  }

  extensionLog.push(`REGISTRY_READY total=${Object.keys(registry).length} tools`);
  return { registry, extensionLog };
}

// ─── LangGraph State ──────────────────────────────────────────────────────────
// Reducers: arrays append, objects merge-last, scalars last-write-wins

const appendArray = (a, b) => [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
const lastWrite = (_, v) => v;
const mergeObj = (a, b) => ({ ...(a || {}), ...(b || {}) });

const AgentState = Annotation.Root({
  // ── Input (set once at graph start) ────────────────────────────────────────
  runId: Annotation({ reducer: lastWrite, default: () => randomUUID() }),
  requestId: Annotation({ reducer: lastWrite, default: () => null }),
  websiteUrl: Annotation({ reducer: lastWrite, default: () => '' }),
  requestText: Annotation({ reducer: lastWrite, default: () => '' }),
  applicantPayload: Annotation({ reducer: lastWrite, default: () => null }),
  headless: Annotation({ reducer: lastWrite, default: () => true }),
  maxRetries: Annotation({ reducer: lastWrite, default: () => DEFAULT_MAX_RETRIES }),
  pollIntervalMs: Annotation({ reducer: lastWrite, default: () => 5000 }),
  endpointHarvesting: Annotation({ reducer: lastWrite, default: () => ({}) }),
  userConfirmation: Annotation({ reducer: lastWrite, default: () => false }),
  autoBook: Annotation({ reducer: lastWrite, default: () => false }),

  // ── Discovery outputs ───────────────────────────────────────────────────────
  discoveredApis: Annotation({ reducer: lastWrite, default: () => [] }),
  toolRegistry: Annotation({ reducer: mergeObj, default: () => ({}) }),
  extensionLog: Annotation({ reducer: appendArray, default: () => [] }),
  learningContext: Annotation({ reducer: mergeObj, default: () => ({}) }),

  // ── Flow tracking ──────────────────────────────────────────────────────────
  currentStep: Annotation({ reducer: lastWrite, default: () => 'discover' }),
  retryCount: Annotation({ reducer: lastWrite, default: () => 0 }),
  decision: Annotation({ reducer: lastWrite, default: () => null }),
  nextCheckAt: Annotation({ reducer: lastWrite, default: () => null }),
  flowLog: Annotation({ reducer: appendArray, default: () => [] }),
  maxObservedToolLatencyMs: Annotation({ reducer: lastWrite, default: () => 0 }),
  transientFailureCount: Annotation({ reducer: lastWrite, default: () => 0 }),
  lastFailureKind: Annotation({ reducer: lastWrite, default: () => null }),
  circuitBreakerState: Annotation({ reducer: mergeObj, default: () => ({}) }),
  resilienceMetrics: Annotation({ reducer: mergeObj, default: () => defaultResilienceMetrics() }),
  endpointInvocationLog: Annotation({ reducer: appendArray, default: () => [] }),

  // ── Node results ───────────────────────────────────────────────────────────
  discoveryResult: Annotation({ reducer: lastWrite, default: () => null }),
  slotsResult: Annotation({ reducer: lastWrite, default: () => null }),
  notificationResult: Annotation({ reducer: lastWrite, default: () => null }),
  humanGateResult: Annotation({ reducer: lastWrite, default: () => null }),
  bookingResult: Annotation({ reducer: lastWrite, default: () => null }),
  otpResult: Annotation({ reducer: lastWrite, default: () => null }),
  availableSlots: Annotation({ reducer: lastWrite, default: () => [] }),
  selectedSlot: Annotation({ reducer: lastWrite, default: () => null }),
  bookingStatus: Annotation({ reducer: lastWrite, default: () => 'initialized' }),
  lastChecked: Annotation({ reducer: lastWrite, default: () => null }),
  slotIdentifiedAt: Annotation({ reducer: lastWrite, default: () => null }),

  // ── Selector healing log ───────────────────────────────────────────────────
  selectorHealingLog: Annotation({ reducer: appendArray, default: () => [] }),

  // ── Final outcome ──────────────────────────────────────────────────────────
  completed: Annotation({ reducer: lastWrite, default: () => false }),
  finalError: Annotation({ reducer: lastWrite, default: () => null }),
});

// ─── Node: discover_api ───────────────────────────────────────────────────────

async function nodeDiscoverApi(state) {
  const startedAt = Date.now();
  const flowStep = '[discover_api]';
  try {
    const learningConfig = buildLearningConfig(state.endpointHarvesting || {});
    const harvesting = {
      browserAutomationHarvesting: true,
      level: 'turbo20',
      strategy: 'high-level-efficient',
      ...(state.endpointHarvesting || {}),
    };

    const inspection = await inspectBookingSiteNetwork({
      bookingUrl: state.websiteUrl,
      intentText: state.requestText || 'discover API and check appointment slots',
      autonomousBrowse: true,
      maxAutonomousSteps: 4,
      maxNetworkEntries: 300,
      timeoutMs: Math.min(60000, (Number(harvesting.apiDiscoveryDeadlineMs) || 20000) + 8000),
      endpointHarvesting: harvesting,
    });

    // Collect all raw API candidates from all discovery sources
    const rawEntries = [
      ...(inspection.networkRequests || []),
      ...(inspection.automatedNetworkLogging?.apiLikeEntries || []),
      ...(inspection.pageAnalysis?.sourceApiMatches || []).map((u) => ({ url: u, method: 'GET', status: 200 })),
      ...(inspection.javascriptScan?.endpoints || []).map((u) => ({ url: u, method: 'GET', status: 200 })),
      ...(inspection.pageAnalysis?.forms || []).map((f) => ({ url: f?.action || '', method: f?.method || 'GET', status: 200 })),
    ];

    // Normalise, score, deduplicate
    const seen = new Set();
    const discoveredApis = rawEntries
      .map((entry) => {
        const url = String(entry.url || '').trim();
        if (!url || seen.has(url)) return null;
        seen.add(url);
        const method = String(entry.method || 'GET').toUpperCase();
        const score = scoreApi(url, method);
        if (score < 8) return null;
        return {
          id: randomUUID(),
          url,
          method,
          kind: detectApiKind(url, method),
          score,
          status: entry.status || null,
          source: entry.source || 'network',
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 40);

    const learningHost = safeHostFromUrl(state.websiteUrl);
    const learningStore = learningConfig.enabled ? await readLearningStore() : { hosts: {} };
    const hostLearning = learningStore.hosts?.[learningHost] || {};
    const learned = learningConfig.enabled ? applyLearningToApis(discoveredApis, hostLearning) : { apis: discoveredApis, boostedCount: 0 };

    const { registry, extensionLog } = buildToolRegistry(learned.apis);
    const elapsedMs = Date.now() - startedAt;

    return {
      discoveredApis: learned.apis,
      toolRegistry: registry,
      extensionLog,
      learningContext: {
        enabled: learningConfig.enabled,
        host: learningHost,
        boostedCandidates: learned.boostedCount,
      },
      resilienceMetrics: {
        ...(state.resilienceMetrics || defaultResilienceMetrics()),
        learningBoostedCandidates: Math.max(0, Number(state?.resilienceMetrics?.learningBoostedCandidates || 0)) + learned.boostedCount,
      },
      discoveryResult: {
        ok: true,
        elapsedMs,
        apiCount: learned.apis.length,
        toolCount: Object.keys(registry).length,
        networkCount: inspection.networkCount || 0,
        finalUrl: inspection.finalUrl || state.websiteUrl,
        selfHealing: inspection.selfHealing || null,
        systemGoal: inspection.systemGoal || null,
        selfLearning: {
          enabled: learningConfig.enabled,
          host: learningHost,
          boostedCandidates: learned.boostedCount,
        },
      },
      currentStep: 'check_availability',
      bookingStatus: 'checking_availability',
      flowLog: [`${flowStep} Found ${learned.apis.length} APIs, created ${Object.keys(registry).length} dynamic tools in ${elapsedMs}ms`],
    };
  } catch (err) {
    return {
      discoveryResult: { ok: false, error: String(err?.message || err) },
      currentStep: 'error',
      bookingStatus: 'error',
      flowLog: [`${flowStep} FAILED: ${String(err?.message || err)}`],
      finalError: String(err?.message || err),
    };
  }
}

// ─── Node: check_availability ────────────────────────────────────────────────

async function nodeCheckAvailability(state) {
  const flowStep = '[check_availability]';
  const checkedAt = new Date().toISOString();
  const slotTools = Object.values(state.toolRegistry || {}).filter((t) => t.role === 'check_slots');
  let maxObservedToolLatencyMs = Math.max(0, Number(state.maxObservedToolLatencyMs) || 0);
  let lastFailureKind = 'hard_failure';
  let circuitBreakerState = { ...(state.circuitBreakerState || {}) };
  let resilienceMetrics = { ...(state.resilienceMetrics || defaultResilienceMetrics()) };
  const endpointInvocationLog = [];

  if (!slotTools.length) {
    return {
      slotsResult: { ok: false, reason: 'no_slot_tools', slots: [] },
      availableSlots: [],
      selectedSlot: normalizeSelectedBookingSlot(state.selectedSlot),
      lastChecked: checkedAt,
      bookingStatus: 'slot_check_unavailable',
      currentStep: 'decide',
      flowLog: [`${flowStep} No slot-check tools discovered, moving to decide`],
    };
  }

  for (const tool of slotTools) {
    const resilient = await invokeSlotToolWithResilience({ ...tool }, { ...state, circuitBreakerState, resilienceMetrics });
    const result = resilient.result;
    lastFailureKind = resilient.failureKind || lastFailureKind;
    circuitBreakerState = resilient.circuitBreakerState || circuitBreakerState;
    resilienceMetrics = { ...resilienceMetrics, ...(resilient.resilienceMetrics || {}) };
    endpointInvocationLog.push(...(resilient.invocationEvents || []));
    maxObservedToolLatencyMs = Math.max(maxObservedToolLatencyMs, Number(result?.elapsedMs || 0));
    if (!result.ok) continue;

    const slots = extractSlots(result.data).map(normalizeSlotRecord);
    const selectedSlot = selectPreferredSlot(state, slots);
    return {
      slotsResult: { ok: true, toolUsed: tool.name, status: result.status, attemptCount: resilient.attempts.length, slots, raw: result.data },
      availableSlots: slots,
      selectedSlot,
      lastChecked: checkedAt,
      slotIdentifiedAt: slots.length ? checkedAt : state.slotIdentifiedAt,
      maxObservedToolLatencyMs,
      transientFailureCount: 0,
      lastFailureKind: null,
      circuitBreakerState,
      resilienceMetrics,
      endpointInvocationLog,
      bookingStatus: slots.length ? 'slots_found' : 'waiting_for_slots',
      currentStep: 'decide',
      flowLog: [`${flowStep} ${tool.name} returned ${slots.length} slot(s) after ${resilient.attempts.length} attempt(s)`],
    };
  }

  return {
    slotsResult: { ok: false, reason: 'all_slot_tools_failed' },
    availableSlots: [],
    selectedSlot: normalizeSelectedBookingSlot(state.selectedSlot),
    lastChecked: checkedAt,
    maxObservedToolLatencyMs,
    transientFailureCount: String(lastFailureKind) === 'transient_upstream' ? Math.max(0, Number(state.transientFailureCount) || 0) + 1 : Math.max(0, Number(state.transientFailureCount) || 0),
    lastFailureKind,
    circuitBreakerState,
    resilienceMetrics,
    endpointInvocationLog,
    bookingStatus: 'slot_check_failed',
    currentStep: 'decide',
    flowLog: [`${flowStep} All slot tools failed, moving to decide`],
  };
}

// ─── Node: decide ────────────────────────────────────────────────────────────

async function nodeDecide(state) {
  const flowStep = '[decide]';
  const confirmationGranted = extractConfirmationGranted(state.applicantPayload);
  const decision = deriveBookingDecision({
    availableSlots: state.availableSlots,
    selectedSlot: state.selectedSlot,
    preferredSlot: state?.applicantPayload?.selectedSlot || state?.applicantPayload?.preferredSlot || state?.bookingState?.preferred_slot || '',
    preferredDate: state?.applicantPayload?.preferredDate || state?.bookingState?.preferred_date || '',
    preferredTimeRanges: state?.applicantPayload?.preferredTimeRanges || state?.bookingState?.preferred_time_ranges || [],
    preferredTimeWindow: state?.applicantPayload?.preferredTimeWindow || null,
    autoBook: Boolean(state.autoBook || state.applicantPayload?.autoBook),
    confirmationGranted,
    slotCheckFailed: !state.slotsResult?.ok,
    retryCount: Number(state.retryCount || 0),
    transientFailureCount: Number(state.transientFailureCount || 0),
    pollIntervalMs: Number(state.pollIntervalMs || 5000),
    timeZone: state?.applicantPayload?.slotTimeZone || state?.bookingState?.slot_timezone || state?.bookingState?.timezone || 'Asia/Jerusalem',
  });

  const nextCheckAt = decision.shouldWait
    ? new Date(Date.now() + Math.max(1000, Number(state.pollIntervalMs) || 5000)).toISOString()
    : null;

  let currentStep = 'done';
  if (decision.shouldNotifyUser) {
    currentStep = 'notify_user';
  } else if (decision.requiresHumanGate) {
    currentStep = 'human_gate';
  } else if (decision.shouldBook) {
    currentStep = 'book_slot';
  } else if (decision.shouldWait) {
    currentStep = 'wait_before_retry';
  }

  return {
    decision: decision.decision,
    selectedSlot: decision.selectedSlot,
    nextCheckAt,
    bookingStatus: decision.bookingStatus,
    currentStep,
    flowLog: [`${flowStep} decision=${decision.decision} status=${decision.bookingStatus}`],
  };
}

// ─── Node: notify_user ───────────────────────────────────────────────────────

async function nodeNotifyUser(state) {
  const notification = buildSlotNotification(state);
  return {
    notificationResult: notification,
    bookingStatus: 'awaiting_user_confirmation',
    currentStep: 'human_gate',
    flowLog: [`[notify_user] Prepared user notification for ${notification.slotCount} slot(s)`],
  };
}

// ─── Node: human_gate ────────────────────────────────────────────────────────

async function nodeHumanGate(state) {
  const confirmationGranted = extractConfirmationGranted(state.applicantPayload);
  if (confirmationGranted) {
    return {
      humanGateResult: { ok: true, approved: true, approvedAt: new Date().toISOString() },
      bookingStatus: 'booking_ready',
      currentStep: 'book_slot',
      flowLog: ['[human_gate] Human approval supplied, proceeding to book_slot'],
    };
  }

  return {
    humanGateResult: { ok: true, approved: false, pending: true },
    bookingStatus: 'awaiting_user_confirmation',
    currentStep: 'done',
    flowLog: ['[human_gate] Awaiting human confirmation, stopping before booking'],
  };
}

// ─── Node: book_slot ──────────────────────────────────────────────────────────

async function nodeBookSlot(state) {
  const flowStep = '[book_slot]';
  const bookTools = Object.values(state.toolRegistry || {}).filter((t) => t.role === 'book_slot');
  let maxObservedToolLatencyMs = Math.max(0, Number(state.maxObservedToolLatencyMs) || 0);

  if (!bookTools.length) {
    return {
      bookingResult: { ok: false, reason: 'no_booking_tools' },
      bookingStatus: 'booking_failed',
      currentStep: 'error',
      flowLog: [`${flowStep} No booking tools available`],
      finalError: 'book_slot: no booking endpoints were discovered',
    };
  }

  const slotRevalidation = await revalidateSlotBeforeBooking(state);
  if (slotRevalidation.ok) {
    if (!slotRevalidation.slots.length) {
      return {
        availableSlots: [],
        selectedSlot: null,
        bookingResult: { ok: false, reason: 'no_slots_after_revalidation', toolUsed: slotRevalidation.toolUsed },
        bookingStatus: 'booking_retry_pending',
        currentStep: 'wait_before_retry',
        flowLog: [`${flowStep} Revalidation found no slots, waiting before retry`],
      };
    }

    const canAutoReselect = Boolean(state.autoBook || state.applicantPayload?.autoBook);
    if (state.selectedSlot && !slotRevalidation.stillAvailable && !canAutoReselect) {
      return {
        availableSlots: slotRevalidation.slots,
        selectedSlot: slotRevalidation.selectedSlot,
        bookingResult: { ok: false, reason: 'selected_slot_unavailable_after_revalidation', toolUsed: slotRevalidation.toolUsed },
        bookingStatus: 'booking_retry_pending',
        currentStep: 'wait_before_retry',
        flowLog: [`${flowStep} Selected slot became stale after revalidation, waiting before retry`],
      };
    }
  }

  const selectedSlot = slotRevalidation.ok ? slotRevalidation.selectedSlot : state.selectedSlot;
  const candidateSlots = buildBookingCandidateSlots(
    selectedSlot,
    slotRevalidation.ok ? slotRevalidation.slots : state.availableSlots,
    3,
  );
  let lastFailureKind = null;
  let circuitBreakerState = { ...(state.circuitBreakerState || {}) };
  let resilienceMetrics = { ...(state.resilienceMetrics || defaultResilienceMetrics()) };
  const endpointInvocationLog = [];

  for (const candidateSlot of candidateSlots) {
    const bookPayload = {
      ...(state.applicantPayload || {}),
      selectedSlot: candidateSlot?.raw || candidateSlot?.value || candidateSlot || null,
    };

    for (const tool of bookTools) {
      const resilient = await invokeToolWithResilience(tool, bookPayload, { ...state, circuitBreakerState, resilienceMetrics }, { maxAttempts: 3, retryTransient: true });
      const result = resilient.result;
      circuitBreakerState = resilient.circuitBreakerState || circuitBreakerState;
      resilienceMetrics = { ...resilienceMetrics, ...(resilient.resilienceMetrics || {}) };
      endpointInvocationLog.push(...(resilient.invocationEvents || []));
      maxObservedToolLatencyMs = Math.max(maxObservedToolLatencyMs, Number(result?.elapsedMs || 0));
      if (result.ok || detectBookingSuccess(result.data)) {
        const needsOtp = detectOtpRequired(result.data);
        return {
          bookingResult: {
            ok: true,
            toolUsed: tool.name,
            status: result.status,
            needsOtp,
            selectedSlot: candidateSlot || null,
            raw: result.data,
          },
          availableSlots: slotRevalidation.ok ? slotRevalidation.slots : state.availableSlots,
          selectedSlot: candidateSlot,
          maxObservedToolLatencyMs,
          transientFailureCount: 0,
          lastFailureKind: null,
          circuitBreakerState,
          resilienceMetrics,
          endpointInvocationLog,
          bookingStatus: needsOtp ? 'awaiting_otp' : 'booked',
          currentStep: needsOtp ? 'otp_validate' : 'done',
          flowLog: [`${flowStep} OK via ${tool.name}${needsOtp ? ' — OTP required' : ' — no OTP needed'}`],
        };
      }

      lastFailureKind = classifyToolFailure(result);
      if (lastFailureKind === 'slot_conflict') {
        break;
      }
      if (lastFailureKind === 'transient_upstream') {
        return {
          bookingResult: { ok: false, reason: 'booking_transient_failure', toolUsed: tool.name, raw: result.data || result.error || null },
          selectedSlot: candidateSlot,
          maxObservedToolLatencyMs,
          transientFailureCount: Math.max(0, Number(state.transientFailureCount) || 0) + 1,
          lastFailureKind,
          circuitBreakerState,
          resilienceMetrics,
          endpointInvocationLog,
          bookingStatus: 'booking_retry_pending',
          currentStep: 'wait_before_retry',
          flowLog: [`${flowStep} Transient booking failure via ${tool.name}, waiting before retry`],
        };
      }
    }
  }

  // All booking tools failed
  const newRetry = (state.retryCount || 0) + 1;
  const maxed = newRetry > computeAdaptiveRetryBudget(state);
  return {
    bookingResult: { ok: false, reason: lastFailureKind === 'slot_conflict' ? 'all_candidate_slots_conflicted' : 'all_booking_tools_failed' },
    selectedSlot: candidateSlots[0] || selectedSlot || null,
    maxObservedToolLatencyMs,
    transientFailureCount: lastFailureKind === 'transient_upstream' ? Math.max(0, Number(state.transientFailureCount) || 0) + 1 : Math.max(0, Number(state.transientFailureCount) || 0),
    lastFailureKind,
    circuitBreakerState,
    resilienceMetrics,
    endpointInvocationLog,
    bookingStatus: maxed ? 'booking_failed' : 'booking_retry_pending',
    currentStep: maxed ? 'error' : 'wait_before_retry',
    flowLog: [`${flowStep} All booking tools failed — ${maxed ? 'max retries reached' : 'wait/retry #' + newRetry}`],
    finalError: maxed ? 'book_slot: all tools failed after max retries' : null,
  };
}

// ─── Node: otp_validate ───────────────────────────────────────────────────────

async function nodeOtpValidate(state) {
  const flowStep = '[otp_validate]';
  const otpCode = state.applicantPayload?.otpCode || state.applicantPayload?.otp || '';
  const otpTools = Object.values(state.toolRegistry || {}).filter((t) => t.role === 'otp_validate');

  // If no OTP code provided, mark flow as needing human input (still "done" — caller will see needsHumanOtp)
  if (!otpCode) {
    return {
      otpResult: { ok: false, reason: 'otp_code_not_provided', needsHumanOtp: true },
      bookingStatus: 'awaiting_human_otp',
      currentStep: 'done',
      completed: true,
      flowLog: [`${flowStep} No OTP code in payload — human handoff required`],
    };
  }

  if (otpTools.length) {
    for (const tool of otpTools) {
      const result = await tool.invoke({ otp: otpCode, code: otpCode, verificationCode: otpCode });
      if (result.ok) {
        return {
          otpResult: { ok: true, toolUsed: tool.name, method: 'api', status: result.status },
          bookingStatus: 'booked',
          currentStep: 'done',
          completed: true,
          flowLog: [`${flowStep} OTP verified via API tool ${tool.name}`],
        };
      }
    }
  }

  // OTP API failed — retry if budget allows, otherwise done (operator may validate manually)
  const newRetry = (state.retryCount || 0) + 1;
  const maxed = newRetry > computeAdaptiveRetryBudget(state);
  return {
    otpResult: { ok: false, reason: 'otp_api_failed', needsHumanOtp: true },
    bookingStatus: maxed ? 'awaiting_human_otp' : 'otp_retry_pending',
    currentStep: maxed ? 'done' : 'wait_before_retry',
    completed: maxed,
    flowLog: [`${flowStep} OTP API failed — ${maxed ? 'done (human handoff)' : 'wait/retry #' + newRetry}`],
  };
}

// ─── Node: wait_before_retry ─────────────────────────────────────────────────

async function nodeWaitBeforeRetry(state) {
  const flowStep = '[wait_before_retry]';
  const retryCount = state.retryCount || 0;
  const maxRetries = computeAdaptiveRetryBudget(state);
  const nextRetry = retryCount + 1;

  if (nextRetry > maxRetries) {
    const noSlots = String(state.decision || '').trim() === 'wait_and_recheck' && String(state.bookingStatus || '').trim() === 'waiting_for_slots';
    return {
      currentStep: noSlots ? 'done' : 'error',
      bookingStatus: noSlots ? 'no_slots_available' : 'error',
      retryCount: nextRetry,
      completed: noSlots,
      flowLog: [`${flowStep} Max retries (${maxRetries}) reached`],
      finalError: noSlots ? null : 'max retries exceeded',
    };
  }

  await new Promise((r) => setTimeout(r, Math.max(1000, Number(state.pollIntervalMs) || 5000)));

  return {
    currentStep: 'check_availability',
    bookingStatus: 'checking_availability',
    retryCount: nextRetry,
    nextCheckAt: null,
    flowLog: [`${flowStep} Retry ${nextRetry}/${maxRetries} — going back to check_availability`],
  };
}

// ─── Node: done ───────────────────────────────────────────────────────────────

async function nodeDone(state) {
  return {
    completed: true,
    currentStep: 'done',
    flowLog: [`[done] Flow completed — ${state.bookingStatus || (state.bookingResult?.ok ? 'booked' : 'booking status unknown')}`],
  };
}

// ─── Node: error ─────────────────────────────────────────────────────────────

async function nodeError(state) {
  return {
    completed: false,
    currentStep: 'error',
    bookingStatus: 'error',
    flowLog: [`[error] Flow failed: ${state.finalError || 'unknown error'}`],
  };
}

// ─── Routing functions ────────────────────────────────────────────────────────

function routeAfterDiscover(state) {
  if (state.currentStep === 'error') return 'error';
  return 'check_availability';
}

function routeAfterCheckAvailability(state) {
  const step = state.currentStep;
  if (step === 'error') return 'error';
  return 'decide';
}

function routeAfterDecide(state) {
  const step = state.currentStep;
  if (step === 'notify_user') return 'notify_user';
  if (step === 'human_gate') return 'human_gate';
  if (step === 'book_slot') return 'book_slot';
  if (step === 'wait_before_retry') return 'wait_before_retry';
  if (step === 'error') return 'error';
  return 'done';
}

function routeAfterNotifyUser(state) {
  if (state.currentStep === 'error') return 'error';
  return 'human_gate';
}

function routeAfterHumanGate(state) {
  const step = state.currentStep;
  if (step === 'book_slot') return 'book_slot';
  if (step === 'error') return 'error';
  return 'done';
}

function routeAfterBook(state) {
  const step = state.currentStep;
  if (step === 'otp_validate') return 'otp_validate';
  if (step === 'wait_before_retry') return 'wait_before_retry';
  if (step === 'error') return 'error';
  return 'done';
}

function routeAfterOtp(state) {
  const step = state.currentStep;
  if (step === 'wait_before_retry') return 'wait_before_retry';
  return 'done';
}

function routeAfterWaitBeforeRetry(state) {
  if (state.currentStep === 'error') return 'error';
  if (state.currentStep === 'done') return 'done';
  return 'check_availability';
}

// ─── Graph construction ───────────────────────────────────────────────────────

function buildGraph() {
  // This graph intentionally uses single-path conditional routing only.
  // Each route function returns one next node, so there is no parallel fan-out
  // and therefore no branch-merge race to reconcile in state reducers here.
  return new StateGraph(AgentState)
    .addNode('discover_api', withTrackedPersistence('discover_api', nodeDiscoverApi))
    .addNode('check_availability', withTrackedPersistence('check_availability', nodeCheckAvailability))
    .addNode('decide', withTrackedPersistence('decide', nodeDecide))
    .addNode('notify_user', withTrackedPersistence('notify_user', nodeNotifyUser))
    .addNode('human_gate', withTrackedPersistence('human_gate', nodeHumanGate))
    .addNode('book_slot', withTrackedPersistence('book_slot', nodeBookSlot))
    .addNode('otp_validate', withTrackedPersistence('otp_validate', nodeOtpValidate))
    .addNode('wait_before_retry', withTrackedPersistence('wait_before_retry', nodeWaitBeforeRetry))
    .addNode('done', withTrackedPersistence('done', nodeDone))
    .addNode('error', withTrackedPersistence('error', nodeError))
    .addEdge(START, 'discover_api')
    .addConditionalEdges('discover_api', routeAfterDiscover)
    .addConditionalEdges('check_availability', routeAfterCheckAvailability)
    .addConditionalEdges('decide', routeAfterDecide)
    .addConditionalEdges('notify_user', routeAfterNotifyUser)
    .addConditionalEdges('human_gate', routeAfterHumanGate)
    .addConditionalEdges('book_slot', routeAfterBook)
    .addConditionalEdges('otp_validate', routeAfterOtp)
    .addConditionalEdges('wait_before_retry', routeAfterWaitBeforeRetry)
    .addEdge('done', END)
    .addEdge('error', END)
    .compile();
}

// ─── Run store (lightweight persistence) ──────────────────────────────────────

async function saveRunResult(runId, snapshot) {
  try {
    await fs.mkdir(path.dirname(AGENT_RUN_STORE), { recursive: true });
    let store = {};
    try {
      const raw = await fs.readFile(AGENT_RUN_STORE, 'utf8');
      store = safeJson(raw, {});
    } catch { /* no existing store */ }
    // Keep at most 50 run snapshots
    const keys = Object.keys(store);
    if (keys.length >= 50) {
      const oldest = keys.sort((a, b) => (store[a]?.startedAt || '') < (store[b]?.startedAt || '') ? -1 : 1)[0];
      delete store[oldest];
    }
    store[runId] = snapshot;
    await fs.writeFile(AGENT_RUN_STORE, JSON.stringify(store, null, 2), 'utf8');
  } catch { /* non-fatal */ }
}

export async function getAgentRun(runId) {
  try {
    const raw = await fs.readFile(AGENT_RUN_STORE, 'utf8');
    const store = safeJson(raw, {});
    return store[String(runId || '')] || null;
  } catch {
    return null;
  }
}

export async function listAgentRuns() {
  try {
    const raw = await fs.readFile(AGENT_RUN_STORE, 'utf8');
    const store = safeJson(raw, {});
    return Object.values(store)
      .sort((a, b) => (b?.startedAt || '') > (a?.startedAt || '') ? 1 : -1)
      .slice(0, 50);
  } catch {
    return [];
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Run the self-extending agent graph for a complete booking flow.
 *
 * @param {object} opts
 * @param {string}  opts.websiteUrl          - Target website to discover APIs on
 * @param {string}  opts.requestText         - Natural-language intent ("book arnona appointment")
 * @param {object}  [opts.applicantPayload]  - Form data for booking: {fullName, phone, email, otpCode, ...}
 * @param {boolean} [opts.headless]          - Headless browser (default true)
 * @param {number}  [opts.maxRetries]        - Max retry attempts per failing step (default 3)
 * @param {object}  [opts.endpointHarvesting] - Overrides for harvesting config
 * @returns {Promise<object>} Final agent state + structured result summary
 */
export async function runSelfExtendingAgent({
  websiteUrl = '',
  requestText = '',
  applicantPayload = null,
  requestId = null,
  headless = true,
  maxRetries = DEFAULT_MAX_RETRIES,
  endpointHarvesting = {},
} = {}) {
  if (!websiteUrl) return { ok: false, error: 'websiteUrl is required' };

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const learningConfig = buildLearningConfig(endpointHarvesting || {});

  const graph = buildGraph();

  const initialState = {
    runId,
    requestId: Number.isInteger(Number(requestId)) && Number(requestId) > 0 ? Number(requestId) : null,
    websiteUrl: String(websiteUrl).trim(),
    requestText: String(requestText || '').trim(),
    applicantPayload: applicantPayload || null,
    headless: Boolean(headless),
    maxRetries: Math.max(1, Math.min(6, Number(maxRetries) || DEFAULT_MAX_RETRIES)),
    pollIntervalMs: Math.max(1000, Math.min(60000, Number(applicantPayload?.pollIntervalMs || 5000) || 5000)),
    endpointHarvesting: endpointHarvesting || {},
    userConfirmation: Boolean(applicantPayload?.userConfirmation),
    autoBook: Boolean(applicantPayload?.autoBook),
    currentStep: 'discover',
    retryCount: 0,
    maxObservedToolLatencyMs: 0,
    transientFailureCount: 0,
    lastFailureKind: null,
    discoveredApis: [],
    toolRegistry: {},
    extensionLog: [],
    learningContext: {
      enabled: learningConfig.enabled,
      host: safeHostFromUrl(websiteUrl),
      boostedCandidates: 0,
    },
    flowLog: [],
    selectorHealingLog: [],
    circuitBreakerState: {},
    resilienceMetrics: defaultResilienceMetrics(),
    endpointInvocationLog: [],
    availableSlots: [],
    selectedSlot: applicantPayload?.selectedSlot ? normalizeSlotRecord(applicantPayload.selectedSlot) : null,
    bookingStatus: 'discovering_api',
    lastChecked: null,
    completed: false,
    finalError: null,
  };

  let finalState;
  try {
    finalState = await graph.invoke(initialState);
  } catch (err) {
    finalState = {
      ...initialState,
      completed: false,
      finalError: String(err?.message || err),
      currentStep: 'error',
      flowLog: [`[graph] Unhandled error: ${String(err?.message || err)}`],
    };
  }

  const elapsedMs = Date.now() - startedAtMs;
  const completed = Boolean(finalState?.completed);
  const bookingOk = Boolean(finalState?.bookingResult?.ok);
  const otpOk = Boolean(finalState?.otpResult?.ok);
  const needsHumanOtp = Boolean(finalState?.otpResult?.needsHumanOtp || finalState?.bookingResult?.needsOtp && !otpOk);
  const bookingStatus = String(finalState?.bookingStatus || '').trim() || 'unknown';
  const slotIdentificationMs = finalState?.slotIdentifiedAt
    ? Math.max(0, new Date(finalState.slotIdentifiedAt).getTime() - new Date(startedAt).getTime())
    : null;
  const retryEvents = Array.isArray(finalState?.flowLog)
    ? finalState.flowLog.filter((entry) => /wait_before_retry|Retry\s+\d+\//i.test(String(entry || ''))).length
    : 0;
  const learningPersistence = learningConfig.enabled
    ? await persistEndpointLearning({ websiteUrl, events: finalState?.endpointInvocationLog || [] })
    : { host: safeHostFromUrl(websiteUrl), updatedEndpoints: 0 };
  const resilienceMetrics = {
    ...defaultResilienceMetrics(),
    ...(finalState?.resilienceMetrics || {}),
    learnedEndpointsUpdated: learningPersistence.updatedEndpoints,
  };

  // Build structured result
  const result = {
    ok: completed || bookingOk || bookingStatus === 'awaiting_user_confirmation',
    runId,
    startedAt,
    elapsedMs,
    flow: finalState?.flowLog || [],
    selfExtension: {
      discoveredApis: (finalState?.discoveredApis || []).length,
      dynamicToolsCreated: Object.keys(finalState?.toolRegistry || {}).length,
      toolNames: Object.keys(finalState?.toolRegistry || {}),
      extensionLog: finalState?.extensionLog || [],
    },
    selfLearning: {
      enabled: learningConfig.enabled,
      host: learningPersistence.host,
      boostedCandidates: Number(finalState?.learningContext?.boostedCandidates || 0),
      learnedEndpointsUpdated: Number(learningPersistence.updatedEndpoints || 0),
    },
    steps: {
      discovery: finalState?.discoveryResult || null,
      slots: finalState?.slotsResult || null,
      notification: finalState?.notificationResult || null,
      humanGate: finalState?.humanGateResult || null,
      booking: finalState?.bookingResult || null,
      otp: finalState?.otpResult || null,
    },
    bookingState: normalizeBookingState({
      priorState: finalState?.bookingState || null,
      availableSlots: finalState?.availableSlots || [],
      selectedSlot: finalState?.selectedSlot || null,
      bookingStatus,
      currentStep: finalState?.currentStep || null,
      completed,
      lastChecked: finalState?.lastChecked || null,
      userConfirmation: Boolean(finalState?.userConfirmation),
      autoBook: Boolean(finalState?.autoBook),
      decision: finalState?.decision || null,
      nextCheckAt: finalState?.nextCheckAt || null,
      notification: finalState?.notificationResult || null,
      confirmationGranted: extractConfirmationGranted(finalState?.applicantPayload),
      requiresHumanGate: Boolean(finalState?.humanGateResult?.pending),
    }),
    selectorHealing: finalState?.selectorHealingLog || [],
    outcome: {
      completed,
      bookingOk,
      otpOk,
      needsHumanOtp,
      bookingStatus,
      finalStep: finalState?.currentStep || 'unknown',
      error: finalState?.finalError || null,
    },
    metrics: {
      totalElapsedMs: elapsedMs,
      slotIdentificationMs,
      retries: retryEvents,
      effectiveRetryBudget: computeAdaptiveRetryBudget(finalState || initialState),
      maxObservedToolLatencyMs: Number(finalState?.maxObservedToolLatencyMs || 0),
      dynamicToolsCreated: Object.keys(finalState?.toolRegistry || {}).length,
      discoveredApis: (finalState?.discoveredApis || []).length,
      circuitBreakerOpenedCount: Number(resilienceMetrics.circuitBreakerOpenedCount || 0),
      circuitBreakerSkippedCount: Number(resilienceMetrics.circuitBreakerSkippedCount || 0),
      transientRecoveryCount: Number(resilienceMetrics.transientRecoveryCount || 0),
      learningBoostedCandidates: Number(resilienceMetrics.learningBoostedCandidates || 0),
      learnedEndpointsUpdated: Number(resilienceMetrics.learnedEndpointsUpdated || 0),
    },
    graphTopology: {
      nodes: ['discover_api', 'check_availability', 'decide', 'notify_user', 'human_gate', 'book_slot', 'otp_validate', 'wait_before_retry', 'done', 'error'],
      edges: [
        'START → discover_api',
        'discover_api → [check_availability | error]',
        'check_availability → [decide | error]',
        'decide → [notify_user | human_gate | book_slot | wait_before_retry | done | error]',
        'notify_user → [human_gate | error]',
        'human_gate → [book_slot | done | error]',
        'book_slot → [otp_validate | wait_before_retry | done | error]',
        'otp_validate → [wait_before_retry | done]',
        'wait_before_retry → [check_availability | done | error]',
        'done → END',
        'error → END',
      ],
      architecture: 'self-extending: tools are created dynamically from discovered endpoints at runtime, with explicit decision, notification, HITL, and wait/recheck stages',
    },
  };

  await saveRunResult(runId, { ...result, websiteUrl, requestText });
  return result;
}
