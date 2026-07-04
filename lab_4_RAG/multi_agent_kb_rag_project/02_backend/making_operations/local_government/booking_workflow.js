const DEFAULT_SLOT_TIMEZONE = String(process.env.BOOKING_SLOT_TIMEZONE || 'Asia/Jerusalem').trim() || 'Asia/Jerusalem';

const BOOKING_STATUS = {
  INITIALIZED: 'initialized',
  WAITING_FOR_SLOTS: 'waiting_for_slots',
  SLOTS_FOUND: 'slots_found',
  AWAITING_USER_CONFIRMATION: 'awaiting_user_confirmation',
  AUTO_BOOK_READY: 'auto_book_ready',
  BOOKING_READY: 'booking_ready',
  BOOKING_IN_PROGRESS: 'booking_in_progress',
  AWAITING_OTP: 'awaiting_otp',
  BOOKED: 'booked',
  SUBMITTED: 'submitted',
  SLOT_CHECK_FAILED: 'slot_check_failed',
  BOOKING_FAILED: 'booking_failed',
  ERROR: 'error',
};

const DECISION = {
  WAIT_AND_RECHECK: 'wait_and_recheck',
  NOTIFY_AND_WAIT_FOR_CONFIRMATION: 'notify_and_wait_for_confirmation',
  AUTO_BOOK: 'auto_book',
  BOOK_CONFIRMED_SLOT: 'book_confirmed_slot',
  ESCALATE_TO_HUMAN: 'escalate_to_human',
};

const TERMINAL_BOOKING_STATES = new Set([
  BOOKING_STATUS.BOOKED,
  BOOKING_STATUS.SUBMITTED,
  BOOKING_STATUS.BOOKING_FAILED,
  BOOKING_STATUS.ERROR,
]);

const HUMAN_GATE_BOOKING_STATES = new Set([
  BOOKING_STATUS.AWAITING_USER_CONFIRMATION,
  BOOKING_STATUS.AWAITING_OTP,
]);

const WAITING_BOOKING_STATES = new Set([
  BOOKING_STATUS.INITIALIZED,
  BOOKING_STATUS.WAITING_FOR_SLOTS,
  BOOKING_STATUS.SLOT_CHECK_FAILED,
]);

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function firstNonEmptyText(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = normalizeText(value);
    if (text) return value;
  }
  return undefined;
}

function normalizeText(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeLowerText(value = '') {
  return normalizeText(value).toLowerCase();
}

function toIsoOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toEpochOrNull(value) {
  const iso = toIsoOrNull(value);
  return iso ? Date.parse(iso) : null;
}

function escapeRegExp(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenizeText(value = '') {
  return normalizeLowerText(value).split(/[\s,.;:/\\()[\]{}<>"'`!?+=_-]+/g).filter((token) => token.length >= 2);
}

function uniqueStrings(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((value) => normalizeText(value)).filter(Boolean)));
}

function safeInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatInTimeZone(dateLike, timeZone = DEFAULT_SLOT_TIMEZONE) {
  const iso = toIsoOrNull(dateLike);
  if (!iso) return null;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const parts = Object.fromEntries(formatter.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  } catch {
    return iso;
  }
}

function extractClockMinutes(text = '') {
  const normalized = normalizeText(text);
  const match = normalized.match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function normalizeTimeZone(timeZone = '') {
  const value = normalizeText(timeZone) || DEFAULT_SLOT_TIMEZONE;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return DEFAULT_SLOT_TIMEZONE;
  }
}

function buildSlotComparableStrings(slot = {}) {
  return uniqueStrings([
    slot?.label,
    slot?.value,
    slot?.datetime,
    slot?.datetime_utc,
    slot?.datetime_local,
    slot?.date,
    slot?.time,
    slot?.id,
  ]).map((value) => normalizeLowerText(value));
}

function textSimilarityScore(left = '', right = '') {
  const leftNormalized = normalizeLowerText(left);
  const rightNormalized = normalizeLowerText(right);
  if (!leftNormalized || !rightNormalized) return 0;
  if (leftNormalized === rightNormalized) return 1;
  if (leftNormalized.includes(rightNormalized) || rightNormalized.includes(leftNormalized)) return 0.88;
  const leftTokens = new Set(tokenizeText(leftNormalized));
  const rightTokens = new Set(tokenizeText(rightNormalized));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size || 1;
  return intersection / union;
}

function normalizeSlotPreferenceList(preferredSlot = '') {
  if (Array.isArray(preferredSlot)) return uniqueStrings(preferredSlot);
  const text = normalizeText(preferredSlot);
  if (!text) return [];
  return uniqueStrings(text.split(/[|,;]+/g).map((item) => item.trim()));
}

function resolveAutomationMode({ autoBook = false, confirmationGranted = false } = {}) {
  if (Boolean(autoBook)) return 'automatic';
  if (Boolean(confirmationGranted)) return 'confirmed';
  return 'manual_confirmation';
}

function validateCronField(field = '', index = 0) {
  const normalized = normalizeText(field);
  if (!normalized) return false;
  const ranges = [
    { min: 0, max: 59 },
    { min: 0, max: 23 },
    { min: 1, max: 31 },
    { min: 1, max: 12 },
    { min: 0, max: 7 },
    { min: 0, max: 59 },
  ];
  const range = ranges[index] || { min: 0, max: 9999 };
  const parts = normalized.split(',');
  return parts.every((part) => {
    const token = part.trim();
    if (!token) return false;
    if (token === '*' || token === '?') return true;
    if (/^\*\/\d+$/.test(token)) return true;
    if (/^\d+$/.test(token)) {
      const value = Number(token);
      return value >= range.min && value <= range.max;
    }
    if (/^\d+-\d+(\/\d+)?$/.test(token)) {
      const [base] = token.split('/');
      const [start, end] = base.split('-').map(Number);
      return start >= range.min && end <= range.max && start <= end;
    }
    return false;
  });
}

function validateCronExpression(cronExpression = '') {
  const normalized = normalizeText(cronExpression);
  if (!normalized) {
    return { valid: true, normalized: null, error: null, fields: 0 };
  }
  const fields = normalized.split(/\s+/g);
  if (![5, 6].includes(fields.length)) {
    return { valid: false, normalized, error: 'Cron expression must contain 5 or 6 fields', fields: fields.length };
  }
  const valid = fields.every((field, index) => validateCronField(field, index));
  return {
    valid,
    normalized,
    error: valid ? null : 'Cron expression contains unsupported or out-of-range fields',
    fields: fields.length,
  };
}

function extractSlotDateTime(slot = {}) {
  return firstDefined(
    slot?.datetime,
    slot?.dateTime,
    slot?.start,
    slot?.startsAt,
    slot?.slotDateTime,
    slot?.timestamp,
    slot?.date && slot?.time ? `${slot.date} ${slot.time}` : undefined,
    slot?.value && /\d{4}-\d{2}-\d{2}/.test(String(slot.value)) ? slot.value : undefined,
    null,
  );
}

export function validateBookingSlotEntry(slot = {}, { timeZone = DEFAULT_SLOT_TIMEZONE } = {}) {
  const issues = [];
  const normalizedTimeZone = normalizeTimeZone(timeZone || slot?.timezone);
  const label = normalizeText(slot?.label);
  const value = normalizeText(slot?.value);
  const rawDateTime = extractSlotDateTime(slot);
  const datetimeUtc = toIsoOrNull(rawDateTime);
  const clockMinutes = extractClockMinutes(slot?.time || slot?.label || slot?.datetime_local || slot?.datetime || '');

  if (!label) issues.push('missing-label');
  if (!value) issues.push('missing-value');
  if (rawDateTime && !datetimeUtc) issues.push('invalid-datetime');
  if (!rawDateTime && !clockMinutes && !/\d/.test(`${label} ${value}`)) issues.push('missing-time-signal');

  return {
    valid: issues.length === 0,
    issues,
    timeZone: normalizedTimeZone,
    datetimeUtc,
    datetimeLocal: datetimeUtc ? formatInTimeZone(datetimeUtc, normalizedTimeZone) : null,
    timestampMs: datetimeUtc ? Date.parse(datetimeUtc) : null,
    clockMinutes,
  };
}

export function normalizeBookingSlotEntry(slot, index = 0, { timeZone = DEFAULT_SLOT_TIMEZONE } = {}) {
  if (slot && typeof slot === 'object') {
    const rawSlot = slot.raw && typeof slot.raw === 'object' ? slot.raw : slot;
    const normalizedTimeZone = normalizeTimeZone(firstDefined(slot?.timezone, slot?.timeZone, timeZone));
    const rawDateTime = extractSlotDateTime(slot);
    const validation = validateBookingSlotEntry({
      ...slot,
      label: firstNonEmptyText(slot?.label, slot?.display, slot?.title, rawDateTime, slot?.time, slot?.date, `slot-${index + 1}`),
      value: firstDefined(slot?.value, slot?.id, slot?.slotId, rawDateTime, slot?.start, slot?.date, `slot-${index + 1}`),
    }, { timeZone: normalizedTimeZone });
    const label = normalizeText(String(firstNonEmptyText(
      slot?.label,
      slot?.display,
      slot?.title,
      rawDateTime,
      slot?.time,
      slot?.date,
      `slot-${index + 1}`,
    ) ?? `slot-${index + 1}`));
    const value = normalizeText(String(firstDefined(
      slot?.value,
      slot?.id,
      slot?.slotId,
      rawDateTime,
      slot?.start,
      label,
    ) ?? label));
    const datetimeUtc = validation.datetimeUtc;
    const datetimeLocal = validation.datetimeLocal;
    const localDate = datetimeLocal ? datetimeLocal.slice(0, 10) : normalizeText(String(firstDefined(slot?.date, '') ?? '')) || null;
    const localTime = datetimeLocal ? datetimeLocal.slice(11, 16) : normalizeText(String(firstDefined(slot?.time, '') ?? '')) || null;
    const slotId = normalizeText(String(firstDefined(slot?.id, slot?.slotId, value, `slot-${index + 1}`) ?? `slot-${index + 1}`));

    return {
      id: slotId,
      label,
      value,
      raw: rawSlot,
      timezone: normalizedTimeZone,
      datetime: rawDateTime ?? null,
      datetime_utc: datetimeUtc,
      datetime_local: datetimeLocal,
      timestamp_ms: validation.timestampMs,
      date: localDate,
      time: localTime,
      clock_minutes: validation.clockMinutes,
      valid: validation.valid,
      validation_issues: validation.issues,
      confidence: clamp(Number(firstDefined(slot?.confidence, slot?.score, 0)) || 0, 0, 1),
    };
  }

  const text = normalizeText(String(firstDefined(slot, `slot-${index + 1}`) ?? `slot-${index + 1}`));
  const normalized = {
    id: text || `slot-${index + 1}`,
    label: text,
    value: text,
    raw: slot,
    timezone: normalizeTimeZone(timeZone),
    datetime: null,
    datetime_utc: null,
    datetime_local: null,
    timestamp_ms: null,
    date: null,
    time: null,
    clock_minutes: extractClockMinutes(text),
    valid: Boolean(text),
    validation_issues: text ? [] : ['missing-label', 'missing-value'],
    confidence: 0,
  };
  return normalized;
}

export function normalizeSelectedBookingSlot(slot, options = {}) {
  if (!slot) return null;
  return normalizeBookingSlotEntry(slot, 0, options);
}

export function normalizeAvailableBookingSlots(slots = [], options = {}) {
  return (Array.isArray(slots) ? slots : [])
    .map((slot, index) => normalizeBookingSlotEntry(slot, index, options))
    .filter((slot, index, all) => {
      const duplicateIndex = all.findIndex((candidate) => candidate.value === slot.value && candidate.label === slot.label);
      return duplicateIndex === index;
    });
}

export function scoreBookingSlot(slot = {}, {
  preferredSlot = '',
  preferredDate = '',
  preferredTimeRanges = [],
  preferredTimeWindow = null,
  timeZone = DEFAULT_SLOT_TIMEZONE,
  now = new Date(),
} = {}) {
  const normalizedSlot = normalizeBookingSlotEntry(slot, 0, { timeZone });
  if (!normalizedSlot.valid) {
    return {
      score: -100,
      reasons: ['invalid-slot'],
      slot: normalizedSlot,
    };
  }

  const reasons = [];
  let score = 0;
  const preferredCandidates = normalizeSlotPreferenceList(preferredSlot);
  const comparableStrings = buildSlotComparableStrings(normalizedSlot);
  if (preferredCandidates.length > 0) {
    const bestPreferenceScore = Math.max(...preferredCandidates.map((candidate) => {
      return Math.max(...comparableStrings.map((text) => textSimilarityScore(text, candidate)));
    }));
    score += bestPreferenceScore * 60;
    if (bestPreferenceScore >= 0.999) reasons.push('exact-preferred-match');
    else if (bestPreferenceScore >= 0.8) reasons.push('close-preferred-match');
    else if (bestPreferenceScore >= 0.5) reasons.push('partial-preferred-match');
  }

  const preferredDateNormalized = normalizeText(preferredDate);
  if (preferredDateNormalized && normalizedSlot.date) {
    const dateScore = textSimilarityScore(normalizedSlot.date, preferredDateNormalized);
    score += dateScore * 20;
    if (dateScore >= 0.8) reasons.push('preferred-date-match');
  }

  const timeRanges = Array.isArray(preferredTimeRanges) ? preferredTimeRanges : (preferredTimeWindow ? [preferredTimeWindow] : []);
  const slotMinutes = normalizedSlot.clock_minutes;
  if (slotMinutes != null && timeRanges.length > 0) {
    let bestWindowScore = 0;
    for (const range of timeRanges) {
      const startMinutes = extractClockMinutes(range?.start || range?.from || '');
      const endMinutes = extractClockMinutes(range?.end || range?.to || '');
      if (startMinutes == null || endMinutes == null) continue;
      if (slotMinutes >= Math.min(startMinutes, endMinutes) && slotMinutes <= Math.max(startMinutes, endMinutes)) {
        bestWindowScore = Math.max(bestWindowScore, 1);
      } else {
        const distance = Math.min(Math.abs(slotMinutes - startMinutes), Math.abs(slotMinutes - endMinutes));
        bestWindowScore = Math.max(bestWindowScore, Math.max(0, 1 - (distance / 240)));
      }
    }
    score += bestWindowScore * 22;
    if (bestWindowScore >= 1) reasons.push('preferred-time-window');
    else if (bestWindowScore >= 0.6) reasons.push('close-time-window');
  }

  if (normalizedSlot.timestamp_ms) {
    const deltaHours = Math.abs(normalizedSlot.timestamp_ms - new Date(now).getTime()) / (1000 * 60 * 60);
    const recencyScore = clamp(1 - (deltaHours / (24 * 14)), 0, 1);
    score += recencyScore * 10;
    if (recencyScore >= 0.6) reasons.push('near-term-slot');
  }

  score += clamp(Number(normalizedSlot.confidence || 0), 0, 1) * 8;
  score += normalizedSlot.datetime_utc ? 4 : 0;
  score += comparableStrings.some((text) => /morning|בוקר|09:|10:|11:/.test(text)) ? 1 : 0;

  return {
    score: Number(score.toFixed(4)),
    reasons,
    slot: normalizedSlot,
  };
}

export function selectPreferredBookingSlot({
  selectedSlot = null,
  availableSlots = [],
  preferredSlot = '',
  preferredDate = '',
  preferredTimeRanges = [],
  preferredTimeWindow = null,
  timeZone = DEFAULT_SLOT_TIMEZONE,
  now = new Date(),
} = {}) {
  const normalizedAvailable = normalizeAvailableBookingSlots(availableSlots, { timeZone });
  const explicit = normalizeSelectedBookingSlot(selectedSlot, { timeZone });
  if (explicit?.valid) return explicit;

  if (!normalizedAvailable.length) return null;

  const ranked = normalizedAvailable
    .map((slot) => scoreBookingSlot(slot, { preferredSlot, preferredDate, preferredTimeRanges, preferredTimeWindow, timeZone, now }))
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.slot || normalizedAvailable[0] || null;
}

export function extractBookingStateFromNotes(notes = null) {
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return null;
  if (notes.bookingState && typeof notes.bookingState === 'object') return notes.bookingState;
  if (notes.booking_state && typeof notes.booking_state === 'object') return notes.booking_state;
  if (
    Object.prototype.hasOwnProperty.call(notes, 'available_slots')
    || Object.prototype.hasOwnProperty.call(notes, 'selected_slot')
    || Object.prototype.hasOwnProperty.call(notes, 'booking_status')
  ) {
    return notes;
  }
  return null;
}

function deriveRetryStrategy({
  slotCheckFailed = false,
  retryCount = 0,
  transientFailureCount = 0,
  pollIntervalMs = 60000,
  now = new Date(),
} = {}) {
  const retries = Math.max(safeInt(retryCount, 0), safeInt(transientFailureCount, 0));
  const delayMs = clamp(Math.round(Math.max(1000, Number(pollIntervalMs) || 60000) * Math.min(5, 1 + (retries * 0.5))), 1000, 30 * 60 * 1000);
  return {
    enabled: Boolean(slotCheckFailed),
    retry_count: retries,
    next_retry_at: slotCheckFailed ? new Date(new Date(now).getTime() + delayMs).toISOString() : null,
    delay_ms: slotCheckFailed ? delayMs : 0,
    backoff: slotCheckFailed ? 'linear-plus' : 'none',
  };
}

export function deriveBookingDecision({
  availableSlots = [],
  selectedSlot = null,
  preferredSlot = '',
  preferredDate = '',
  preferredTimeRanges = [],
  preferredTimeWindow = null,
  autoBook = false,
  confirmationGranted = false,
  slotCheckFailed = false,
  retryCount = 0,
  transientFailureCount = 0,
  pollIntervalMs = 60000,
  timeZone = DEFAULT_SLOT_TIMEZONE,
  now = new Date(),
} = {}) {
  const normalizedSlots = normalizeAvailableBookingSlots(availableSlots, { timeZone });
  const rankedSlots = normalizedSlots
    .map((slot) => scoreBookingSlot(slot, { preferredSlot, preferredDate, preferredTimeRanges, preferredTimeWindow, timeZone, now }))
    .sort((left, right) => right.score - left.score);
  const normalizedSelected = normalizeSelectedBookingSlot(selectedSlot, { timeZone })
    || rankedSlots[0]?.slot
    || null;
  const validSlots = rankedSlots.filter((entry) => entry.slot?.valid);
  const hasSlots = validSlots.length > 0;
  const automationMode = resolveAutomationMode({ autoBook, confirmationGranted });
  const retryStrategy = deriveRetryStrategy({ slotCheckFailed, retryCount, transientFailureCount, pollIntervalMs, now });

  if (slotCheckFailed) {
    return {
      decision: DECISION.WAIT_AND_RECHECK,
      bookingStatus: BOOKING_STATUS.SLOT_CHECK_FAILED,
      selectedSlot: normalizedSelected,
      scoredSlots: rankedSlots,
      shouldNotifyUser: false,
      requiresHumanGate: false,
      shouldBook: false,
      shouldWait: true,
      automationMode,
      gateStatus: 'not_required',
      retryStrategy,
    };
  }

  if (!hasSlots) {
    return {
      decision: DECISION.WAIT_AND_RECHECK,
      bookingStatus: BOOKING_STATUS.WAITING_FOR_SLOTS,
      selectedSlot: null,
      scoredSlots: rankedSlots,
      shouldNotifyUser: false,
      requiresHumanGate: false,
      shouldBook: false,
      shouldWait: true,
      automationMode,
      gateStatus: 'not_required',
      retryStrategy: { ...retryStrategy, enabled: false, next_retry_at: retryStrategy.next_retry_at || new Date(new Date(now).getTime() + Math.max(1000, Number(pollIntervalMs) || 60000)).toISOString() },
    };
  }

  if (automationMode === 'automatic') {
    return {
      decision: DECISION.AUTO_BOOK,
      bookingStatus: BOOKING_STATUS.AUTO_BOOK_READY,
      selectedSlot: normalizedSelected,
      scoredSlots: rankedSlots,
      shouldNotifyUser: false,
      requiresHumanGate: false,
      shouldBook: true,
      shouldWait: false,
      automationMode,
      gateStatus: 'not_required',
      retryStrategy: { ...retryStrategy, enabled: false, next_retry_at: null, delay_ms: 0, backoff: 'none' },
    };
  }

  if (automationMode === 'confirmed') {
    return {
      decision: DECISION.BOOK_CONFIRMED_SLOT,
      bookingStatus: BOOKING_STATUS.BOOKING_READY,
      selectedSlot: normalizedSelected,
      scoredSlots: rankedSlots,
      shouldNotifyUser: false,
      requiresHumanGate: false,
      shouldBook: true,
      shouldWait: false,
      automationMode,
      gateStatus: 'granted',
      retryStrategy: { ...retryStrategy, enabled: false, next_retry_at: null, delay_ms: 0, backoff: 'none' },
    };
  }

  return {
    decision: DECISION.NOTIFY_AND_WAIT_FOR_CONFIRMATION,
    bookingStatus: BOOKING_STATUS.AWAITING_USER_CONFIRMATION,
    selectedSlot: normalizedSelected,
    scoredSlots: rankedSlots,
    shouldNotifyUser: true,
    requiresHumanGate: true,
    shouldBook: false,
    shouldWait: false,
    automationMode,
    gateStatus: 'awaiting_confirmation',
    retryStrategy: { ...retryStrategy, enabled: false, next_retry_at: null, delay_ms: 0, backoff: 'none' },
  };
}

function deriveUnifiedWorkflowState({ bookingStatus = '', decision = '', completed = false } = {}) {
  const normalizedStatus = normalizeLowerText(bookingStatus);
  const normalizedDecision = normalizeLowerText(decision);
  if (TERMINAL_BOOKING_STATES.has(normalizedStatus) || completed) {
    if ([BOOKING_STATUS.BOOKED, BOOKING_STATUS.SUBMITTED].includes(normalizedStatus)) return 'completed';
    return 'failed';
  }
  if (HUMAN_GATE_BOOKING_STATES.has(normalizedStatus) || normalizedDecision === DECISION.NOTIFY_AND_WAIT_FOR_CONFIRMATION) return 'human_gate';
  if (WAITING_BOOKING_STATES.has(normalizedStatus) || normalizedDecision === DECISION.WAIT_AND_RECHECK) return 'waiting';
  if ([BOOKING_STATUS.AUTO_BOOK_READY, BOOKING_STATUS.BOOKING_READY, BOOKING_STATUS.BOOKING_IN_PROGRESS].includes(normalizedStatus)) return 'booking';
  return 'active';
}

function deriveCurrentStep({ bookingStatus = '', currentStep = '', decision = '', shouldWait = false, requiresHumanGate = false, shouldBook = false } = {}) {
  const normalizedStep = normalizeText(currentStep);
  if (normalizedStep) return normalizedStep;
  if (requiresHumanGate || bookingStatus === BOOKING_STATUS.AWAITING_USER_CONFIRMATION) return 'human_gate';
  if (shouldBook || [BOOKING_STATUS.AUTO_BOOK_READY, BOOKING_STATUS.BOOKING_READY].includes(bookingStatus)) return 'book_slot';
  if (shouldWait || [BOOKING_STATUS.WAITING_FOR_SLOTS, BOOKING_STATUS.SLOT_CHECK_FAILED].includes(bookingStatus) || decision === DECISION.WAIT_AND_RECHECK) return 'wait_before_retry';
  if ([BOOKING_STATUS.BOOKED, BOOKING_STATUS.SUBMITTED].includes(bookingStatus)) return 'done';
  return 'decide';
}

export function mapBookingStateToJobStatus({ bookingStatus = '', currentStep = '', completed = false } = {}) {
  const normalizedStatus = normalizeLowerText(bookingStatus);
  const normalizedStep = normalizeLowerText(currentStep);

  if (['booked', 'submitted'].includes(normalizedStatus) || (completed && normalizedStep === 'done')) return 'Done';
  if ([BOOKING_STATUS.AUTO_BOOK_READY, BOOKING_STATUS.BOOKING_READY, BOOKING_STATUS.AWAITING_USER_CONFIRMATION, BOOKING_STATUS.SLOTS_FOUND].includes(normalizedStatus)) return 'Found';
  if ([BOOKING_STATUS.ERROR, BOOKING_STATUS.BOOKING_FAILED, BOOKING_STATUS.SLOT_CHECK_FAILED].includes(normalizedStatus)) return 'Failed';
  if ([BOOKING_STATUS.AWAITING_OTP].includes(normalizedStatus) || normalizedStep === 'human_gate') return 'ActionRequired';
  if (normalizedStep === 'wait_before_retry' || [BOOKING_STATUS.WAITING_FOR_SLOTS, BOOKING_STATUS.INITIALIZED].includes(normalizedStatus)) return 'Waiting';
  return 'InProgress';
}

export function mapBookingStatusToRequestStatus(bookingStatus = '') {
  const normalized = normalizeLowerText(bookingStatus);
  if ([BOOKING_STATUS.BOOKED, BOOKING_STATUS.SUBMITTED].includes(normalized)) return 'approved';
  if ([BOOKING_STATUS.ERROR, BOOKING_STATUS.BOOKING_FAILED].includes(normalized)) return 'rejected';
  if ([BOOKING_STATUS.AWAITING_USER_CONFIRMATION, BOOKING_STATUS.AWAITING_OTP].includes(normalized)) return 'pending_user';
  return 'in_progress';
}

export function normalizeBookingState({
  priorState = null,
  availableSlots = [],
  selectedSlot = null,
  bookingStatus = '',
  currentStep = null,
  completed = false,
  lastChecked = null,
  userConfirmation = false,
  autoBook = false,
  decision = null,
  nextCheckAt = null,
  notification = null,
  queue = null,
  scheduler = null,
  session = null,
  confirmationGranted = false,
  requiresHumanGate = false,
  preferredSlot = '',
  preferredDate = '',
  preferredTimeRanges = [],
  preferredTimeWindow = null,
  retry = null,
  slotCheckFailed = false,
  timeZone = DEFAULT_SLOT_TIMEZONE,
} = {}) {
  const prior = priorState && typeof priorState === 'object' ? priorState : {};
  const normalizedTimeZone = normalizeTimeZone(timeZone || prior.timezone || prior.slot_timezone);
  const normalizedSlots = normalizeAvailableBookingSlots(
    availableSlots.length ? availableSlots : (prior.available_slots || []),
    { timeZone: normalizedTimeZone }
  );
  const decisionSnapshot = deriveBookingDecision({
    availableSlots: normalizedSlots,
    selectedSlot: selectedSlot || prior.selected_slot || null,
    preferredSlot,
    preferredDate,
    preferredTimeRanges,
    preferredTimeWindow,
    autoBook: firstDefined(autoBook, prior.auto_book, false),
    confirmationGranted: firstDefined(confirmationGranted, prior.confirmation_granted, false),
    slotCheckFailed,
    retryCount: retry?.retry_count || prior.retry?.retry_count || 0,
    transientFailureCount: retry?.transient_failure_count || prior.retry?.transient_failure_count || 0,
    pollIntervalMs: scheduler?.interval_ms || prior.scheduler?.interval_ms || 60000,
    timeZone: normalizedTimeZone,
  });

  const resolvedBookingStatus = normalizeText(bookingStatus || prior.booking_status || decisionSnapshot.bookingStatus || BOOKING_STATUS.INITIALIZED);
  const resolvedDecision = normalizeText(decision || prior.decision || decisionSnapshot.decision || DECISION.WAIT_AND_RECHECK) || null;
  const resolvedSelected = normalizeSelectedBookingSlot(selectedSlot, { timeZone: normalizedTimeZone })
    || normalizeSelectedBookingSlot(prior.selected_slot, { timeZone: normalizedTimeZone })
    || decisionSnapshot.selectedSlot
    || null;
  const resolvedRequiresHumanGate = Boolean(requiresHumanGate || decisionSnapshot.requiresHumanGate || prior.requires_human_gate);
  const resolvedCurrentStep = deriveCurrentStep({
    bookingStatus: resolvedBookingStatus,
    currentStep,
    decision: resolvedDecision,
    shouldWait: Boolean(decisionSnapshot.shouldWait),
    requiresHumanGate: resolvedRequiresHumanGate,
    shouldBook: Boolean(decisionSnapshot.shouldBook),
  });
  const workflowState = deriveUnifiedWorkflowState({
    bookingStatus: resolvedBookingStatus,
    decision: resolvedDecision,
    completed,
  });
  const normalizedRetry = retry || prior.retry || decisionSnapshot.retryStrategy || null;
  const resolvedScheduler = scheduler || prior.scheduler || null;
  const resolvedQueue = queue || prior.queue || null;

  return {
    available_slots: normalizedSlots,
    selected_slot: resolvedSelected,
    booking_status: resolvedBookingStatus,
    job_status: mapBookingStateToJobStatus({
      bookingStatus: resolvedBookingStatus,
      currentStep: resolvedCurrentStep,
      completed,
    }),
    job_step: resolvedCurrentStep,
    request_status: mapBookingStatusToRequestStatus(resolvedBookingStatus),
    unified_state: workflowState,
    state_hierarchy: {
      booking: resolvedBookingStatus,
      job: mapBookingStateToJobStatus({ bookingStatus: resolvedBookingStatus, currentStep: resolvedCurrentStep, completed }),
      request: mapBookingStatusToRequestStatus(resolvedBookingStatus),
      workflow: workflowState,
    },
    last_checked: toIsoOrNull(lastChecked) || toIsoOrNull(prior.last_checked),
    user_confirmation: Boolean(firstDefined(userConfirmation, prior.user_confirmation, false)),
    auto_book: Boolean(firstDefined(autoBook, prior.auto_book, false)),
    confirmation_granted: Boolean(firstDefined(confirmationGranted, prior.confirmation_granted, false)),
    automation_mode: resolveAutomationMode({ autoBook: firstDefined(autoBook, prior.auto_book, false), confirmationGranted: firstDefined(confirmationGranted, prior.confirmation_granted, false) }),
    gate_status: resolvedRequiresHumanGate ? 'required' : (Boolean(firstDefined(confirmationGranted, prior.confirmation_granted, false)) ? 'granted' : 'not_required'),
    requires_human_gate: resolvedRequiresHumanGate,
    decision: resolvedDecision,
    next_check_at: toIsoOrNull(nextCheckAt) || toIsoOrNull(prior.next_check_at) || normalizedRetry?.next_retry_at || null,
    notification: notification || prior.notification || null,
    queue: resolvedQueue,
    scheduler: resolvedScheduler,
    session: session || prior.session || null,
    retry: normalizedRetry,
    slot_scores: decisionSnapshot.scoredSlots || prior.slot_scores || [],
    preferred_slot: normalizeText(preferredSlot || prior.preferred_slot || '') || null,
    preferred_date: normalizeText(preferredDate || prior.preferred_date || '') || null,
    preferred_time_ranges: Array.isArray(preferredTimeRanges) && preferredTimeRanges.length ? preferredTimeRanges : (prior.preferred_time_ranges || []),
    timezone: normalizedTimeZone,
    slot_timezone: normalizedTimeZone,
  };
}

export function buildWorkflowScheduler({ intervalMs = 0, cronExpression = '', mode = '', timeZone = DEFAULT_SLOT_TIMEZONE } = {}) {
  const cronValidation = validateCronExpression(cronExpression);
  const normalizedTimeZone = normalizeTimeZone(timeZone);
  const interval = Math.max(0, Number(intervalMs) || 0);
  const schedulerMode = cronValidation.normalized ? 'cron-intent' : (normalizeText(mode) || 'interval');
  return {
    mode: schedulerMode,
    interval_ms: interval,
    cron_expression: cronValidation.normalized || null,
    cron_valid: cronValidation.valid,
    cron_error: cronValidation.error,
    timezone: normalizedTimeZone,
    next_trigger_source: cronValidation.normalized ? 'cron' : 'interval',
  };
}

export function buildWorkflowQueue({ name = 'appointment-monitor', inFlight = false, priority = 'normal' } = {}) {
  return {
    name: normalizeText(name || 'appointment-monitor') || 'appointment-monitor',
    in_flight: Boolean(inFlight),
    priority: normalizeText(priority || 'normal') || 'normal',
  };
}
