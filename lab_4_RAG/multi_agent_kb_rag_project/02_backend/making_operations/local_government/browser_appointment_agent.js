import fs from 'fs/promises';
import path from 'path';
import { randomUUID, createHmac, createHash } from 'crypto';
import { chromium } from 'playwright';
import { updateGovernmentRequestStatus } from '../../agents/dbTools.js';
import { cleanRelevantHtmlToMarkdown } from './html_relevance_cleaner.js';
import {
  buildAttendedActionRecord,
  buildAttendedReplaySummary,
  buildDomVersion,
  buildSemanticEmbedding,
  cosineSimilarity,
  listLearnedActionsForHost,
  mergeAttendedSessionLearning,
  markReplayResult,
  readAttendedDomLearningStore,
  resolveApplicantBindingValue,
  safeHostFromUrl,
  scoreFieldForRecordedInput,
  scoreReplayRecordForPage,
  writeAttendedDomLearningStore,
} from './attended_dom_learning.js';
import {
  summarizePaymentProvider,
  analyzePaymentProviderBoundary,
  savePaymentBoundaryEvidence,
  buildPaymentBoundaryUiSummary,
} from './payment_provider_adapters.js';

const DEFAULT_BOOKING_URL = process.env.TEL_AVIV_APPOINTMENT_PUBLIC_URL || 'https://www.tel-aviv.gov.il/Contact/Pages/Appointments.aspx';
const ATTENDED_SESSION_ROOT = path.resolve(process.cwd(), 'tmp', 'browser-booking-attended');
const ATTENDED_SESSION_TTL_MS = Math.max(10 * 60 * 1000, Number(process.env.BOOKING_ATTENDED_SESSION_TTL_MS || 2 * 60 * 60 * 1000));
const SHARED_AUTONOMOUS_PROFILE_DIR = path.resolve(ATTENDED_SESSION_ROOT, 'profile-autonomous-shared');
// Saved once by the human; loaded automatically on every automated run.
// NOTE: stored in plaintext - keep this file local only, never commit it.
const BOOKING_CREDENTIALS_FILE = path.resolve(process.cwd(), 'tmp', 'booking-creds.json');
const SELECTOR_HEALING_LEARNING_FILE = path.resolve(process.cwd(), 'tmp', 'selector-healing-learning.json');
const PAYMENT_BOUNDARY_CAPTURE_LIMIT = 40;
const STEALTH_IDENTITIES = [
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    acceptLanguage: 'en-US,en;q=0.9',
    timezoneId: 'Asia/Jerusalem',
  },
  {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-GB',
    acceptLanguage: 'en-GB,en;q=0.9',
    timezoneId: 'Asia/Jerusalem',
  },
  {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    locale: 'he-IL',
    acceptLanguage: 'he-IL,he;q=0.9,en-US;q=0.7,en;q=0.6',
    timezoneId: 'Asia/Jerusalem',
  },
];

const CHECKPOINT_STATES = {
  AWAITING_LOGIN: 'awaiting_login',
  AWAITING_OTP: 'awaiting_otp',
  AWAITING_CAPTCHA: 'awaiting_captcha',
  AWAITING_HUMAN: 'awaiting_human',
  READY_TO_SUBMIT: 'ready_to_submit',
  SUBMITTED: 'submitted',
  STOPPED: 'stopped',
};

const BOOKING_FLOW_PHASES = {
  UNKNOWN: 'unknown',
  IDENTIFICATION: 'identification',
  APPOINTMENT_DIARY: 'appointment_diary',
  APPROVAL: 'approval',
};

const BOOKING_INTERACTION_STAGES = {
  LOGIN: 'login',
  OTP: 'otp',
  FORM: 'form',
  REVIEW: 'review',
  SUBMIT: 'submit',
};

const attendedSessions = new Map();
const ATTENDED_ACTION_CAPTURE_LIMIT = 180;
const ATTENDED_DOM_FAILURE_LIMIT = 60;
const DEBUG_TIMELINE_LIMIT = 160;
const DEBUG_SNAPSHOT_LIMIT = 80;
const DEBUG_VISUAL_LAYER_LIMIT = 40;
const SELECTOR_HEALING_LLM_CACHE = new Map();
const SELECTOR_HEALING_LLM_CACHE_TTL_MS = Math.max(30000, Number(process.env.SELECTOR_HEALING_LLM_CACHE_TTL_MS || 120000));

function mapCheckpointToGovernmentRequestStatus(checkpointState = '') {
  const state = String(checkpointState || '').toLowerCase();
  if (state === CHECKPOINT_STATES.SUBMITTED) return 'approved';
  return 'in_progress';
}

async function persistAttendedRequestState(session, notes = null) {
  const requestId = Number(session?.requestId);
  if (!Number.isInteger(requestId) || requestId <= 0) return null;
  try {
    return await updateGovernmentRequestStatus({
      id: requestId,
      status: mapCheckpointToGovernmentRequestStatus(session?.state),
      notes,
    });
  } catch {
    return null;
  }
}

// ─── Persisted credentials ────────────────────────────────────────────────────

export async function saveBookingCredentials({
  loginUsername = '',
  loginPassword = '',
  otpCode = '',
  otpPolicy = 'static',
  totpSecret = '',
  applicantProfile = null,
} = {}) {
  await ensureDir(path.dirname(BOOKING_CREDENTIALS_FILE));
  const normalizedExtraFields = applicantProfile && typeof applicantProfile === 'object' && applicantProfile.extraFields && typeof applicantProfile.extraFields === 'object'
    ? Object.fromEntries(
      Object.entries(applicantProfile.extraFields)
        .map(([key, value]) => [String(key || '').trim(), String(value ?? '').trim()])
        .filter(([key, value]) => key && value)
    )
    : {};
  const normalizedApplicantProfile = applicantProfile && typeof applicantProfile === 'object'
    ? {
      firstName: String(applicantProfile.firstName || '').trim(),
      lastName: String(applicantProfile.lastName || '').trim(),
      fullName: String(applicantProfile.fullName || '').trim(),
      idNumber: String(applicantProfile.idNumber || '').trim(),
      phone: String(applicantProfile.phone || '').trim(),
      email: String(applicantProfile.email || '').trim(),
      address: String(applicantProfile.address || '').trim(),
      username: String(applicantProfile.username || '').trim(),
      city: String(applicantProfile.city || '').trim(),
      street: String(applicantProfile.street || '').trim(),
      houseNumber: String(applicantProfile.houseNumber || '').trim(),
      apartment: String(applicantProfile.apartment || '').trim(),
      zipCode: String(applicantProfile.zipCode || '').trim(),
      preferredDate: String(applicantProfile.preferredDate || '').trim(),
      preferredTime: String(applicantProfile.preferredTime || '').trim(),
      preferredTimes: String(applicantProfile.preferredTimes || '').trim(),
      preferredTimeWindow: String(applicantProfile.preferredTimeWindow || '').trim(),
      slotSelectionPolicy: String(applicantProfile.slotSelectionPolicy || '').trim().toLowerCase(),
      notes: String(applicantProfile.notes || '').trim(),
      extraFields: normalizedExtraFields,
    }
    : null;
  const data = {
    loginUsername: String(loginUsername || '').trim(),
    loginPassword: String(loginPassword || '').trim(),
    otpCode: String(otpCode || '').trim(),
    otpPolicy: String(otpPolicy || '').trim() || 'static',
    totpSecret: String(totpSecret || '').trim(),
    applicantProfile: normalizedApplicantProfile,
    savedAt: new Date().toISOString(),
  };
  await fs.writeFile(BOOKING_CREDENTIALS_FILE, JSON.stringify(data, null, 2), 'utf8');
  return { ok: true, savedAt: data.savedAt, hasUsername: !!data.loginUsername, hasPassword: !!data.loginPassword };
}

export async function loadBookingCredentials() {
  try {
    const raw = await fs.readFile(BOOKING_CREDENTIALS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      loginUsername: String(parsed.loginUsername || '').trim(),
      loginPassword: String(parsed.loginPassword || '').trim(),
      otpCode: String(parsed.otpCode || '').trim(),
      otpPolicy: String(parsed.otpPolicy || '').trim() || 'static',
      totpSecret: String(parsed.totpSecret || '').trim(),
      applicantProfile: parsed.applicantProfile && typeof parsed.applicantProfile === 'object'
        ? {
          firstName: String(parsed.applicantProfile.firstName || '').trim(),
          lastName: String(parsed.applicantProfile.lastName || '').trim(),
          fullName: String(parsed.applicantProfile.fullName || '').trim(),
          idNumber: String(parsed.applicantProfile.idNumber || '').trim(),
          phone: String(parsed.applicantProfile.phone || '').trim(),
          email: String(parsed.applicantProfile.email || '').trim(),
          address: String(parsed.applicantProfile.address || '').trim(),
          username: String(parsed.applicantProfile.username || '').trim(),
          city: String(parsed.applicantProfile.city || '').trim(),
          street: String(parsed.applicantProfile.street || '').trim(),
          houseNumber: String(parsed.applicantProfile.houseNumber || '').trim(),
          apartment: String(parsed.applicantProfile.apartment || '').trim(),
          zipCode: String(parsed.applicantProfile.zipCode || '').trim(),
          preferredDate: String(parsed.applicantProfile.preferredDate || '').trim(),
          preferredTime: String(parsed.applicantProfile.preferredTime || '').trim(),
          preferredTimes: String(parsed.applicantProfile.preferredTimes || '').trim(),
          preferredTimeWindow: String(parsed.applicantProfile.preferredTimeWindow || '').trim(),
          slotSelectionPolicy: String(parsed.applicantProfile.slotSelectionPolicy || '').trim().toLowerCase(),
          notes: String(parsed.applicantProfile.notes || '').trim(),
          extraFields: parsed.applicantProfile.extraFields && typeof parsed.applicantProfile.extraFields === 'object'
            ? Object.fromEntries(
              Object.entries(parsed.applicantProfile.extraFields)
                .map(([key, value]) => [String(key || '').trim(), String(value ?? '').trim()])
                .filter(([key, value]) => key && value)
            )
            : {},
        }
        : null,
      savedAt: parsed.savedAt || null,
    };
  } catch {
    return null;
  }
}

export async function clearBookingCredentials() {
  try {
    await fs.unlink(BOOKING_CREDENTIALS_FILE);
    return { ok: true, cleared: true };
  } catch {
    return { ok: true, cleared: false };
  }
}

export async function getBookingCredentialsMeta() {
  const creds = await loadBookingCredentials();
  if (!creds) return { saved: false };
  return {
    saved: true,
    hasUsername: !!creds.loginUsername,
    hasPassword: !!creds.loginPassword,
    hasOtp: !!creds.otpCode,
    hasApplicantProfile: Boolean(
      creds.applicantProfile?.firstName
      || creds.applicantProfile?.lastName
      || creds.applicantProfile?.fullName
      || creds.applicantProfile?.idNumber
      || creds.applicantProfile?.phone
      || creds.applicantProfile?.email
      || creds.applicantProfile?.address
      || creds.applicantProfile?.city
      || creds.applicantProfile?.street
      || creds.applicantProfile?.houseNumber
      || creds.applicantProfile?.apartment
      || creds.applicantProfile?.zipCode
    ),
    otpPolicy: creds.otpPolicy || 'static',
    hasTotpSecret: !!creds.totpSecret,
    savedAt: creds.savedAt,
  };
}

async function persistKnownBookingInputs(applicant = {}) {
  const incomingProfile = mergeApplicantProfile({}, applicant || {});
  const hasIncomingProfile = Boolean(incomingProfile.fullName || incomingProfile.idNumber || incomingProfile.phone || incomingProfile.email || incomingProfile.address || incomingProfile.notes);
  const incomingCreds = {
    loginUsername: String(applicant?.loginUsername || '').trim(),
    loginPassword: String(applicant?.loginPassword || applicant?.password || '').trim(),
    otpCode: String(applicant?.otpCode || '').trim(),
    otpPolicy: String(applicant?.otpPolicy || '').trim() || 'static',
    totpSecret: String(applicant?.totpSecret || '').trim(),
  };
  const hasIncomingCreds = Boolean(incomingCreds.loginUsername || incomingCreds.loginPassword || incomingCreds.otpCode || incomingCreds.totpSecret);
  if (!hasIncomingProfile && !hasIncomingCreds) return null;

  const existing = await loadBookingCredentials();
  const mergedProfile = mergeApplicantProfile(existing?.applicantProfile || {}, incomingProfile);
  const payload = {
    loginUsername: incomingCreds.loginUsername || existing?.loginUsername || '',
    loginPassword: incomingCreds.loginPassword || existing?.loginPassword || '',
    otpCode: incomingCreds.otpCode || existing?.otpCode || '',
    otpPolicy: incomingCreds.otpPolicy || existing?.otpPolicy || 'static',
    totpSecret: incomingCreds.totpSecret || existing?.totpSecret || '',
    applicantProfile: mergedProfile,
  };
  await saveBookingCredentials(payload);
  return payload;
}

function mergeApplicantProfile(base = {}, override = {}) {
  const left = base && typeof base === 'object' ? base : {};
  const right = override && typeof override === 'object' ? override : {};
  const leftExtra = left.extraFields && typeof left.extraFields === 'object' ? left.extraFields : {};
  const rightExtra = right.extraFields && typeof right.extraFields === 'object' ? right.extraFields : {};
  return {
    ...left,
    ...right,
    firstName: String(right.firstName || left.firstName || '').trim(),
    lastName: String(right.lastName || left.lastName || '').trim(),
    fullName: String(right.fullName || left.fullName || '').trim(),
    idNumber: String(right.idNumber || left.idNumber || '').trim(),
    phone: String(right.phone || left.phone || '').trim(),
    email: String(right.email || left.email || '').trim(),
    address: String(right.address || left.address || '').trim(),
    city: String(right.city || left.city || '').trim(),
    street: String(right.street || left.street || '').trim(),
    houseNumber: String(right.houseNumber || left.houseNumber || '').trim(),
    apartment: String(right.apartment || left.apartment || '').trim(),
    zipCode: String(right.zipCode || left.zipCode || '').trim(),
    notes: String(right.notes || left.notes || '').trim(),
    extraFields: Object.fromEntries(
      Object.entries({ ...leftExtra, ...rightExtra })
        .map(([key, value]) => [String(key || '').trim(), String(value ?? '').trim()])
        .filter(([key, value]) => key && value)
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildDynamicRelevanceTerms(intentText = '', applicant = {}) {
  const defaults = [
    'appointment', 'book', 'booking', 'service center',
    'municipality', 'city office', 'property tax', 'arnona',
    'קביעת תור', 'זימון תור', 'תור', 'ארנונה', 'שירות', 'עירייה',
  ];

  const raw = [intentText, applicant?.topic, applicant?.notes]
    .filter(Boolean)
    .map((x) => String(x));

  const tokens = raw
    .flatMap((text) => text.split(/[\s,.;:|/()\-]+/g))
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .slice(0, 80);

  return Array.from(new Set([...defaults, ...tokens.map((t) => t.toLowerCase())]));
}

async function scrapePageRelevanceSnapshot(page, { intentText = '', applicant = {} } = {}) {
  try {
    const html = await page.content();
    const relevanceTerms = buildDynamicRelevanceTerms(intentText, applicant);
    const cleaned = cleanRelevantHtmlToMarkdown(html, { relevanceTerms, minScore: 1 });
    const plain = String(cleaned?.plainText || '').toLowerCase();
    return {
      ok: true,
      relevanceTerms,
      keptItems: cleaned?.keptItems || 0,
      droppedItems: cleaned?.droppedItems || 0,
      textPreview: String(cleaned?.plainText || '').slice(0, 1200),
      hasAppointmentSignal: /appointment|book|booking|זימון|קביעת\s*תור|תור/.test(plain),
      hasArnonaSignal: /arnona|ארנונה|property\s*tax|municipal\s*tax/.test(plain),
    };
  } catch {
    return { ok: false, relevanceTerms: buildDynamicRelevanceTerms(intentText, applicant), keptItems: 0, droppedItems: 0, textPreview: '' };
  }
}

function cssEscapeIdentifier(value) {
  return String(value || '').replace(/([ #;?%&,.+*~\':"!^$\[\]()=>|\/\\@])/g, '\\$1');
}

function isTruthy(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  return ['true', '1', 'yes'].includes(String(v).toLowerCase());
}

function pickStealthIdentity(seed = '') {
  const normalized = String(seed || 'booking').trim();
  const sum = normalized.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return STEALTH_IDENTITIES[sum % STEALTH_IDENTITIES.length];
}

function buildStealthContextOptions(seed = '') {
  const identity = pickStealthIdentity(seed);
  return {
    identity,
    contextOptions: {
      viewport: { width: 1440, height: 900 },
      userAgent: identity.userAgent,
      locale: identity.locale,
      timezoneId: identity.timezoneId,
      extraHTTPHeaders: {
        'Accept-Language': identity.acceptLanguage,
        'DNT': '1',
        'Upgrade-Insecure-Requests': '1',
      },
    },
  };
}

async function applyStealthLite(page, identity = {}) {
  if (!page) return;
  await page.addInitScript(({ locale }) => {
    const patch = (obj, key, value) => {
      try {
        Object.defineProperty(obj, key, { get: () => value, configurable: true });
      } catch {
      }
    };
    patch(navigator, 'webdriver', undefined);
    patch(navigator, 'language', locale || 'en-US');
    patch(navigator, 'languages', [locale || 'en-US', 'en']);
    patch(navigator, 'platform', 'Win32');
    patch(navigator, 'hardwareConcurrency', 8);
  }, { locale: identity.locale || 'en-US' });
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function detectOtpOrCaptchaFromText(text) {
  const t = String(text || '').toLowerCase();
  return {
    captcha: /captcha|recaptcha|hcaptcha|turnstile|i am not a robot/.test(t),
    otp: /otp|one[- ]?time|verification code|2fa|two[- ]?factor|sms code|אימות דו[- ]?שלבי|קוד אימות/.test(t),
  };
}

function decodeBase32ToBuffer(base32 = '') {
  const normalized = String(base32 || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (!normalized) return Buffer.alloc(0);
  let bits = '';
  for (const ch of normalized) {
    const val = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch);
    if (val < 0) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotpCode(secret = '', stepSeconds = 30, digits = 6, epochMs = Date.now()) {
  const key = decodeBase32ToBuffer(secret);
  if (!key.length) return '';
  const counter = Math.floor(epochMs / 1000 / Math.max(15, Number(stepSeconds) || 30));
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const codeInt = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  const mod = 10 ** Math.max(6, Math.min(8, Number(digits) || 6));
  return String(codeInt % mod).padStart(Math.max(6, Math.min(8, Number(digits) || 6)), '0');
}

function detectLoginRequiredFromText(text) {
  const t = String(text || '').toLowerCase();
  return /sign in|log in|login|authenticate|mydigitel|התחבר|כניסה|הזדהות|אימות/.test(t);
}

function isTelAvivAppointmentsUrl(url = '') {
  return /tel-aviv\.gov\.il\/Contact\/Pages\/(?:Apointments|Appointments)\.aspx/i.test(String(url || ''));
}

function isTelAvivQueueReservationUrl(url = '') {
  return /www5\.tel-aviv\.gov\.il\/TlvForms\/TlvQueueReservation/i.test(String(url || ''));
}

function isTelAvivPaymentsUrl(url = '') {
  return /tel-aviv\.gov\.il\/About\/Pages\/Payments\.aspx/i.test(String(url || ''));
}

function shouldPreferBusinessApplicant(intentText = '', applicant = {}) {
  const blob = normalizeText([
    intentText,
    applicant?.notes,
    applicant?.topic,
    applicant?.businessName,
    applicant?.companyName,
  ].join(' ')).toLowerCase();
  return /business|company|commercial|עסק|עסקי|חברה|נכס שלא למגורים/.test(blob);
}

export function inferBookingFlowPhase(model = {}) {
  const forms = Array.isArray(model?.forms) ? model.forms : [];
  const fieldBlob = forms.map((form) => [
    form?.id,
    form?.name,
    form?.action,
    ...(Array.isArray(form?.fields) ? form.fields.map((field) => [field?.id, field?.name, field?.label, field?.placeholder, field?.type].join(' ')) : []),
    ...(Array.isArray(form?.submitButtons) ? form.submitButtons.map((button) => [button?.id, button?.name, button?.text, button?.type].join(' ')) : []),
  ].join(' ')).join(' ');
  const blob = normalizeText([
    model?.href,
    model?.title,
    model?.pageText,
    fieldBlob,
  ].join(' ')).toLowerCase();
  const queueLikeFlow = isTelAvivQueueReservationUrl(model?.href) || /tlvqueuereservation|queue reservation|queue/i.test(blob);
  const approvalSignals = [
    /approval|confirm|confirmation|summary|review appointment|submit appointment/i,
    /אישור|אשר|סיכום|בדיקת פרטים|פרטי התור|אישור הזמנה|אישור תור/i,
  ].some((pattern) => pattern.test(blob));
  const diarySignals = [
    /appointment diary|calendar|time slot|choose date|choose time|available appointments|select date|select time/i,
    /יומן|לוח שנה|זמינות|בחרו תאריך|בחרו שעה|בחרו את השעה|שעות פנויות|תאריך התור/i,
  ].some((pattern) => pattern.test(blob));
  const identificationSignals = [
    /identification|identify|identity|customer type|client type|full name|id number|phone|mobile|email/i,
    /זיהוי|הזדהות|סוג לקוח|לקוח פרטי|לקוח עסקי|שם מלא|תעודת זהות|טלפון|דוא"ל|אימייל/i,
  ].some((pattern) => pattern.test(blob));

  let phaseKey = BOOKING_FLOW_PHASES.UNKNOWN;
  let phaseLabel = 'Unknown';
  let stepNumber = null;
  let confidence = 0.35;
  const matchedSignals = [];

  if (approvalSignals) {
    phaseKey = BOOKING_FLOW_PHASES.APPROVAL;
    phaseLabel = 'Approval';
    stepNumber = 3;
    confidence = queueLikeFlow ? 0.96 : 0.84;
    matchedSignals.push('approval');
  } else if (diarySignals) {
    phaseKey = BOOKING_FLOW_PHASES.APPOINTMENT_DIARY;
    phaseLabel = 'Appointment Diary';
    stepNumber = 2;
    confidence = queueLikeFlow ? 0.93 : 0.8;
    matchedSignals.push('appointment-diary');
  } else if (identificationSignals) {
    phaseKey = BOOKING_FLOW_PHASES.IDENTIFICATION;
    phaseLabel = 'Identification';
    stepNumber = 1;
    confidence = queueLikeFlow ? 0.91 : 0.76;
    matchedSignals.push('identification');
  } else if (queueLikeFlow) {
    matchedSignals.push('queue-flow');
  }

  return {
    flowKey: queueLikeFlow ? 'municipal_queue_reservation' : (modelHasBookingSignals(model) ? 'generic_booking_flow' : 'unknown'),
    phaseKey,
    phaseLabel,
    stepNumber,
    totalSteps: queueLikeFlow ? 3 : null,
    isKnownFlow: queueLikeFlow,
    queueReservation: queueLikeFlow,
    approvalStep: phaseKey === BOOKING_FLOW_PHASES.APPROVAL,
    confidence,
    matchedSignals,
    currentUrl: model?.href || '',
  };
}

function inferCheckpointState({ text = '', submitted = false, flowPhase = null } = {}) {
  if (submitted) return CHECKPOINT_STATES.SUBMITTED;
  const checks = detectOtpOrCaptchaFromText(text);
  if (checks.captcha) return CHECKPOINT_STATES.AWAITING_CAPTCHA;
  if (checks.otp) return CHECKPOINT_STATES.AWAITING_OTP;
  if (detectLoginRequiredFromText(text)) return CHECKPOINT_STATES.AWAITING_LOGIN;
  if ([BOOKING_FLOW_PHASES.IDENTIFICATION, BOOKING_FLOW_PHASES.APPOINTMENT_DIARY].includes(String(flowPhase?.phaseKey || '').toLowerCase())) {
    return CHECKPOINT_STATES.AWAITING_HUMAN;
  }
  return CHECKPOINT_STATES.READY_TO_SUBMIT;
}

export function inferInteractionStage({ text = '', submitted = false, flowPhase = null } = {}) {
  if (submitted) return BOOKING_INTERACTION_STAGES.SUBMIT;
  const checks = detectOtpOrCaptchaFromText(text);
  if (checks.otp || checks.captcha) return BOOKING_INTERACTION_STAGES.OTP;
  if (detectLoginRequiredFromText(text)) return BOOKING_INTERACTION_STAGES.LOGIN;
  const phaseKey = String(flowPhase?.phaseKey || '').toLowerCase();
  if (phaseKey === BOOKING_FLOW_PHASES.APPROVAL || /review|summary|confirm|approval|checkout|payment|אישור|סיכום|סקירה|תשלום/.test(String(text || '').toLowerCase())) {
    return BOOKING_INTERACTION_STAGES.REVIEW;
  }
  return BOOKING_INTERACTION_STAGES.FORM;
}

function updateSessionCheckpointAndStage(session, model, { submitted = false, reason = '' } = {}) {
  if (!session) return { state: null, interactionStage: null };
  const flowPhase = session.flowPhase || inferBookingFlowPhase(model || {});
  const text = String(model?.pageText || session.pageText || '');
  const nextState = inferCheckpointState({ text, submitted, flowPhase });
  const nextStage = inferInteractionStage({ text, submitted: nextState === CHECKPOINT_STATES.SUBMITTED || submitted, flowPhase });
  const previousStage = String(session.interactionStage || '').toLowerCase();
  session.state = nextState;
  session.interactionStage = nextStage;
  session.pageText = text;
  if (nextStage && previousStage && previousStage !== nextStage) {
    session.notes.push(`Interaction stage transitioned: ${previousStage} -> ${nextStage}${reason ? ` (${reason})` : ''}.`);
  }
  return { state: nextState, interactionStage: nextStage };
}

function serializeNetworkEntry(entry = {}) {
  return {
    ts: entry.ts || new Date().toISOString(),
    method: entry.method || '',
    url: entry.url || '',
    resourceType: entry.resourceType || '',
    status: entry.status ?? null,
    ok: entry.ok ?? null,
    from: entry.from || '',
  };
}

function looksLikeApiUrl(url = '') {
  const value = String(url || '').toLowerCase();
  return /\/api\/|\.svc\/|_vti_bin|graphql|\/rest\/|\.json([?#]|$)/i.test(value);
}

function absoluteUrlMaybe(baseUrl = '', candidate = '') {
  const raw = String(candidate || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw, baseUrl || undefined).href;
  } catch {
    return raw;
  }
}

function extractApiPathCandidates(text = '', baseUrl = '') {
  const input = String(text || '');
  if (!input) return [];

  const matches = input.match(/(?:https?:\/\/[^\s"'`<>\\]+|(?:\/{1,2}|\.\/|\.\.\/)[A-Za-z0-9_\-./?=&%#]*?(?:api|graphql|rest|svc|appointment|booking|schedule|slot)[A-Za-z0-9_\-./?=&%#]*|[A-Za-z0-9_\-./]+\.(?:svc|json)(?:\/[A-Za-z0-9_\-./?=&%#]*)?)/gi) || [];
  return Array.from(new Set(matches
    .map((value) => absoluteUrlMaybe(baseUrl, value))
    .map((value) => String(value || '').trim())
    .filter((value) => value && looksLikeApiUrl(value))
    .slice(0, 150)));
}

function extractJsFilesFromHtmlRegex(html = '', baseUrl = '') {
  const source = String(html || '');
  if (!source) return [];

  const jsFiles = [...source.matchAll(/src="(.*?\.js(?:\?[^"<>]*)?)"/gi)]
    .map((match) => absoluteUrlMaybe(baseUrl, match?.[1] || ''));
  const jsFilesSingleQuote = [...source.matchAll(/src='(.*?\.js(?:\?[^'<>]*)?)'/gi)]
    .map((match) => absoluteUrlMaybe(baseUrl, match?.[1] || ''));

  return Array.from(new Set([...jsFiles, ...jsFilesSingleQuote].map((x) => String(x || '').trim()).filter(Boolean))).slice(0, 120);
}

function extractWorkerPathCandidates(text = '', baseUrl = '') {
  const source = String(text || '');
  if (!source) return [];

  const workerMatches = [
    ...source.matchAll(/new\s+Worker\s*\(\s*['"]([^'"]+?\.js(?:\?[^'"]*)?)['"]/gi),
    ...source.matchAll(/navigator\.serviceWorker\.register\s*\(\s*['"]([^'"]+?\.js(?:\?[^'"]*)?)['"]/gi),
    ...source.matchAll(/service-?worker[^"'\s>]*\.js(?:\?[^"'\s>]*)?/gi),
    ...source.matchAll(/webworkers?[^"'\s>]*\.js(?:\?[^"'\s>]*)?/gi),
  ];

  return Array.from(new Set(workerMatches
    .map((match) => absoluteUrlMaybe(baseUrl, match?.[1] || match?.[0] || ''))
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .slice(0, 80)));
}

function normalizeEndpointHarvestingOptions(options = {}) {
  const levelRaw = String(options?.level || 'balanced').toLowerCase();
  const level = ['quick', 'balanced', 'deep', 'turbo20'].includes(levelRaw) ? levelRaw : 'balanced';

  const defaultsByLevel = {
    quick: { jsScanTimeoutMs: 12000, maxJsFiles: 8, maxJsChars: 120000 },
    balanced: { jsScanTimeoutMs: 30000, maxJsFiles: 16, maxJsChars: 220000 },
    deep: { jsScanTimeoutMs: 45000, maxJsFiles: 28, maxJsChars: 320000 },
    turbo20: { jsScanTimeoutMs: 9000, maxJsFiles: 10, maxJsChars: 100000 },
  };

  const defaults = defaultsByLevel[level] || defaultsByLevel.balanced;
  const enabled = options?.enabled !== false;

  return {
    enabled,
    level,
    includeJsInspection: enabled && options?.includeJsInspection !== false,
    includeWorkerScan: enabled && options?.includeWorkerScan !== false,
    browserAutomationHarvesting: enabled && (options?.browserAutomationHarvesting !== false || level === 'turbo20'),
    apiDiscoveryDeadlineMs: Math.max(5000, Math.min(120000, Number(options?.apiDiscoveryDeadlineMs || (level === 'turbo20' ? 20000 : 60000)))),
    selfHealingSelectors: enabled && options?.selfHealingSelectors !== false,
    selfLearningSelectors: enabled && options?.selfLearningSelectors !== false,
    maxJsFiles: Math.max(2, Math.min(40, Number(options?.maxJsFiles || defaults.maxJsFiles))),
    jsScanTimeoutMs: Math.max(3000, Math.min(60000, Number(options?.jsScanTimeoutMs || defaults.jsScanTimeoutMs))),
    maxJsChars: Math.max(20000, Math.min(500000, Number(options?.maxJsChars || defaults.maxJsChars))),
    scanFocus: ['auto', 'discover', 'slots', 'schedule'].includes(String(options?.scanFocus || 'auto').toLowerCase()) ? String(options?.scanFocus || 'auto').toLowerCase() : 'auto',
    strategy: String(options?.strategy || 'high-level-efficient').trim() || 'high-level-efficient',
  };
}

async function readSelectorHealingLearningStore() {
  try {
    const raw = await fs.readFile(SELECTOR_HEALING_LEARNING_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      updatedAt: parsed?.updatedAt || null,
      hosts: parsed?.hosts && typeof parsed.hosts === 'object' ? parsed.hosts : {},
    };
  } catch {
    return { updatedAt: null, hosts: {} };
  }
}

async function writeSelectorHealingLearningStore(store = {}) {
  await fs.mkdir(path.dirname(SELECTOR_HEALING_LEARNING_FILE), { recursive: true });
  await fs.writeFile(SELECTOR_HEALING_LEARNING_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    hosts: store?.hosts && typeof store.hosts === 'object' ? store.hosts : {},
  }, null, 2), 'utf8');
}

function getDefaultHealingSelectors(intentText = '') {
  const intent = String(intentText || '').toLowerCase();
  const slotPriority = /slot|avail|calendar|time|זמינות|תור/.test(intent);
  const schedulePriority = /schedule|book|reserve|קבע|זימון/.test(intent);
  const candidates = [
    'a[href*="appoint"]',
    'a[href*="booking"]',
    'a[href*="service"]',
    'a[href*="slot"]',
    'button:has-text("Appointment")',
    'button:has-text("Book")',
    'button:has-text("Continue")',
    'button:has-text("זימון")',
    'button:has-text("קבע")',
    'button:has-text("תור")',
  ];
  if (slotPriority) candidates.unshift('a[href*="slot"]', 'button:has-text("Available")');
  if (schedulePriority) candidates.unshift('a[href*="schedule"]', 'button:has-text("Schedule")');
  return Array.from(new Set(candidates));
}

function getLearnedHealingSelectorsForHost(store = {}, host = '', max = 8) {
  const bySelector = store?.hosts?.[host]?.selectors || {};
  return Object.entries(bySelector)
    .sort((a, b) => Number((b?.[1]?.successCount || 0)) - Number((a?.[1]?.successCount || 0)))
    .slice(0, max)
    .map((entry) => String(entry?.[0] || '').trim())
    .filter(Boolean);
}

function noteHealingSelectorSuccess(store = {}, host = '', selector = '') {
  if (!host || !selector) return store;
  const hosts = { ...(store?.hosts || {}) };
  const hostEntry = { ...(hosts[host] || {}) };
  const selectors = { ...(hostEntry.selectors || {}) };
  const prev = selectors[selector] || { successCount: 0, lastSuccessAt: null };
  selectors[selector] = {
    successCount: Number(prev.successCount || 0) + 1,
    lastSuccessAt: new Date().toISOString(),
  };
  hostEntry.selectors = selectors;
  hosts[host] = hostEntry;
  return { ...(store || {}), hosts };
}

async function trySelfHealingSelectorPass(page, { selectors = [], timeoutPerSelectorMs = 1500 } = {}) {
  for (const selector of selectors || []) {
    try {
      const locator = page.locator(selector).first();
      const count = await locator.count();
      if (!count) continue;
      await locator.click({ timeout: Math.max(500, Number(timeoutPerSelectorMs) || 1500) });
      return { clicked: true, selector, mode: 'selector' };
    } catch {
    }
  }

  try {
    const textHit = await page.evaluate(() => {
      const re = /(appointment|book|schedule|continue|submit|זימון|קבע|תור)/i;
      const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"]'));
      for (const el of buttons.slice(0, 120)) {
        const text = String(el.innerText || el.textContent || el.getAttribute('aria-label') || el.value || '').trim();
        if (!re.test(text)) continue;
        try {
          el.click();
          return text.slice(0, 120);
        } catch {
        }
      }
      return '';
    });
    if (textHit) {
      return { clicked: true, selector: `text:${textHit}`, mode: 'text-match' };
    }
  } catch {
  }

  return { clicked: false, selector: null, mode: 'none' };
}

async function capturePageAnalysis(page) {
  return page.evaluate(() => {
    const buttonTexts = Array.from(document.querySelectorAll('button'))
      .map((button) => (button.innerText || button.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 100);

    const formActions = Array.from(document.querySelectorAll('form'))
      .map((form) => ({
        action: form.action || form.getAttribute('action') || '',
        method: (form.method || form.getAttribute('method') || 'get').toUpperCase(),
      }))
      .filter((item) => item.action || item.method)
      .slice(0, 60);

    const links = Array.from(document.querySelectorAll('a[href]'))
      .map((anchor) => anchor.href || anchor.getAttribute('href') || '')
      .filter(Boolean)
      .slice(0, 200);

    const scriptUrls = Array.from(document.querySelectorAll('script[src]'))
      .map((script) => script.src || script.getAttribute('src') || '')
      .filter(Boolean)
      .slice(0, 60);

    const serviceWorker = {
      supported: typeof navigator !== 'undefined' && !!navigator.serviceWorker,
      controller: typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller,
    };

    return {
      buttonTexts,
      formActions,
      links,
      scriptUrls,
      serviceWorker,
      pageSourcePreview: (document.documentElement?.outerHTML || '').slice(0, 12000),
    };
  });
}

async function fetchTextWithTimeout(url, timeoutMs = 5000, maxChars = 220000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 5000));
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/javascript, text/javascript, application/json, text/plain;q=0.9, */*;q=0.8' },
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      url,
      text: String(text || '').slice(0, Math.max(20000, Number(maxChars) || 220000)),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      url,
      error: error?.message || String(error),
      text: '',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function scanJavaScriptFilesForApiPaths({ scriptUrls = [], workerScriptUrls = [], baseUrl = '', timeoutMs = 30000, maxFiles = 12, maxCharsPerFile = 220000, strategy = 'high-level-efficient' } = {}) {
  const startedAt = Date.now();
  const uniqueUrls = Array.from(new Set([
    ...(scriptUrls || []).map((url) => absoluteUrlMaybe(baseUrl, url)),
    ...(workerScriptUrls || []).map((url) => absoluteUrlMaybe(baseUrl, url)),
  ].filter(Boolean))).slice(0, maxFiles);
  const scannedFiles = [];
  const endpoints = new Set();
  const discoveredWorkerScripts = new Set((workerScriptUrls || []).map((url) => absoluteUrlMaybe(baseUrl, url)).filter(Boolean));

  for (const scriptUrl of uniqueUrls) {
    if (Date.now() - startedAt >= Math.max(1000, Number(timeoutMs) || 30000)) break;
    const remainingMs = Math.max(1000, timeoutMs - (Date.now() - startedAt));
    const result = await fetchTextWithTimeout(scriptUrl, Math.min(6000, remainingMs), maxCharsPerFile);
    const fileEndpoints = extractApiPathCandidates(result.text || '', baseUrl).slice(0, 50);
    const nestedWorkerScripts = extractWorkerPathCandidates(result.text || '', baseUrl).slice(0, 30);
    nestedWorkerScripts.forEach((workerUrl) => discoveredWorkerScripts.add(workerUrl));
    fileEndpoints.forEach((endpoint) => endpoints.add(endpoint));
    scannedFiles.push({
      url: scriptUrl,
      ok: result.ok,
      status: result.status,
      endpointCount: fileEndpoints.length,
      endpoints: fileEndpoints.slice(0, 12),
      workerMatches: nestedWorkerScripts,
      error: result.error || null,
    });
  }

  return {
    ok: true,
    scannedCount: scannedFiles.length,
    elapsedMs: Date.now() - startedAt,
    timeoutBudgetMs: Math.max(1000, Number(timeoutMs) || 30000),
    strategy,
    maxCharsPerFile,
    scannedFiles,
    endpoints: Array.from(endpoints),
    workerScripts: Array.from(discoveredWorkerScripts),
    discoverAPIWebWorkers: Array.from(discoveredWorkerScripts).filter((url) => /webworkers?\.js|worker\.js|service-?worker\.js/i.test(String(url || ''))),
  };
}

function buildUrlPatternExploration({ bookingUrl = '', visited = [], networkLog = [], pageAnalysis = null, finalModel = null } = {}) {
  const patterns = new Set();
  const forms = Array.isArray(finalModel?.forms) ? finalModel.forms : [];

  patterns.add(absoluteUrlMaybe(bookingUrl, bookingUrl));
  (visited || []).forEach((entry) => patterns.add(absoluteUrlMaybe(bookingUrl, entry?.url || '')));
  (pageAnalysis?.links || []).forEach((value) => patterns.add(absoluteUrlMaybe(bookingUrl, value)));
  (pageAnalysis?.scriptUrls || []).forEach((value) => patterns.add(absoluteUrlMaybe(bookingUrl, value)));
  (pageAnalysis?.formActions || []).forEach((item) => patterns.add(absoluteUrlMaybe(bookingUrl, item?.action || '')));
  forms.forEach((form) => patterns.add(absoluteUrlMaybe(bookingUrl, form?.action || '')));
  (networkLog || []).forEach((entry) => patterns.add(absoluteUrlMaybe(bookingUrl, entry?.url || '')));

  return Array.from(patterns)
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .slice(0, 250);
}

function flattenFrames(frame, list = []) {
  list.push(frame);
  for (const child of frame.childFrames()) {
    flattenFrames(child, list);
  }
  return list;
}

async function tryClickSubmitInFrame(frame) {
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("קבע")',
    'button:has-text("זימון")',
    'button:has-text("אישור")',
    'button:has-text("שליחה")',
    'button:has-text("Submit")',
    'button:has-text("Book")',
    'button:has-text("Continue")',
  ];

  for (const selector of submitSelectors) {
    const loc = frame.locator(selector).first();
    try {
      if (await loc.count()) {
        await loc.click({ timeout: 4000 });
        return { clicked: true, via: 'selector', selector };
      }
    } catch {
    }
  }

  try {
    const clicked = await frame.evaluate(() => {
      const textRe = /(קבע|זימון|אישור|שליחה|submit|book|continue)/i;
      function walk(node, bucket = []) {
        if (!node) return bucket;
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node;
          bucket.push(el);
          if (el.shadowRoot) {
            for (const c of el.shadowRoot.children) walk(c, bucket);
          }
        }
        for (const c of node.children || []) walk(c, bucket);
        return bucket;
      }
      const nodes = walk(document.documentElement, []);
      for (const el of nodes) {
        const tag = (el.tagName || '').toLowerCase();
        if (!['button', 'input'].includes(tag)) continue;
        const type = String(el.getAttribute('type') || '').toLowerCase();
        const txt = String(el.innerText || el.getAttribute('value') || el.getAttribute('aria-label') || '').trim();
        if (type === 'submit' || textRe.test(txt)) {
          el.click();
          return true;
        }
      }
      return false;
    });
    if (clicked) return { clicked: true, via: 'shadow-dom-walk' };
  } catch {
  }

  return { clicked: false };
}

async function clickSubmitAcrossPage(page) {
  const frames = flattenFrames(page.mainFrame(), []);
  for (const frame of frames) {
    const result = await tryClickSubmitInFrame(frame);
    if (result.clicked) return { clicked: true, ...result };
  }
  return { clicked: false };
}

function extractPreferenceTokens(intentText = '', applicant = {}) {
  const candidateTerms = [
    intentText,
    applicant?.notes,
    applicant?.topic,
    applicant?.preferredDate,
    applicant?.preferredDates,
    applicant?.preferredTime,
    applicant?.preferredTimes,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const blob = normalizeText(candidateTerms.join(' '));
  const dateMatches = blob.match(/(?:20\d{2}[-\/.]\d{1,2}[-\/.]\d{1,2}|\b\d{1,2}[-\/.]\d{1,2}(?:[-\/.]\d{2,4})?\b)/g) || [];
  const timeMatches = blob.match(/\b(?:[01]?\d|2[0-3])[:.]\d{2}\b/g) || [];
  const words = blob
    .split(/[^\p{L}\p{N}:.\-]+/u)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 3)
    .slice(0, 40);
  return Array.from(new Set([...dateMatches, ...timeMatches, ...words]));
}

function scoreAppointmentSlotCandidate(candidate = {}, preferenceTokens = []) {
  const text = normalizeText(candidate?.text || '').toLowerCase();
  const href = String(candidate?.href || '').toLowerCase();
  const blob = normalizeText([
    candidate?.text,
    candidate?.ariaLabel,
    candidate?.title,
    candidate?.className,
    candidate?.id,
    candidate?.name,
    candidate?.dataDate,
    candidate?.dataTime,
  ].join(' ')).toLowerCase();

  if (!blob || blob.length < 2) return -90;
  if (/full|unavailable|not available|סגור|מלא|אין תורים|לא זמין|disabled/.test(blob)) return -70;

  let score = 0;
  if (/\b(?:[01]?\d|2[0-3])[:.]\d{2}\b/.test(blob) || candidate?.dataTime) score += 18;
  if (/(?:20\d{2}[-\/.]\d{1,2}[-\/.]\d{1,2}|\b\d{1,2}[-\/.]\d{1,2}(?:[-\/.]\d{2,4})?\b)/.test(blob) || candidate?.dataDate) score += 18;
  if (/date|time|slot|available|appointment|calendar|choose|select|שעה|תאריך|זמין|זמינות|תור|יומן|תיאום|פגישה|קביעת/.test(blob)) score += 12;
  if (/select-date=1|[?&]id=144\b/.test(String(candidate?.href || '').toLowerCase())) score += 22;
  if (/[?&]schedule=1\b/.test(href) || /[?&]departmentid=\d+/.test(href)) score += 34;
  if (/[?&]time=/.test(href) || /[?&]date=/.test(href)) score += 16;
  if (/next|continue|submit|book now|confirm|שלח|אישור|המשך|קבע/.test(blob)) score -= 16;
  if (text.length >= 4 && text.length <= 90) score += 4;
  if (['td', 'li', 'label'].includes(String(candidate?.tag || '').toLowerCase())) score += 4;

  for (const token of preferenceTokens.slice(0, 25)) {
    if (token && blob.includes(String(token).toLowerCase())) score += 8;
  }

  return score;
}

function scoreAppointmentContinueCandidate(candidate = {}) {
  const blob = normalizeText([
    candidate?.text,
    candidate?.ariaLabel,
    candidate?.title,
    candidate?.className,
    candidate?.id,
    candidate?.name,
  ].join(' ')).toLowerCase();
  let score = 0;
  if (/next|continue|confirm|approve|book|submit|reserve|schedule|המשך|אישור|קבע|זימון|שלח/.test(blob)) score += 24;
  if (/back|cancel|return|חזור|בטל/.test(blob)) score -= 16;
  return score;
}

function parseCandidateDateTimeKey(candidate = {}) {
  const raw = normalizeText([
    candidate?.dataDate,
    candidate?.dataTime,
    candidate?.text,
    candidate?.ariaLabel,
    candidate?.title,
  ].join(' '));
  const dateMatch = raw.match(/(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})|(\d{1,2})[-\/.](\d{1,2})(?:[-\/.](\d{2,4}))?/);
  const timeMatch = raw.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);

  let year = 9999;
  let month = 12;
  let day = 31;
  if (dateMatch) {
    if (dateMatch[1]) {
      year = Number(dateMatch[1]);
      month = Number(dateMatch[2]);
      day = Number(dateMatch[3]);
    } else {
      day = Number(dateMatch[4]);
      month = Number(dateMatch[5]);
      const yy = Number(dateMatch[6] || new Date().getFullYear());
      year = yy < 100 ? 2000 + yy : yy;
    }
  }

  const hour = timeMatch ? Number(timeMatch[1]) : 23;
  const minute = timeMatch ? Number(timeMatch[2]) : 59;
  return (year * 100000000) + (month * 1000000) + (day * 10000) + (hour * 100) + minute;
}

function parseCandidateTimeMinutes(candidate = {}) {
  const raw = normalizeText([
    candidate?.dataTime,
    candidate?.text,
    candidate?.ariaLabel,
    candidate?.title,
  ].join(' '));
  const match = raw.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseTimeStringToMinutes(value = '') {
  const normalized = String(value || '').trim();
  const match = normalized.match(/^([01]?\d|2[0-3])[:.]([0-5]\d)$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function parsePreferredTimesSet(applicant = {}) {
  const rawValues = [
    applicant?.preferredTime,
    applicant?.preferredTimes,
  ]
    .flatMap((value) => String(value || '').split(/[;,\s]+/g))
    .map((value) => value.trim())
    .filter(Boolean);
  const minutes = rawValues
    .map((value) => parseTimeStringToMinutes(value))
    .filter((value) => Number.isFinite(value));
  return new Set(minutes);
}

function parsePreferredTimeWindow(applicant = {}) {
  const raw = applicant?.preferredTimeWindow;
  if (raw && typeof raw === 'object') {
    const start = parseTimeStringToMinutes(raw.start || raw.from || '');
    const end = parseTimeStringToMinutes(raw.end || raw.to || '');
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return { start, end };
    }
  }

  const stringRaw = String(raw || applicant?.preferredWindow || '').trim();
  const match = stringRaw.match(/([01]?\d|2[0-3])[:.]([0-5]\d)\s*[-–]\s*([01]?\d|2[0-3])[:.]([0-5]\d)/);
  if (!match) return null;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end };
}

function normalizeSlotSelectionPolicy(applicant = {}) {
  const raw = String(applicant?.slotSelectionPolicy || applicant?.selectionPolicy || '').trim().toLowerCase();
  if (['earliest', 'earliest-available'].includes(raw)) return 'earliest';
  if (['exact', 'exact-only', 'preferred-exact-only'].includes(raw)) return 'exact-only';
  if (['window-only', 'preferred-window-only', 'strict-window', 'window-strict'].includes(raw)) return 'window-only';
  if (['preferred-window-fallback-earliest', 'window-fallback-earliest', 'preferred-window'].includes(raw)) return 'preferred-window-fallback-earliest';
  return 'score';
}

async function collectAppointmentSelectionCandidates(page) {
  const frames = flattenFrames(page.mainFrame(), []);
  const all = [];

  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex];
    const frameCandidates = await frame.evaluate((idx) => {
      function cssPath(el) {
        if (!el || !el.tagName) return '';
        const parts = [];
        let node = el;
        while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
          let part = node.tagName.toLowerCase();
          if (node.id) {
            part += `#${CSS.escape(node.id)}`;
            parts.unshift(part);
            break;
          }
          const cls = Array.from(node.classList || []).slice(0, 2);
          if (cls.length) {
            part += `.${cls.map((name) => CSS.escape(name)).join('.')}`;
          }
          const siblings = node.parentElement ? Array.from(node.parentElement.children).filter((child) => child.tagName === node.tagName) : [];
          if (siblings.length > 1) {
            const pos = siblings.indexOf(node) + 1;
            part += `:nth-of-type(${pos})`;
          }
          parts.unshift(part);
          node = node.parentElement;
        }
        return parts.join(' > ');
      }

      const selector = [
        'button',
        'a[href]',
        '[role="button"]',
        'input[type="button"]',
        'input[type="submit"]',
        'td',
        'li',
        'label',
        '[data-date]',
        '[data-time]',
        '[onclick]',
      ].join(',');
      const nodes = Array.from(document.querySelectorAll(selector));
      return nodes
        .map((el, index) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const text = String(el.innerText || el.textContent || el.getAttribute('value') || '').replace(/\s+/g, ' ').trim();
          const visible = style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 8 && rect.height > 8;
          if (!visible) return null;
          if (el.hasAttribute('disabled') || String(el.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return null;
          const likelyActionable = ['button', 'a', 'label', 'td', 'li'].includes(String(el.tagName || '').toLowerCase())
            || Boolean(el.getAttribute('onclick'))
            || String(style.cursor || '').toLowerCase() === 'pointer'
            || String(el.getAttribute('role') || '').toLowerCase() === 'button';
          if (!likelyActionable) return null;
          return {
            candidateIndex: index,
            frameIndex: Number(idx),
            domPath: cssPath(el),
            tag: String(el.tagName || '').toLowerCase(),
            text,
            id: el.id || '',
            name: el.getAttribute('name') || '',
            href: el.getAttribute('href') || '',
            onclick: el.getAttribute('onclick') || '',
            className: typeof el.className === 'string' ? el.className : '',
            ariaLabel: el.getAttribute('aria-label') || '',
            title: el.getAttribute('title') || '',
            dataDate: el.getAttribute('data-date') || '',
            dataTime: el.getAttribute('data-time') || '',
          };
        })
        .filter(Boolean)
        .slice(0, 500);
    }, frameIndex).catch(() => []);

    for (const item of frameCandidates) {
      all.push({
        ...item,
        frameUrl: frame.url(),
        frameName: frame.name() || '',
      });
    }
  }

  return all.slice(0, 1200);
}

async function clickAppointmentSelectionCandidate(page, candidate = {}) {
  const frames = flattenFrames(page.mainFrame(), []);
  const candidateFrameIndex = Number(candidate?.frameIndex);
  const orderedFrames = Number.isFinite(candidateFrameIndex)
    ? [frames[candidateFrameIndex], ...frames.filter((_, idx) => idx !== candidateFrameIndex)]
    : frames;

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  for (const frame of orderedFrames.filter(Boolean)) {
    const path = String(candidate?.domPath || '').trim();
    if (path) {
      try {
        const locator = frame.locator(path).first();
        if (await locator.count()) {
          await locator.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
          await locator.click({ timeout: 3500, force: true });
          return { clicked: true, via: 'playwright-locator', domPath: path, frameUrl: frame.url() };
        }
      } catch {
      }
    }

    const result = await frame.evaluate((fingerprint) => {
      const selector = [
        'button',
        'a[href]',
        '[role="button"]',
        'input[type="button"]',
        'input[type="submit"]',
        'td',
        'li',
        'label',
        '[data-date]',
        '[data-time]',
        '[onclick]',
      ].join(',');
      const nodes = Array.from(document.querySelectorAll(selector));
      const preferred = Number.isFinite(Number(fingerprint?.candidateIndex))
        ? nodes[Number(fingerprint.candidateIndex)]
        : null;

      function normalizeValue(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
      }

      function matchElement(el) {
        if (!el) return false;
        const elText = normalizeValue(el.innerText || el.textContent || el.getAttribute('value') || '');
        const wantedText = normalizeValue(fingerprint?.text || '');
        if (wantedText && elText && !elText.includes(wantedText.slice(0, 24)) && !wantedText.includes(elText.slice(0, 24))) {
          return false;
        }
        const checks = [
          [fingerprint?.id, el.id || ''],
          [fingerprint?.name, el.getAttribute('name') || ''],
          [fingerprint?.href, el.getAttribute('href') || ''],
          [fingerprint?.onclick, el.getAttribute('onclick') || ''],
          [fingerprint?.ariaLabel, el.getAttribute('aria-label') || ''],
        ];
        return checks.every(([wanted, actual]) => !wanted || normalizeValue(actual).includes(normalizeValue(wanted)) || normalizeValue(wanted).includes(normalizeValue(actual)));
      }

      const target = (preferred && matchElement(preferred) ? preferred : null)
        || nodes.find((el) => matchElement(el))
        || null;
      if (!target) return { clicked: false, reason: 'not-found' };

      try {
        target.scrollIntoView({ block: 'center', inline: 'center' });
      } catch {
      }

      try {
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        if (typeof target.click === 'function') target.click();
        return { clicked: true, via: 'dom-events' };
      } catch (error) {
        return { clicked: false, reason: error?.message || String(error) };
      }
    }, candidate).catch((error) => ({ clicked: false, reason: error?.message || String(error) }));

    if (result?.clicked) {
      return {
        ...result,
        frameUrl: frame.url(),
      };
    }

    const candidateText = normalize(candidate?.text || '').toLowerCase();
    if (candidateText) {
      try {
        const byText = frame.locator('button, a[href], [role="button"], input[type="button"], input[type="submit"], td, li, label')
          .filter({ hasText: candidateText.slice(0, 40) })
          .first();
        if (await byText.count()) {
          await byText.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
          await byText.click({ timeout: 3500, force: true });
          return { clicked: true, via: 'playwright-text', frameUrl: frame.url() };
        }
      } catch {
      }
    }
  }

  return { clicked: false, reason: 'not-found-in-frames' };
}

function mergeSelectedAppointmentOptions(existing = [], incoming = []) {
  const merged = [...(Array.isArray(existing) ? existing : [])];
  const seen = new Set(merged.map((item) => `${String(item?.text || '').toLowerCase()}|${String(item?.dataDate || '').toLowerCase()}|${String(item?.dataTime || '').toLowerCase()}`));
  for (const item of Array.isArray(incoming) ? incoming : []) {
    const key = `${String(item?.text || '').toLowerCase()}|${String(item?.dataDate || '').toLowerCase()}|${String(item?.dataTime || '').toLowerCase()}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged.slice(-8);
}

function extractBookingConfirmationEvidence(model = {}) {
  const text = normalizeText(model?.pageText || '');
  const lowered = text.toLowerCase();
  const idMatch = text.match(/(?:confirmation|reference|appointment\s*(?:id|number)|מספר\s*(?:אישור|הזמנה|תור)|אסמכתא)\s*[:#-]?\s*([A-Za-z0-9\-]{4,})/i);
  const dateMatch = text.match(/(?:20\d{2}[-\/.]\d{1,2}[-\/.]\d{1,2}|\b\d{1,2}[-\/.]\d{1,2}(?:[-\/.]\d{2,4})?\b)/);
  const timeMatch = text.match(/\b(?:[01]?\d|2[0-3])[:.]\d{2}\b/);
  const confirmed = /confirmed|scheduled|success|appointment was set|תור נקבע|נקבע בהצלחה|אושר|ההזמנה נקלטה/.test(lowered);
  return {
    detected: Boolean(confirmed || idMatch),
    confirmationId: idMatch?.[1] || null,
    scheduledDate: dateMatch?.[0] || null,
    scheduledTime: timeMatch?.[0] || null,
    messagePreview: text.slice(0, 220),
    finalUrl: model?.href || null,
    capturedAt: new Date().toISOString(),
  };
}

async function tryAutoSelectAppointmentDateTime(page, {
  intentText = '',
  applicant = {},
  maxSelections = 4,
} = {}) {
  const beforeUrl = page.url();
  const loweredBeforeUrl = String(beforeUrl || '').toLowerCase();
  const preferenceTokens = extractPreferenceTokens(intentText, applicant);
  const slotSelectionPolicy = normalizeSlotSelectionPolicy(applicant);
  const preferredTimesSet = parsePreferredTimesSet(applicant);
  const preferredTimeWindow = parsePreferredTimeWindow(applicant);
  const selectedOptions = [];
  const candidatePreview = [];
  const clickedKeys = new Set();

  async function fillAppointmentFieldsAfterSelection() {
    const selectedModel = await snapshotFormModel(page).catch(() => null);
    if (!selectedModel) return [];
    return attemptPrefill(page, selectedModel, applicant).catch(() => []);
  }

  if (/ganeytikva\.org\.il/.test(loweredBeforeUrl) && /[?&]id=15\b/.test(loweredBeforeUrl)) {
    const entryCandidates = await collectAppointmentSelectionCandidates(page);
    const entry = entryCandidates.find((candidate) => {
      const href = String(candidate?.href || '').toLowerCase();
      const text = normalizeText(candidate?.text || '').toLowerCase();
      return /select-date=1|[?&]id=144\b/.test(href)
        || (/תיאום|פגישה|קביעת|appointment|book|schedule/.test(text) && /arnona|ארנונה|גבייה/.test(text));
    });
    if (entry) {
      const entryClick = await clickAppointmentSelectionCandidate(page, entry);
      if (entryClick?.clicked) {
        await waitForPageDomStable(page, 900);
        selectedOptions.push({
          text: entry.text || 'navigate-to-date-selection',
          dataDate: null,
          dataTime: null,
          score: 100,
          selectedAt: new Date().toISOString(),
        });
      }
    }
  }

  for (let step = 0; step < Math.max(1, Number(maxSelections) || 2); step += 1) {
    const candidates = await collectAppointmentSelectionCandidates(page);
    const currentUrl = String(page.url() || '').toLowerCase();
    const ranked = candidates
      .map((candidate) => ({
        ...candidate,
        slotScore: scoreAppointmentSlotCandidate(candidate, preferenceTokens),
        slotDateTimeKey: parseCandidateDateTimeKey(candidate),
      }))
      .filter((candidate) => {
        const href = String(candidate?.href || '').toLowerCase();
        const text = normalizeText(candidate?.text || '').toLowerCase();
        if (/ganeytikva\.org\.il/.test(currentUrl) && /[?&]id=144\b/.test(currentUrl)) {
          if (/[?&]id=15\b/.test(href)) return false;
          if (/back|return|cancel|חזור|בטל/.test(text)) return false;
          if (candidate?.tag === 'a' && href && !/select-date=1|[?&]schedule=1\b|[?&]departmentid=\d+|javascript:void\(0\)|^#/.test(href) && !candidate?.dataDate && !candidate?.dataTime) {
            return false;
          }
        }
        return true;
      })
      .filter((candidate) => candidate.slotScore >= 10)
      .sort((left, right) => {
        if (right.slotScore !== left.slotScore) return right.slotScore - left.slotScore;
        return Number(left.slotDateTimeKey || Number.MAX_SAFE_INTEGER) - Number(right.slotDateTimeKey || Number.MAX_SAFE_INTEGER);
      });

    const earliestSorted = [...ranked].sort((left, right) => Number(left.slotDateTimeKey || Number.MAX_SAFE_INTEGER) - Number(right.slotDateTimeKey || Number.MAX_SAFE_INTEGER));
    const exactMatches = ranked.filter((candidate) => {
      const t = parseCandidateTimeMinutes(candidate);
      return Number.isFinite(t) && preferredTimesSet.has(t);
    });
    const windowMatches = ranked.filter((candidate) => {
      if (!preferredTimeWindow) return false;
      const t = parseCandidateTimeMinutes(candidate);
      return Number.isFinite(t) && t >= preferredTimeWindow.start && t <= preferredTimeWindow.end;
    });

    const policyCandidates = (() => {
      if (slotSelectionPolicy === 'earliest') return earliestSorted;
      if (slotSelectionPolicy === 'exact-only') return exactMatches;
      if (slotSelectionPolicy === 'window-only') {
        return windowMatches.length
          ? [...windowMatches].sort((left, right) => Number(left.slotDateTimeKey || Number.MAX_SAFE_INTEGER) - Number(right.slotDateTimeKey || Number.MAX_SAFE_INTEGER))
          : [];
      }
      if (slotSelectionPolicy === 'preferred-window-fallback-earliest') {
        return windowMatches.length ? [...windowMatches].sort((left, right) => Number(left.slotDateTimeKey || Number.MAX_SAFE_INTEGER) - Number(right.slotDateTimeKey || Number.MAX_SAFE_INTEGER)) : earliestSorted;
      }
      return ranked;
    })();

    if (candidatePreview.length === 0) {
      const previewSource = policyCandidates.length ? policyCandidates : ranked;
      candidatePreview.push(
        ...previewSource.slice(0, 3).map((candidate) => ({
          text: candidate?.text || null,
          dataDate: candidate?.dataDate || null,
          dataTime: candidate?.dataTime || null,
          score: Number(candidate?.slotScore || 0),
          slotDateTimeKey: Number(candidate?.slotDateTimeKey || Number.MAX_SAFE_INTEGER),
        })),
      );
    }

    const nextCandidate = policyCandidates.find((candidate) => {
      const key = `${String(candidate.text || '').toLowerCase()}|${String(candidate.dataDate || '').toLowerCase()}|${String(candidate.dataTime || '').toLowerCase()}`;
      if (clickedKeys.has(key)) return false;
      return true;
    });

    if (!nextCandidate) break;
    const clickResult = await clickAppointmentSelectionCandidate(page, nextCandidate);
    if (!clickResult?.clicked) break;

    const key = `${String(nextCandidate.text || '').toLowerCase()}|${String(nextCandidate.dataDate || '').toLowerCase()}|${String(nextCandidate.dataTime || '').toLowerCase()}`;
    clickedKeys.add(key);
    selectedOptions.push({
      text: nextCandidate.text || null,
      dataDate: nextCandidate.dataDate || null,
      dataTime: nextCandidate.dataTime || null,
      score: nextCandidate.slotScore,
      selectedAt: new Date().toISOString(),
    });

    await waitForPageDomStable(page, 700);
    await fillAppointmentFieldsAfterSelection();
  }

  const continuationCandidates = await collectAppointmentSelectionCandidates(page);
  const nextAction = continuationCandidates
    .map((candidate) => ({
      ...candidate,
      continueScore: scoreAppointmentContinueCandidate(candidate),
    }))
    .filter((candidate) => candidate.continueScore >= 24)
    .sort((left, right) => right.continueScore - left.continueScore)[0];

  let continuation = { clicked: false, reason: 'not-found' };
  if (nextAction) {
    continuation = await clickAppointmentSelectionCandidate(page, nextAction);
    if (continuation?.clicked) {
      await waitForPageDomStable(page, 900);
      await fillAppointmentFieldsAfterSelection();
    }
  }

  const afterUrl = page.url();
  return {
    applied: selectedOptions.length > 0 || Boolean(continuation?.clicked),
    selectedOptions,
    candidatePreview,
    continuationClicked: Boolean(continuation?.clicked),
    continuationReason: continuation?.reason || null,
    continuationVia: continuation?.via || null,
    beforeUrl,
    afterUrl,
    urlChanged: beforeUrl !== afterUrl,
  };
}

function normalizeDebugOptions(source = {}) {
  return {
    timelineDebugMode: isTruthy(source?.timelineDebugMode ?? process.env.BOOKING_TIMELINE_DEBUG_MODE, true),
    snapshotDebugMode: isTruthy(source?.snapshotDebugMode ?? process.env.BOOKING_SNAPSHOT_DEBUG_MODE, true),
    visualDebugLayer: isTruthy(source?.visualDebugLayer ?? process.env.BOOKING_VISUAL_DEBUG_LAYER, false),
    replaySimulatorMode: isTruthy(source?.replaySimulatorMode ?? process.env.BOOKING_REPLAY_SIMULATOR_MODE, true),
    replayDiffDebugger: isTruthy(source?.replayDiffDebugger ?? process.env.BOOKING_REPLAY_DIFF_DEBUGGER, true),
    domFingerprintLogging: isTruthy(source?.domFingerprintLogging ?? process.env.BOOKING_DOM_FINGERPRINT_LOGGING, true),
  };
}

function ensureSessionDebugState(session) {
  if (!session) return null;
  session.debugOptions = normalizeDebugOptions(session.debugOptions || session.applicant || {});
  session.debug = session.debug && typeof session.debug === 'object'
    ? session.debug
    : { timeline: [], snapshots: [], visualLayer: [], errorBuckets: {}, replaySimulator: { lastRun: null } };
  session.debug.timeline = Array.isArray(session.debug.timeline) ? session.debug.timeline : [];
  session.debug.snapshots = Array.isArray(session.debug.snapshots) ? session.debug.snapshots : [];
  session.debug.visualLayer = Array.isArray(session.debug.visualLayer) ? session.debug.visualLayer : [];
  session.debug.errorBuckets = session.debug.errorBuckets && typeof session.debug.errorBuckets === 'object' ? session.debug.errorBuckets : {};
  session.debug.replaySimulator = session.debug.replaySimulator && typeof session.debug.replaySimulator === 'object'
    ? session.debug.replaySimulator
    : { lastRun: null };
  return session.debug;
}

function buildDomFingerprint({ url = '', title = '', forms = [], pageText = '' } = {}) {
  const formShape = (Array.isArray(forms) ? forms : []).map((form) => ({
    action: form?.action || '',
    method: form?.method || '',
    fieldCount: Array.isArray(form?.fields) ? form.fields.length : 0,
    submitCount: Array.isArray(form?.submitButtons) ? form.submitButtons.length : 0,
    fields: (Array.isArray(form?.fields) ? form.fields : []).slice(0, 12).map((field) => [field?.tag, field?.type, field?.name, field?.label].join(':')),
  }));
  const payload = normalizeText([
    url,
    title,
    String(pageText || '').slice(0, 600),
    JSON.stringify(formShape),
  ].join('|'));
  return createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

function classifyErrorBucket(reason = '', extra = {}) {
  const blob = normalizeText([
    reason,
    extra?.error,
    extra?.failureReason,
    extra?.mode,
    extra?.state,
  ].join(' ')).toLowerCase();
  if (/captcha|turnstile|hcaptcha|recaptcha/.test(blob)) return 'anti_bot';
  if (/otp|verification|2fa|one-time/.test(blob)) return 'otp';
  if (/login|password|credential|authenticate/.test(blob)) return 'authentication';
  if (/selector|not-found|missing-element|hidden|covered|clickable/.test(blob)) return 'selector';
  if (/navigation|redirect|url|non-booking/.test(blob)) return 'navigation';
  if (/submit|approval|review/.test(blob)) return 'submission';
  if (/replay/.test(blob)) return 'replay';
  if (/timeout|timed out/.test(blob)) return 'timeout';
  if (/network|fetch|xhr|api/.test(blob)) return 'network';
  return 'dom';
}

function incrementSessionErrorBucket(session, bucket = 'dom') {
  const debug = ensureSessionDebugState(session);
  debug.errorBuckets[bucket] = Number(debug.errorBuckets[bucket] || 0) + 1;
}

function buildReplayDiffSummary(beforeSnapshot = null, afterSnapshot = null) {
  if (!beforeSnapshot || !afterSnapshot) return null;
  return {
    urlChanged: beforeSnapshot.url !== afterSnapshot.url,
    titleChanged: beforeSnapshot.title !== afterSnapshot.title,
    domFingerprintChanged: beforeSnapshot.domFingerprint !== afterSnapshot.domFingerprint,
    formCountDelta: Number(afterSnapshot.formCount || 0) - Number(beforeSnapshot.formCount || 0),
    fieldCountDelta: Number(afterSnapshot.fieldCount || 0) - Number(beforeSnapshot.fieldCount || 0),
  };
}

export function explainDecision(candidate = {}) {
  return {
    signals: [
      candidate.textMatch ? 'text match' : null,
      candidate.hrefMatch ? 'href match' : null,
      candidate.intentBoost ? 'intent match' : null,
      candidate.replayScore ? 'learned behavior' : null,
      candidate.successRate ? 'high success rate' : null,
      candidate.domFingerprint ? 'dom fingerprint' : null,
    ].filter(Boolean),
  };
}

export function buildReplayExplanationView(session = {}) {
  const replayActions = Array.isArray(session?.replay?.actions) ? session.replay.actions : [];
  const latestTimeline = Array.isArray(session?.debug?.timeline) ? session.debug.timeline : [];
  const replaySimulatorCandidates = Array.isArray(session?.debug?.replaySimulator?.lastRun?.candidates)
    ? session.debug.replaySimulator.lastRun.candidates
    : [];
  const replayFailures = Array.isArray(session?.domFailures)
    ? session.domFailures.filter((entry) => String(entry?.bucket || '').toLowerCase() === 'replay' || /replay/i.test(String(entry?.reason || '')))
    : [];

  return {
    currentStage: session?.interactionStage || null,
    replaySummary: buildAttendedReplaySummary(session),
    simulator: session?.debug?.replaySimulator?.lastRun || null,
    topCandidates: replaySimulatorCandidates.slice(0, 5).map((candidate) => ({
      text: candidate.text || null,
      selector: candidate.selector || null,
      replayScore: Number(candidate.replayScore || 0),
      replayConfidence: Number(candidate.replayConfidence || 0),
      successRate: Number(candidate.successRate || 0),
      explanation: candidate.explanation || explainDecision(candidate),
    })),
    recentActions: replayActions.slice(-8).map((action) => ({
      at: action.at || null,
      action: action.action || null,
      mode: action.mode || null,
      selector: action.selector || null,
      ok: action.ok ?? null,
      reason: action.reason || null,
    })),
    recentFailures: replayFailures.slice(-6).map((failure) => ({
      at: failure.at || null,
      reason: failure.reason || null,
      bucket: failure.bucket || null,
      url: failure.url || null,
    })),
    timelineReplayEvents: latestTimeline
      .filter((entry) => /replay/i.test(String(entry?.type || '')) || /replay/i.test(String(entry?.action || '')))
      .slice(-8),
  };
}

export function buildAgentDebugView(session = {}, { elapsedMs = null, mode = 'autonomous-browser-agent' } = {}) {
  const timeline = Array.isArray(session?.debug?.timeline) ? session.debug.timeline : [];
  const snapshots = Array.isArray(session?.debug?.snapshots) ? session.debug.snapshots : [];
  const latestEnvelope = timeline[timeline.length - 1] || null;
  const lastSnapshot = snapshots[snapshots.length - 1] || null;
  return {
    mode,
    state: session?.state || null,
    interactionStage: session?.interactionStage || null,
    flowPhase: session?.flowPhase?.phaseKey || null,
    requiresHuman: Boolean(session?.hitlRequired),
    hitlReason: session?.hitlReason || null,
    elapsedMs: Number.isFinite(Number(elapsedMs)) ? Number(elapsedMs) : null,
    debugOptions: session?.debugOptions || null,
    errorBuckets: session?.debug?.errorBuckets || {},
    timelineCount: timeline.length,
    snapshotCount: snapshots.length,
    latestEnvelope,
    lastDomFingerprint: lastSnapshot?.domFingerprint || null,
    replayExplanationView: buildReplayExplanationView(session),
  };
}

function pushVisualDebugEntry(session, entry = {}) {
  const debug = ensureSessionDebugState(session);
  if (!session?.debugOptions?.visualDebugLayer && !session?.debugOptions?.timelineDebugMode) return;
  debug.visualLayer.push({ at: new Date().toISOString(), ...entry });
  if (debug.visualLayer.length > DEBUG_VISUAL_LAYER_LIMIT) {
    debug.visualLayer.splice(0, debug.visualLayer.length - DEBUG_VISUAL_LAYER_LIMIT);
  }
}

function pushDebugEnvelope(session, envelope = {}) {
  const debug = ensureSessionDebugState(session);
  if (!session?.debugOptions?.timelineDebugMode) return envelope;
  debug.timeline.push(envelope);
  if (debug.timeline.length > DEBUG_TIMELINE_LIMIT) {
    debug.timeline.splice(0, debug.timeline.length - DEBUG_TIMELINE_LIMIT);
  }
  return envelope;
}

async function captureDebugSnapshot(page, session, { label = '' } = {}) {
  if (!page || !session?.debugOptions?.snapshotDebugMode) return null;
  const model = await snapshotFormModel(page).catch(() => null);
  const pageText = String(model?.pageText || '');
  const forms = Array.isArray(model?.forms) ? model.forms : [];
  const fieldCount = forms.reduce((sum, form) => sum + (Array.isArray(form?.fields) ? form.fields.length : 0), 0);
  const snapshot = {
    label,
    at: new Date().toISOString(),
    url: model?.href || page.url(),
    title: model?.title || '',
    textPreview: pageText.slice(0, 240),
    formCount: forms.length,
    fieldCount,
    domFingerprint: buildDomFingerprint({ url: model?.href || page.url(), title: model?.title || '', forms, pageText }),
  };
  const debug = ensureSessionDebugState(session);
  debug.snapshots.push(snapshot);
  if (debug.snapshots.length > DEBUG_SNAPSHOT_LIMIT) {
    debug.snapshots.splice(0, debug.snapshots.length - DEBUG_SNAPSHOT_LIMIT);
  }
  return snapshot;
}

function createDebugEventEnvelope(session, {
  type = 'action',
  action = '',
  stage = '',
  status = 'info',
  candidate = null,
  beforeSnapshot = null,
  afterSnapshot = null,
  reason = '',
  errorBucket = '',
  metadata = {},
} = {}) {
  return {
    id: randomUUID(),
    at: new Date().toISOString(),
    sessionToken: session?.token || null,
    type,
    action,
    stage: stage || session?.interactionStage || null,
    status,
    state: session?.state || null,
    url: afterSnapshot?.url || beforeSnapshot?.url || session?.currentUrl || null,
    reason: reason || null,
    errorBucket: errorBucket || null,
    candidate: candidate ? {
      text: candidate.text || candidate.label || null,
      href: candidate.href || null,
      score: Number(candidate.score || candidate.replayScore || 0),
      explanation: explainDecision(candidate),
    } : null,
    domFingerprintBefore: beforeSnapshot?.domFingerprint || null,
    domFingerprintAfter: afterSnapshot?.domFingerprint || null,
    diff: session?.debugOptions?.replayDiffDebugger ? buildReplayDiffSummary(beforeSnapshot, afterSnapshot) : null,
    metadata,
  };
}

async function recordDebugTransition(session, page, details = {}) {
  const beforeSnapshot = details.beforeSnapshot || await captureDebugSnapshot(page, session, { label: `${details.action || details.type || 'action'}:before` });
  const afterSnapshot = details.afterSnapshot || await captureDebugSnapshot(page, session, { label: `${details.action || details.type || 'action'}:after` });
  const envelope = createDebugEventEnvelope(session, { ...details, beforeSnapshot, afterSnapshot });
  pushDebugEnvelope(session, envelope);
  if (details.candidate || details.metadata) {
    pushVisualDebugEntry(session, {
      kind: details.type || 'action',
      action: details.action || '',
      stage: details.stage || session?.interactionStage || null,
      candidate: details.candidate ? { ...details.candidate, explanation: explainDecision(details.candidate) } : null,
      diff: envelope.diff,
      metadata: details.metadata || {},
    });
  }
  return envelope;
}

function toPublicSession(session, { includeNetwork = false, networkLimit = 100 } = {}) {
  ensureSessionDebugState(session);
  const replayExplanationView = buildReplayExplanationView(session);
  const agentDebug = buildAgentDebugView(session, { mode: 'attended-browser-agent' });
  const base = {
    ok: true,
    token: session.token,
    resumeToken: session.token,
    requestId: session.requestId,
    state: session.state,
    submitted: Boolean(session.submitted),
    requiresHuman: [CHECKPOINT_STATES.AWAITING_LOGIN, CHECKPOINT_STATES.AWAITING_OTP, CHECKPOINT_STATES.AWAITING_CAPTCHA, CHECKPOINT_STATES.AWAITING_HUMAN].includes(session.state) || Boolean(session.hitlRequired),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    bookingUrl: session.bookingUrl,
    currentUrl: session.currentUrl,
    pageTitle: session.pageTitle,
    prefilledFields: session.prefilledFields || 0,
    antiBotDetected: session.antiBotDetected || false,
    flowPhase: session.flowPhase || null,
    interactionStage: session.interactionStage || inferInteractionStage({ text: session.pageText || '', submitted: Boolean(session.submitted), flowPhase: session.flowPhase || null }),
    selectedAppointmentOptions: Array.isArray(session.selectedAppointmentOptions) ? session.selectedAppointmentOptions : [],
    appointmentCandidatePreview: Array.isArray(session.appointmentCandidatePreview) ? session.appointmentCandidatePreview : [],
    formRequirements: Array.isArray(session.formRequirements) ? session.formRequirements : [],
    autoSelectionAttempts: Number(session.autoSelectionAttempts || 0),
    lastAutoSelectionAt: session.lastAutoSelectionAt || null,
    finalValidation: session.finalValidation || null,
    confirmation: session.confirmation || null,
    approval: {
      approved: Boolean(session.approval?.approved),
      approvedAt: session.approval?.approvedAt || null,
      approvedBy: session.approval?.approvedBy || null,
      reason: session.approval?.reason || null,
    },
    screenshots: session.screenshots || [],
    notes: session.notes || [],
    replay: buildAttendedReplaySummary(session),
    replayExplanationView,
    agentDebug,
    debug: {
      options: session.debugOptions,
      timelineCount: session.debug?.timeline?.length || 0,
      snapshotCount: session.debug?.snapshots?.length || 0,
      errorBuckets: session.debug?.errorBuckets || {},
      replaySimulator: session.debug?.replaySimulator?.lastRun || null,
      replayExplanationView,
      latestTimeline: (session.debug?.timeline || []).slice(-12),
      visualLayer: (session.debug?.visualLayer || []).slice(-8),
    },
  };
  if (includeNetwork) {
    base.network = (session.network || []).slice(-Math.max(1, Number(networkLimit) || 100));
  }
  return base;
}

function buildPageReplayContext(model = {}) {
  const pageText = String(model?.pageText || '');
  const pageTerms = Array.from(new Set(
    pageText
      .split(/[\s,.;:|/()\-]+/g)
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length >= 3)
      .slice(0, 80)
  ));
  return {
    pageUrl: model?.href || '',
    pageTitle: model?.title || '',
    pagePath: (() => {
      try {
        return new URL(String(model?.href || '').trim()).pathname || '';
      } catch {
        return '';
      }
    })(),
    pageTerms,
    domVersion: (() => {
      const primaryForm = Array.isArray(model?.forms) && model.forms.length ? model.forms[0] : null;
      const primaryField = Array.isArray(primaryForm?.fields) && primaryForm.fields.length ? primaryForm.fields[0] : null;
      if (!primaryForm && !primaryField) return '';
      return buildDomVersion({
        pageUrl: model?.href || '',
        pageTitle: model?.title || '',
        formAction: primaryForm?.action || '',
        tag: primaryField?.tag || '',
        inputType: primaryField?.type || '',
        role: primaryField?.role || '',
        structuralTerms: pageTerms,
      });
    })(),
    semanticEmbedding: buildSemanticEmbedding(normalizeText([
      model?.href || '',
      model?.title || '',
      pageText,
      pageTerms.join(' '),
    ].join(' '))),
  };
}

function computeNormalizedConfidence(score = 0, maxScore = 0) {
  const numericScore = Number(score || 0);
  const numericMax = Number(maxScore || 0);
  if (!numericMax || numericMax <= 0) return 0;
  return Math.max(0, Math.min(1, numericScore / numericMax));
}

function computeDynamicFieldThreshold(scoredFields = []) {
  const scores = (Array.isArray(scoredFields) ? scoredFields : []).map((item) => Number(item?.score || 0)).filter((score) => Number.isFinite(score));
  if (!scores.length) return { absolute: 18, confidence: 0.7, maxScore: 0 };
  const maxScore = Math.max(...scores);
  if (maxScore >= 55) return { absolute: Math.max(22, maxScore * 0.38), confidence: 0.56, maxScore };
  if (maxScore >= 35) return { absolute: Math.max(18, maxScore * 0.48), confidence: 0.62, maxScore };
  return { absolute: Math.max(14, maxScore * 0.58), confidence: 0.72, maxScore };
}

function escapePlaywrightTextSelector(value = '') {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildReplayTextSelectors(text = '', tagHints = ['button', 'a', '[role="button"]']) {
  const rawText = String(text || '').replace(/\s+/g, ' ').trim();
  const normalized = normalizeText(rawText);
  if (!normalized) return [];
  const selectors = [];
  const candidates = Array.from(new Set([rawText, normalized].filter(Boolean)));
  for (const tagHint of tagHints) {
    for (const candidate of candidates) {
      if (candidate.length <= 40) {
        selectors.push(`${tagHint}:has-text("${escapePlaywrightTextSelector(candidate)}")`);
        selectors.push(`${tagHint}:text-is("${escapePlaywrightTextSelector(candidate)}")`);
      }
    }
  }
  return Array.from(new Set(selectors));
}

function uniqueNonEmpty(values = [], { max = 12 } = {}) {
  return Array.from(new Set((values || []).map((value) => normalizeText(value)).filter(Boolean))).slice(0, max);
}

function escapeAttributeSelector(value = '') {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildApiAwareSelectors({ record = {}, intent = '' } = {}) {
  const selectors = [];
  const href = String(record?.href || '').trim();
  const onclick = String(record?.onclick || '').trim();
  const formAction = String(record?.formAction || '').trim();
  const normalizedIntent = String(intent || '').toLowerCase();

  if (href) {
    selectors.push(`a[href="${escapeAttributeSelector(href)}"]`);
    try {
      const parsed = new URL(href, 'https://example.invalid');
      if (parsed.pathname) selectors.push(`a[href*="${escapeAttributeSelector(parsed.pathname)}"]`);
      if (/schedule|appoint|book|slot|queue|reservation/i.test(parsed.pathname + parsed.search)) {
        selectors.push(`a[href*="${escapeAttributeSelector((parsed.pathname + parsed.search).slice(0, 120))}"]`);
      }
    } catch {
      if (/schedule|appoint|book|slot|queue|reservation/i.test(href)) {
        selectors.push(`a[href*="${escapeAttributeSelector(href.slice(0, 120))}"]`);
      }
    }
  }

  if (onclick) {
    selectors.push(`[onclick*="${escapeAttributeSelector(onclick.slice(0, 120))}"]`);
  }

  if (formAction) {
    selectors.push(`form[action*="${escapeAttributeSelector(formAction.slice(0, 120))}"] button`);
    selectors.push(`form[action*="${escapeAttributeSelector(formAction.slice(0, 120))}"] [type="submit"]`);
  }

  if (!selectors.length && /schedule|appoint|book|slot|queue|reservation|זימון|קבע|תור/.test(normalizedIntent)) {
    selectors.push('a[href*="schedule"]', 'a[href*="appoint"]', 'form[action*="schedule"] button', 'form[action*="appoint"] button');
  }

  return Array.from(new Set(selectors.filter(Boolean)));
}

function inferRoleHints(record = {}, intent = '') {
  const roles = uniqueNonEmpty([
    String(record?.role || '').toLowerCase(),
    /button|submit/i.test(String(record?.tag || '')) || /button|submit/i.test(String(record?.inputType || '')) ? 'button' : '',
    record?.href ? 'link' : '',
    'button',
    'link',
  ], { max: 4 });
  const names = uniqueNonEmpty([
    record?.text,
    record?.label,
    record?.ariaLabel,
    record?.title,
    String(intent || '').length <= 80 ? intent : '',
  ], { max: 6 });

  return roles.flatMap((role) => names.map((name) => ({ role, name }))).slice(0, 12);
}

function buildTextSelectorHints(record = {}, intent = '') {
  const names = uniqueNonEmpty([
    record?.text,
    record?.label,
    record?.ariaLabel,
    record?.title,
    String(intent || '').length <= 80 ? intent : '',
  ], { max: 6 });
  return names.flatMap((name) => buildReplayTextSelectors(name, ['button', 'a', '[role="button"]']));
}

export function buildSelectorExecutionPlan({ intent = '', record = {}, providedSelectors = [], learnedSelectors = [] } = {}) {
  return {
    apiSelectors: buildApiAwareSelectors({ record, intent }),
    roleHints: inferRoleHints(record, intent),
    textSelectors: buildTextSelectorHints(record, intent),
    heuristicSelectors: Array.from(new Set([
      ...(providedSelectors || []),
      ...(learnedSelectors || []),
      ...getDefaultHealingSelectors(intent),
    ].filter(Boolean))),
  };
}

export function scoreActionCandidateByEmbeddings(candidate = {}, { intent = '', record = null } = {}) {
  const targetText = normalizeText([
    intent,
    record?.text,
    record?.label,
    record?.ariaLabel,
    record?.title,
    record?.href,
  ].join(' '));
  const candidateText = normalizeText([
    candidate?.text,
    candidate?.href,
    candidate?.onclick,
    candidate?.id,
    candidate?.name,
    candidate?.className,
    candidate?.ariaLabel,
    candidate?.title,
  ].join(' '));

  if (!targetText || !candidateText) return 0;
  const semanticScore = Math.max(0, cosineSimilarity(buildSemanticEmbedding(targetText), buildSemanticEmbedding(candidateText)));
  let score = semanticScore * 100;
  const normalizedCandidate = candidateText.toLowerCase();
  const normalizedTarget = targetText.toLowerCase();
  if (normalizedCandidate.includes(normalizedTarget)) score += 20;
  if (normalizedTarget.split(/\s+/g).some((token) => token.length >= 4 && normalizedCandidate.includes(token))) score += 8;
  return score;
}

async function trySelectorListClick(page, selectors = [], { timeoutPerSelectorMs = 1500, mode = 'selector' } = {}) {
  for (const selector of selectors || []) {
    try {
      const locator = page.locator(selector).first();
      if (!(await locator.count())) continue;
      await locator.click({ timeout: Math.max(500, Number(timeoutPerSelectorMs) || 1500) });
      return { clicked: true, selector, mode };
    } catch {
    }
  }
  return { clicked: false, selector: null, mode: `${mode}-failed` };
}

async function tryRoleBasedSelectorPass(page, roleHints = [], { timeoutPerSelectorMs = 1500 } = {}) {
  for (const hint of roleHints || []) {
    try {
      const locator = page.getByRole(hint.role, { name: hint.name, exact: false }).first();
      if (!(await locator.count())) continue;
      await locator.click({ timeout: Math.max(500, Number(timeoutPerSelectorMs) || 1500) });
      return { clicked: true, selector: `${hint.role}:${hint.name}`, mode: 'role-based-selector' };
    } catch {
    }
  }
  return { clicked: false, selector: null, mode: 'role-based-selector-failed' };
}

async function tryEmbeddingClickFallback(page, { intent = '', record = null, minScore = 42 } = {}) {
  const candidates = await collectVisibleActionCandidates(page).catch(() => []);
  const ranked = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({
      ...candidate,
      embeddingScore: scoreActionCandidateByEmbeddings(candidate, { intent, record }),
    }))
    .sort((left, right) => right.embeddingScore - left.embeddingScore);

  const best = ranked.find((candidate) => Number(candidate.embeddingScore || 0) >= minScore) || null;
  if (!best) {
    return { clicked: false, selector: null, mode: 'embedding-fallback-failed', embeddingScore: ranked[0]?.embeddingScore || 0 };
  }

  const clickResult = await clickActionCandidateByFingerprint(page, best).catch(() => ({ clicked: false, reason: 'embedding-click-error' }));
  if (!clickResult?.clicked) {
    return {
      clicked: false,
      selector: null,
      mode: 'embedding-fallback-failed',
      embeddingScore: best.embeddingScore,
      failureReason: clickResult?.reason || 'embedding-click-error',
    };
  }
  return {
    clicked: true,
    selector: `embedding:${best.text || best.href || best.id || 'candidate'}`,
    mode: 'embedding-fallback',
    embeddingScore: best.embeddingScore,
  };
}

function isXPathDomPath(domPath = '') {
  const value = String(domPath || '').trim();
  return Boolean(value) && (/^xpath=/i.test(value) || value.startsWith('/') || value.startsWith('./') || value.startsWith('('));
}

function buildDomPathSelectorVariants(domPath = '') {
  const value = String(domPath || '').trim();
  if (!value) return [];
  if (isXPathDomPath(value)) {
    return [value.startsWith('xpath=') ? value : `xpath=${value}`];
  }
  return [value];
}

function buildSelectorHealingCacheKey({ host = '', intent = '', selectors = [], url = '' } = {}) {
  return [String(host || '').trim().toLowerCase(), normalizeText(intent).toLowerCase(), String(url || '').trim().toLowerCase(), (selectors || []).join('|')].join('::');
}

function getSelectorHealingCacheEntry(cacheKey = '') {
  const entry = SELECTOR_HEALING_LLM_CACHE.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - Number(entry.ts || 0) > SELECTOR_HEALING_LLM_CACHE_TTL_MS) {
    SELECTOR_HEALING_LLM_CACHE.delete(cacheKey);
    return null;
  }
  return entry;
}

function setSelectorHealingCacheEntry(cacheKey = '', payload = {}) {
  if (!cacheKey) return;
  SELECTOR_HEALING_LLM_CACHE.set(cacheKey, { ts: Date.now(), ...payload });
}

function pushReplayAction(session, payload = {}) {
  session.replay = session.replay || { candidateCount: 0, appliedCount: 0, failureCount: 0, actions: [] };
  session.replay.actions.push({ at: new Date().toISOString(), ...payload });
  if (session.replay.actions.length > 80) {
    session.replay.actions.splice(0, session.replay.actions.length - 80);
  }
}

async function captureDomFailureContext(page) {
  try {
    return await page.evaluate(() => ({
      url: window.location.href,
      title: document.title || '',
      bodyPreview: String(document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
      htmlPreview: String(document.documentElement?.outerHTML || '').slice(0, 5000),
    }));
  } catch {
    return { url: '', title: '', bodyPreview: '', htmlPreview: '' };
  }
}

function pushSessionActionRecord(session, payload = {}) {
  const record = buildAttendedActionRecord(payload, session?.applicant || {});
  session.actionLog = Array.isArray(session.actionLog) ? session.actionLog : [];
  session.actionLog.push(record);
  if (session.actionLog.length > ATTENDED_ACTION_CAPTURE_LIMIT) {
    session.actionLog.splice(0, session.actionLog.length - ATTENDED_ACTION_CAPTURE_LIMIT);
  }
  pushDebugEnvelope(session, createDebugEventEnvelope(session, {
    type: 'observed-action',
    action: record.eventType || 'action',
    stage: session?.interactionStage || null,
    status: 'observed',
    candidate: {
      text: record.text || record.label || record.name || '',
      href: record.href || '',
      domFingerprint: record.domVersion || null,
    },
    metadata: {
      selectorCandidates: (record.selectorCandidates || []).slice(0, 4),
      valueBinding: record.valueBinding || null,
    },
  }));
  session.updatedAt = new Date().toISOString();
  session.updatedAtMs = Date.now();
  return record;
}

async function recordSessionDomFailure(session, reason = '', extra = {}) {
  const pageContext = session?.page ? await captureDomFailureContext(session.page) : {};
  const bucket = classifyErrorBucket(reason, extra);
  const entry = {
    reason: String(reason || '').trim() || 'dom-failure',
    bucket,
    at: new Date().toISOString(),
    url: pageContext?.url || session?.currentUrl || null,
    title: pageContext?.title || session?.pageTitle || null,
    bodyPreview: pageContext?.bodyPreview || '',
    htmlPreview: pageContext?.htmlPreview || '',
    ...extra,
  };
  session.domFailures = Array.isArray(session.domFailures) ? session.domFailures : [];
  session.domFailures.push(entry);
  if (session.domFailures.length > ATTENDED_DOM_FAILURE_LIMIT) {
    session.domFailures.splice(0, session.domFailures.length - ATTENDED_DOM_FAILURE_LIMIT);
  }
  incrementSessionErrorBucket(session, bucket);
  session.hitlRequired = true;
  session.hitlReason = entry.reason;
  session.updatedAt = new Date().toISOString();
  session.updatedAtMs = Date.now();
  await recordDebugTransition(session, session?.page, {
    type: 'failure',
    action: reason,
    stage: session?.interactionStage || null,
    status: 'failed',
    reason,
    errorBucket: bucket,
    metadata: { extra, url: entry.url },
  }).catch(() => {});
  return entry;
}

async function persistAttendedDomLearning(session) {
  const host = safeHostFromUrl(session?.currentUrl || session?.bookingUrl || '');
  if (!host) return null;
  const actionRecords = (Array.isArray(session?.actionLog) ? session.actionLog : []).slice(session.persistedActionCount || 0);
  const failures = (Array.isArray(session?.domFailures) ? session.domFailures : []).slice(session.persistedFailureCount || 0);
  if (!actionRecords.length && !failures.length) return null;
  let store = await readAttendedDomLearningStore();
  store = mergeAttendedSessionLearning(store, { host, actionRecords, failures });
  await writeAttendedDomLearningStore(store);
  session.persistedActionCount = (session.persistedActionCount || 0) + actionRecords.length;
  session.persistedFailureCount = (session.persistedFailureCount || 0) + failures.length;
  return { host, actionRecords: actionRecords.length, failures: failures.length };
}

async function installAttendedActionRecorder(page, session) {
  const bindingName = `__recordAttendedDomAction_${String(session?.token || '').replace(/[^a-zA-Z0-9_]/g, '')}`;
  await page.exposeFunction(bindingName, async (payload = {}) => {
    pushSessionActionRecord(session, payload);
  });
  await page.addInitScript((exposedBindingName) => {
    const normalize = (value = '') => String(value || '').replace(/\s+/g, ' ').trim();
    const cssEscape = (value = '') => String(value || '').replace(/([ #;?%&,.+*~':"!^$\[\]()=>|/\\@])/g, '\\$1');
    const textEscape = (value = '') => String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const seen = new Map();

    function isInterestingTarget(el) {
      if (!el || !(el instanceof Element)) return false;
      const tag = String(el.tagName || '').toLowerCase();
      return ['a', 'button', 'input', 'select', 'textarea'].includes(tag) || el.getAttribute('role') === 'button' || !!el.closest('form');
    }

    function buildCssDomPath(el) {
      const parts = [];
      let current = el;
      for (let depth = 0; current && depth < 6; depth += 1) {
        const tag = String(current.tagName || '').toLowerCase();
        if (!tag) break;
        const siblings = current.parentElement ? Array.from(current.parentElement.children).filter((child) => child.tagName === current.tagName) : [current];
        const index = siblings.indexOf(current);
        parts.unshift(`${tag}:nth-of-type(${Math.max(1, index + 1)})`);
        current = current.parentElement;
      }
      return parts.join(' > ');
    }

    function buildXPathDomPath(el) {
      const parts = [];
      let current = el;
      for (let depth = 0; current && depth < 8; depth += 1) {
        const tag = String(current.tagName || '').toLowerCase();
        if (!tag) break;
        const siblings = current.parentElement
          ? Array.from(current.parentElement.children).filter((child) => String(child.tagName || '').toLowerCase() === tag)
          : [current];
        const index = siblings.indexOf(current);
        parts.unshift(`${tag}[${Math.max(1, index + 1)}]`);
        current = current.parentElement;
      }
      return parts.length ? `/${parts.join('/')}` : '';
    }

    function buildSelectorCandidates(el) {
      const tag = String(el.tagName || '').toLowerCase();
      const selectors = [];
      const text = normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || el.value || '');
      if (el.id) selectors.push(`#${cssEscape(el.id)}`);
      if (el.getAttribute('name')) selectors.push(`${tag}[name="${String(el.getAttribute('name')).replace(/"/g, '\\"')}"]`);
      if (el.getAttribute('aria-label')) selectors.push(`${tag}[aria-label="${String(el.getAttribute('aria-label')).replace(/"/g, '\\"')}"]`);
      if (el.getAttribute('data-testid')) selectors.push(`${tag}[data-testid="${String(el.getAttribute('data-testid')).replace(/"/g, '\\"')}"]`);
      if (el.getAttribute('data-qa')) selectors.push(`${tag}[data-qa="${String(el.getAttribute('data-qa')).replace(/"/g, '\\"')}"]`);
      if (tag === 'a' && el.getAttribute('href')) selectors.push(`${tag}[href="${String(el.getAttribute('href')).replace(/"/g, '\\"')}"]`);
      if (tag === 'input' && el.getAttribute('type')) selectors.push(`${tag}[type="${String(el.getAttribute('type')).replace(/"/g, '\\"')}"]`);
      if (el.classList?.length) selectors.push(`${tag}.${Array.from(el.classList).slice(0, 2).map((item) => cssEscape(item)).join('.')}`);
      if (text && text.length < 40) {
        selectors.push(`${tag}:has-text("${textEscape(text)}")`);
        selectors.push(`${tag}:text-is("${textEscape(text)}")`);
      }
      const cssDomPath = buildCssDomPath(el);
      if (cssDomPath) selectors.push(cssDomPath);
      return Array.from(new Set(selectors.filter(Boolean))).slice(0, 10);
    }

    function describeTarget(el, eventType) {
      const tag = String(el.tagName || '').toLowerCase();
      const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      const container = el.closest('form, section, article, main, .content, .main-content, .form-group, .field') || el.parentElement;
      const text = normalize(el.innerText || el.textContent || el.getAttribute('value') || el.getAttribute('aria-label') || '');
      const value = tag === 'input' || tag === 'textarea' || tag === 'select' ? String(el.value ?? '') : '';
      return {
        eventType,
        pageUrl: window.location.href,
        pageTitle: document.title || '',
        tag,
        inputType: String(el.getAttribute('type') || '').toLowerCase(),
        type: String(el.getAttribute('type') || '').toLowerCase(),
        name: el.getAttribute('name') || '',
        label: normalize(label?.innerText || el.closest('label')?.innerText || ''),
        placeholder: normalize(el.getAttribute('placeholder') || ''),
        ariaLabel: normalize(el.getAttribute('aria-label') || ''),
        role: normalize(el.getAttribute('role') || ''),
        text,
        href: tag === 'a' ? (el.getAttribute('href') || el.href || '') : '',
        formAction: el.form?.action || el.closest('form')?.action || '',
        domPath: buildXPathDomPath(el),
        selectorCandidates: buildSelectorCandidates(el),
        containerText: normalize(container?.innerText || '').slice(0, 240),
        structuralSignature: normalize([tag, text, label?.innerText || '', container?.tagName || '', container?.className || ''].join(' | ')).slice(0, 240),
        value,
        critical: /submit|book|schedule|continue|next|verify|login|זימון|קבע|המשך|אישור|שלח/.test(`${eventType} ${text} ${el.getAttribute('name') || ''}`.toLowerCase()),
        recordedAt: new Date().toISOString(),
      };
    }

    function emit(payload) {
      const key = [payload.eventType, payload.domPath, payload.value || payload.text || ''].join('|');
      const lastSeenAt = seen.get(key) || 0;
      if (Date.now() - lastSeenAt < 350) return;
      seen.set(key, Date.now());
      Promise.resolve(window[exposedBindingName](payload)).catch(() => {});
    }

    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('a,button,[role="button"],input[type="submit"],input[type="button"]') : null;
      if (!isInterestingTarget(target)) return;
      emit(describeTarget(target, 'click'));
    }, true);

    document.addEventListener('change', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!isInterestingTarget(target)) return;
      emit(describeTarget(target, 'change'));
    }, true);

    document.addEventListener('submit', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!isInterestingTarget(target)) return;
      emit(describeTarget(target, 'submit'));
    }, true);
  }, bindingName);
}

async function tryReplayFillWithLocatorHints(page, record, value) {
  const hintTargets = [];
  if (record?.label) hintTargets.push({ locator: page.getByLabel(record.label, { exact: false }).first(), mode: 'locator-label', selector: `label:${record.label}` });
  if (record?.placeholder) hintTargets.push({ locator: page.getByPlaceholder(record.placeholder, { exact: false }).first(), mode: 'locator-placeholder', selector: `placeholder:${record.placeholder}` });
  if (record?.name) hintTargets.push({ locator: page.locator(`[name="${String(record.name).replace(/"/g, '\\"')}"]`).first(), mode: 'locator-name', selector: `[name="${record.name}"]` });
  if (record?.ariaLabel) hintTargets.push({ locator: page.locator(`[aria-label="${String(record.ariaLabel).replace(/"/g, '\\"')}"]`).first(), mode: 'locator-aria-label', selector: `[aria-label="${record.ariaLabel}"]` });
  for (const selector of buildDomPathSelectorVariants(record?.domPath)) {
    hintTargets.push({ locator: page.locator(selector).first(), mode: selector.startsWith('xpath=') ? 'locator-dom-path-xpath' : 'locator-dom-path', selector });
  }
  for (const candidate of hintTargets) {
    try {
      if (!await candidate.locator.count()) continue;
      const tagName = await candidate.locator.evaluate((el) => el.tagName.toLowerCase());
      if (tagName === 'select') {
        await candidate.locator.selectOption({ label: String(value) }).catch(async () => {
          await candidate.locator.selectOption({ value: String(value) }).catch(() => {});
        });
      } else {
        await candidate.locator.fill(String(value), { timeout: 3000 }).catch(() => {});
      }
      return { applied: true, selector: candidate.selector, mode: candidate.mode };
    } catch (error) {
      candidate.failureReason = error?.message || String(error);
    }
  }
  return { applied: false, selector: null, mode: 'locator-hints-failed', failureReason: hintTargets.map((candidate) => candidate.failureReason).filter(Boolean).slice(0, 3).join(' | ') || 'no-hint-match' };
}

async function tryReplayClickWithLocatorHints(page, record) {
  const nameHint = record?.text || record?.label || record?.ariaLabel || null;
  const hintTargets = [];
  if (record?.role && nameHint) {
    hintTargets.push({ locator: page.getByRole(record.role, { name: nameHint, exact: false }).first(), mode: 'locator-role', selector: `${record.role}:${nameHint}` });
  }
  if (record?.label) hintTargets.push({ locator: page.getByLabel(record.label, { exact: false }).first(), mode: 'locator-label-click', selector: `label:${record.label}` });
  if (nameHint) hintTargets.push({ locator: page.getByText(nameHint, { exact: false }).first(), mode: 'locator-text', selector: `text:${nameHint}` });
  if (nameHint) {
    for (const selector of buildReplayTextSelectors(nameHint)) {
      hintTargets.push({ locator: page.locator(selector).first(), mode: 'locator-text-selector', selector });
    }
  }
  for (const selector of buildDomPathSelectorVariants(record?.domPath)) {
    hintTargets.push({ locator: page.locator(selector).first(), mode: selector.startsWith('xpath=') ? 'locator-dom-path-xpath' : 'locator-dom-path', selector });
  }
  for (const candidate of hintTargets) {
    try {
      if (!await candidate.locator.count()) continue;
      await candidate.locator.click({ timeout: 1000 });
      return { clicked: true, selector: candidate.selector, mode: candidate.mode };
    } catch (error) {
      candidate.failureReason = error?.message || String(error);
    }
  }
  return { clicked: false, selector: null, mode: 'locator-hints-failed', failureReason: hintTargets.map((candidate) => candidate.failureReason).filter(Boolean).slice(0, 3).join(' | ') || 'no-hint-match' };
}

async function runReplayDrivenPrefill(page, session, model, applicant = {}) {
  const host = safeHostFromUrl(model?.href || session?.bookingUrl || '');
  if (!host) return { filled: [], failures: [], candidateCount: 0 };
  const store = await readAttendedDomLearningStore();
  const pageContext = buildPageReplayContext(model);
  const candidates = listLearnedActionsForHost(store, host, { eventType: 'change', limit: 30 })
    .filter((record) => record?.valueBinding)
    .map((record) => ({ ...record, replayScore: scoreReplayRecordForPage(record, pageContext) }))
    .filter((record) => record.replayScore >= 18)
    .sort((left, right) => right.replayScore - left.replayScore);

  const filled = [];
  const failures = [];
  for (const record of candidates) {
    const value = resolveApplicantBindingValue(record.valueBinding, applicant);
    if (value == null || value === '') continue;
    let applied = false;
    let appliedSelector = null;
    let appliedMode = null;
    let failureReason = null;
    const replaySelectors = record.prioritizedSelectorCandidates || record.selectorCandidates || [];
    for (const selector of replaySelectors) {
      try {
        const locator = page.locator(selector).first();
        if (!await locator.count()) continue;
        const tagName = await locator.evaluate((el) => el.tagName.toLowerCase());
        if (tagName === 'select') {
          await locator.selectOption({ label: String(value) }).catch(async () => {
            await locator.selectOption({ value: String(value) }).catch(() => {});
          });
        } else {
          await locator.fill(String(value), { timeout: 3000 }).catch(() => {});
        }
        applied = true;
        appliedSelector = selector;
        appliedMode = 'provided-selector';
        break;
      } catch (error) {
        failureReason = error?.message || String(error);
      }
    }

    if (!applied) {
      const hintReplay = await tryReplayFillWithLocatorHints(page, record, value);
      applied = Boolean(hintReplay?.applied);
      appliedSelector = hintReplay?.selector || appliedSelector;
      appliedMode = hintReplay?.mode || appliedMode;
      failureReason = hintReplay?.failureReason || failureReason;
    }

    if (!applied) {
      const fields = (model?.forms || []).flatMap((form) => form.fields || []);
      const scoredFields = fields
        .map((field) => ({ field, score: scoreFieldForRecordedInput(field, record) }))
        .sort((left, right) => right.score - left.score);
      const fieldThreshold = computeDynamicFieldThreshold(scoredFields);
      const bestField = scoredFields[0] || null;
      const bestConfidence = computeNormalizedConfidence(bestField?.score || 0, fieldThreshold.maxScore || 0);
      if (bestField && bestField.score >= fieldThreshold.absolute && bestConfidence >= fieldThreshold.confidence) {
        const selectorCandidates = [];
        if (bestField.field?.id) selectorCandidates.push(`#${cssEscapeIdentifier(bestField.field.id)}`);
        if (bestField.field?.name) selectorCandidates.push(`[name="${String(bestField.field.name).replace(/"/g, '\\"')}"]`);
        if (record?.domPath) selectorCandidates.push(record.domPath);
        selectorCandidates.push(...buildDomPathSelectorVariants(record?.domPath));
        for (const selector of selectorCandidates) {
          try {
            const locator = page.locator(selector).first();
            if (!await locator.count()) continue;
            await locator.fill(String(value), { timeout: 3000 }).catch(() => {});
            applied = true;
            appliedSelector = selector;
            appliedMode = 'field-score-fallback';
            break;
          } catch (error) {
            failureReason = error?.message || String(error);
          }
        }
      } else if (bestField) {
        failureReason = `field-threshold-miss score=${Number(bestField.score || 0).toFixed(2)} confidence=${bestConfidence.toFixed(3)}`;
      }
    }

    if (applied) {
      filled.push({ binding: record.valueBinding, label: record.label || record.name || record.placeholder || null });
      store && Object.assign(store, markReplayResult(store, { host, record, ok: true, selector: appliedSelector, mode: appliedMode }));
    } else {
      failures.push({ record, selector: appliedSelector, mode: appliedMode, failureReason: failureReason || 'prefill-not-applied' });
      pushReplayAction(session, {
        action: record.text || record.label || record.name || record.eventType,
        mode: appliedMode || 'prefill-failed',
        selector: appliedSelector || null,
        ok: false,
        reason: failureReason || 'prefill-not-applied',
      });
      store && Object.assign(store, markReplayResult(store, { host, record, ok: false, selector: appliedSelector, mode: appliedMode, failureReason: failureReason || 'prefill-not-applied' }));
    }
  }

  if (filled.length > 0 || failures.length > 0) {
    await writeAttendedDomLearningStore(store);
  }
  return { filled, failures, candidateCount: candidates.length };
}

async function runLearnedDomReplay(page, session, model, { reason = '' } = {}) {
  const host = safeHostFromUrl(model?.href || session?.bookingUrl || '');
  if (!host) return { applied: [], failures: [], candidateCount: 0 };
  const store = await readAttendedDomLearningStore();
  const pageContext = buildPageReplayContext(model);
  const candidates = listLearnedActionsForHost(store, host, { eventType: 'click', limit: 20 })
    .map((record) => ({ ...record, replayScore: scoreReplayRecordForPage(record, pageContext) }))
    .filter((record) => record.replayScore >= 22)
    .sort((left, right) => right.replayScore - left.replayScore)
    .slice(0, 4);

  if (session?.debugOptions?.replaySimulatorMode) {
    ensureSessionDebugState(session);
    session.debug.replaySimulator.lastRun = {
      at: new Date().toISOString(),
      host,
      reason: reason || 'replay-simulator',
      pagePath: pageContext.pagePath || '',
      candidates: candidates.map((record) => ({
        text: record.text || record.label || record.name || '',
        selector: record.prioritizedSelectorCandidates?.[0] || record.selectorCandidates?.[0] || null,
        replayScore: Number(record.replayScore || 0),
        successRate: Number(record.successRate || 0),
        replayConfidence: Number(record.replayConfidence || 0),
        explanation: explainDecision({
          textMatch: Boolean(record.text && pageContext.pageTerms.some((term) => String(record.text).toLowerCase().includes(term))),
          hrefMatch: String(record.pagePath || '').toLowerCase() === String(pageContext.pagePath || '').toLowerCase(),
          intentBoost: Boolean(reason),
          replayScore: record.replayScore,
          successRate: record.successRate,
          domFingerprint: record.domVersion || null,
        }),
      })),
    };
    pushVisualDebugEntry(session, {
      kind: 'replay-simulator',
      host,
      reason: reason || 'replay-simulator',
      candidates: session.debug.replaySimulator.lastRun.candidates.slice(0, 6),
    });
  }

  const applied = [];
  const failures = [];
  let stopReason = 'exhausted-candidates';
  for (const record of candidates) {
    const beforeSnapshot = await captureDebugSnapshot(page, session, { label: `replay:${record.text || record.label || record.name || 'candidate'}:before` }).catch(() => null);
    const replay = await trySelectorHealWithLLMFallback(page, {
      intent: record.text || record.label || reason || 'replay learned attended action',
      selectors: record.prioritizedSelectorCandidates || record.selectorCandidates || [],
      host,
      record,
      timeoutPerSelectorMs: 1000,
    });
    let finalReplay = replay;
    if (!finalReplay?.clicked) {
      const hintReplay = await tryReplayClickWithLocatorHints(page, record);
      if (hintReplay?.clicked) finalReplay = hintReplay;
    }
    if (finalReplay?.clicked) {
      applied.push({ record, replay: finalReplay });
      Object.assign(store, markReplayResult(store, { host, record, ok: true, selector: finalReplay.selector, mode: finalReplay.mode }));
      pushReplayAction(session, {
        action: record.text || record.label || record.name || record.eventType,
        mode: finalReplay.mode,
        selector: finalReplay.selector || null,
        ok: true,
      });
      session.replay.appliedCount = Number(session.replay.appliedCount || 0) + 1;
      await waitForPageDomStable(page, 900);
      const nextModel = await snapshotFormModel(page).catch(() => null);
      await recordDebugTransition(session, page, {
        type: 'replay-action',
        action: record.text || record.label || record.name || 'replay-click',
        stage: session?.interactionStage || null,
        status: 'applied',
        candidate: { ...record, score: record.replayScore },
        beforeSnapshot,
        metadata: { selector: finalReplay.selector || null, mode: finalReplay.mode || null },
      }).catch(() => {});
      if (page.url() !== String(model?.href || page.url())) {
        stopReason = 'navigation-detected';
        break;
      }
      if (nextModel && !isLikelyNonBookingFormModel(nextModel) && (nextModel?.forms?.length || 0) > 0) {
        stopReason = 'success-condition-met';
        break;
      }
      if (applied.length >= 3) {
        stopReason = 'chain-limit-reached';
        break;
      }
      continue;
    }
    failures.push({ record, replay: finalReplay });
    pushReplayAction(session, {
      action: record.text || record.label || record.name || record.eventType,
      mode: finalReplay?.mode || 'replay-failed',
      selector: finalReplay?.selector || null,
      ok: false,
      reason: finalReplay?.llmHealing?.reason || finalReplay?.failureReason || finalReplay?.mode || 'replay-failed',
    });
    await recordDebugTransition(session, page, {
      type: 'replay-action',
      action: record.text || record.label || record.name || 'replay-click',
      stage: session?.interactionStage || null,
      status: 'failed',
      candidate: { ...record, score: record.replayScore },
      beforeSnapshot,
      reason: finalReplay?.llmHealing?.reason || finalReplay?.failureReason || finalReplay?.mode || 'replay-failed',
      errorBucket: classifyErrorBucket(finalReplay?.failureReason || finalReplay?.mode || 'replay-failed', finalReplay || {}),
      metadata: { selector: finalReplay?.selector || null, mode: finalReplay?.mode || null },
    }).catch(() => {});
    Object.assign(store, markReplayResult(store, { host, record, ok: false, selector: finalReplay?.selector, mode: finalReplay?.mode, failureReason: finalReplay?.llmHealing?.reason || finalReplay?.mode || 'replay-failed' }));
  }

  if (failures.length > 0 && applied.length === 0) {
    await recordSessionDomFailure(session, 'learned-dom-replay-exhausted', {
      replayCandidateCount: candidates.length,
      replayFailureModes: Array.from(new Set(failures.map((item) => item?.replay?.failureReason || item?.replay?.llmHealing?.reason || item?.replay?.mode || 'replay-failed'))).slice(0, 8),
    }).catch(() => {});
  }

  if (applied.length || failures.length) {
    await writeAttendedDomLearningStore(store);
  }
  return { applied, failures, candidateCount: candidates.length, stopReason };
}

async function cleanupExpiredSessions() {
  const now = Date.now();
  const entries = Array.from(attendedSessions.values());
  for (const s of entries) {
    const age = now - (s.updatedAtMs || s.createdAtMs || now);
    if (age <= ATTENDED_SESSION_TTL_MS) continue;
    try {
      await s.context?.close();
    } catch {
    }
    attendedSessions.delete(s.token);
  }
}

function pickPreferredOtpCode(applicant = {}) {
  const otpPolicy = String(applicant?.otpPolicy || process.env.BOOKING_OTP_POLICY || '').trim().toLowerCase();
  const totpSecret = String(applicant?.totpSecret || process.env.BOOKING_TOTP_SECRET || '').trim();
  if ((otpPolicy === 'totp' || totpSecret) && totpSecret) {
    const generated = generateTotpCode(totpSecret, Number(process.env.BOOKING_TOTP_STEP_SECONDS || 30), Number(process.env.BOOKING_TOTP_DIGITS || 6));
    if (generated) return generated;
  }

  const direct = String(applicant?.otpCode || process.env.BOOKING_OTP_CODE || '').trim();
  if (!direct) return '';
  const compact = direct.replace(/\s+/g, '');
  const digits = compact.replace(/\D+/g, '');
  return digits.length >= 4 ? digits : compact;
}

async function tryAutoLoginStep(session) {
  const page = session?.page;
  const applicant = session?.applicant || {};
  if (!page) return { acted: false, reason: 'missing-page' };
  const beforeSnapshot = await captureDebugSnapshot(page, session, { label: 'login:before' }).catch(() => null);

  const username = String(
    applicant?.loginUsername
      || applicant?.email
      || applicant?.idNumber
      || applicant?.phone
      || ''
  ).trim();
  const password = String(applicant?.loginPassword || applicant?.password || '').trim();

  if (!username || !password) {
    return { acted: false, reason: 'missing-login-credentials' };
  }

  const result = await page.evaluate(async ({ u, p }) => {
    function qsa(sel, root = document) {
      return Array.from(root.querySelectorAll(sel));
    }
    function isVisible(el) {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      if (!style || style.visibility === 'hidden' || style.display === 'none') return false;
      if (Number(style.opacity || '1') === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    function isEditable(el) {
      return !el.disabled && !el.readOnly;
    }
    function textBag(el) {
      return [
        el.id || '',
        el.name || '',
        el.placeholder || '',
        el.getAttribute('aria-label') || '',
        el.getAttribute('autocomplete') || '',
        el.type || '',
        el.closest('label')?.innerText || '',
      ].join(' ').toLowerCase();
    }
    function scoreUserInput(el) {
      const bag = textBag(el);
      const type = String(el.type || '').toLowerCase();
      let score = 0;
      if (/email|mail/.test(bag)) score += 8;
      if (/user|login|identifier|identity|id|tz|תעודת|זהות|כניסה|הזדהות/.test(bag)) score += 7;
      if (/phone|mobile|טלפון|נייד/.test(bag)) score += 5;
      if (/username|current-user/.test(el.getAttribute('autocomplete') || '')) score += 6;
      if (type === 'email') score += 5;
      if (type === 'text') score += 2;
      if (isVisible(el)) score += 4;
      if (isEditable(el)) score += 2;
      return score;
    }
    function scorePasswordInput(el) {
      const bag = textBag(el);
      let score = 0;
      if ((el.type || '').toLowerCase() === 'password') score += 12;
      if (/password|pass|סיסמה/.test(bag)) score += 8;
      if (isVisible(el)) score += 4;
      if (isEditable(el)) score += 2;
      return score;
    }
    function groupRoot(el) {
      return el.closest('form, fieldset, [role="form"], [data-testid*="login" i], [class*="login" i], [class*="auth" i]') || el.parentElement || document.body;
    }
    function isAbove(first, second) {
      return first.getBoundingClientRect().top <= second.getBoundingClientRect().top + 6;
    }
    function verticalGap(first, second) {
      return Math.abs(first.getBoundingClientRect().top - second.getBoundingClientRect().top);
    }
    function fillInput(el, value) {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function clickLoginButton(root) {
      const all = qsa('button, input[type="submit"], input[type="button"]', root || document)
        .filter((el) => isVisible(el) && !el.disabled);
      const re = /log\s*in|sign\s*in|authenticate|continue|next|התחבר|כניסה|הזדהות|אישור/i;
      for (const el of all) {
        const txt = String(el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
        if (re.test(txt)) {
          el.click();
          return true;
        }
      }
      return false;
    }

    const inputs = qsa('input:not([type="hidden"]), textarea')
      .filter((el) => isVisible(el) && isEditable(el));
    const userCandidates = inputs
      .filter((el) => {
        const t = String(el.type || '').toLowerCase();
        return ['text', 'email', 'tel', 'number', 'search', ''].includes(t) || el.tagName.toLowerCase() === 'textarea';
      })
      .map((el) => ({ el, score: scoreUserInput(el) }))
      .sort((a, b) => b.score - a.score);
    const passCandidates = inputs
      .filter((el) => String(el.type || '').toLowerCase() === 'password' || /password|pass|סיסמה/i.test(`${el.id || ''} ${el.name || ''} ${el.placeholder || ''}`))
      .map((el) => ({ el, score: scorePasswordInput(el) }))
      .sort((a, b) => b.score - a.score);

    let bestPair = null;
    for (const pass of passCandidates.slice(0, 5)) {
      const passRoot = groupRoot(pass.el);
      for (const user of userCandidates.slice(0, 10)) {
        if (user.el === pass.el) continue;
        const sameRoot = groupRoot(user.el) === passRoot;
        const pairScore = pass.score + user.score
          + (sameRoot ? 8 : 0)
          + (isAbove(user.el, pass.el) ? 5 : -6)
          - Math.min(12, verticalGap(user.el, pass.el) / 40);
        if (!bestPair || pairScore > bestPair.score) {
          bestPair = { user: user.el, pass: pass.el, score: pairScore, root: passRoot, sameRoot };
        }
      }
    }

    if (!bestPair || bestPair.score < 18) {
      return { usedUser: false, usedPass: false, clicked: false, reason: 'login-pair-not-found' };
    }

    fillInput(bestPair.user, u);
    fillInput(bestPair.pass, p);
    const clicked = clickLoginButton(bestPair.root) || clickLoginButton(document);
    return { usedUser: true, usedPass: true, clicked, pairScore: bestPair.score, sameRoot: bestPair.sameRoot };
  }, { u: username, p: password });

  if (result?.usedUser && result?.usedPass) {
    session.interactionStage = BOOKING_INTERACTION_STAGES.LOGIN;
    session.notes.push(`Auto-login attempted${result.clicked ? ' and submit clicked' : ''}.`);
    session.updatedAt = new Date().toISOString();
    session.updatedAtMs = Date.now();
    await recordDebugTransition(session, page, {
      type: 'login',
      action: 'auto-login',
      stage: BOOKING_INTERACTION_STAGES.LOGIN,
      status: 'applied',
      beforeSnapshot,
      metadata: { clicked: Boolean(result.clicked), pairScore: result.pairScore || null },
    }).catch(() => {});
    return { acted: true, reason: 'auto-login-attempted' };
  }

  await recordDebugTransition(session, page, {
    type: 'login',
    action: 'auto-login',
    stage: BOOKING_INTERACTION_STAGES.LOGIN,
    status: 'failed',
    beforeSnapshot,
    reason: result?.reason || 'login-fields-not-found',
    errorBucket: classifyErrorBucket(result?.reason || 'login-fields-not-found'),
  }).catch(() => {});
  return { acted: false, reason: result?.reason || 'login-fields-not-found' };
}

async function tryAutoOtpStep(session) {
  const page = session?.page;
  if (!page) return { acted: false, reason: 'missing-page' };
  const beforeSnapshot = await captureDebugSnapshot(page, session, { label: 'otp:before' }).catch(() => null);

  const code = pickPreferredOtpCode(session?.applicant || {});
  if (!code) {
    return { acted: false, reason: 'missing-otp-code' };
  }

  const result = await page.evaluate(({ otp }) => {
    function qsa(sel, root = document) {
      return Array.from(root.querySelectorAll(sel));
    }
    function isVisible(el) {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      if (!style || style.visibility === 'hidden' || style.display === 'none') return false;
      if (Number(style.opacity || '1') === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    function isEditable(el) {
      return !el.disabled && !el.readOnly;
    }
    function textBag(el) {
      return [
        el.id || '',
        el.name || '',
        el.placeholder || '',
        el.getAttribute('aria-label') || '',
        el.getAttribute('autocomplete') || '',
        el.getAttribute('inputmode') || '',
        el.type || '',
        el.closest('label')?.innerText || '',
      ].join(' ').toLowerCase();
    }
    function scoreOtpInput(el) {
      const bag = textBag(el);
      let score = 0;
      if (/otp|verification|verify|code|token|sms|2fa|auth|אימות|קוד/.test(bag)) score += 10;
      if ((el.type || '').toLowerCase() === 'number') score += 4;
      if ((el.type || '').toLowerCase() === 'tel') score += 3;
      if ((el.getAttribute('autocomplete') || '').toLowerCase() === 'one-time-code') score += 10;
      if ((el.getAttribute('inputmode') || '').toLowerCase() === 'numeric') score += 5;
      if (String(el.maxLength || '') === '1') score += 7;
      if (isVisible(el)) score += 4;
      if (isEditable(el)) score += 2;
      return score;
    }
    function groupRoot(el) {
      return el.closest('form, fieldset, [role="form"], [data-testid*="otp" i], [class*="otp" i], [class*="verify" i], [class*="auth" i]') || el.parentElement || document.body;
    }
    function fillInput(el, value) {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function clickVerifyButton(root) {
      const all = qsa('button, input[type="submit"], input[type="button"]', root || document)
        .filter((el) => isVisible(el) && !el.disabled);
      const re = /verify|confirm|continue|next|submit|אימות|אשר|המשך|שלח|שליחה/i;
      for (const el of all) {
        const txt = String(el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
        if (re.test(txt)) {
          el.click();
          return true;
        }
      }
      return false;
    }

    const candidates = qsa('input:not([type="hidden"]), textarea')
      .filter((el) => isVisible(el) && isEditable(el))
      .map((el) => ({ el, score: scoreOtpInput(el) }))
      .sort((a, b) => b.score - a.score);

    if (!candidates[0]?.el || candidates[0].score <= 0) {
      return { filled: false, clicked: false, reason: 'otp-input-not-found' };
    }

    const primary = candidates[0].el;
    const root = groupRoot(primary);
    const rootCandidates = candidates
      .filter((candidate) => groupRoot(candidate.el) === root)
      .map((candidate) => candidate.el);
    const digitInputs = rootCandidates.filter((el) => {
      const maxLength = Number(el.maxLength || 0);
      return maxLength === 1 || /digit|otp|code|token|sms|2fa|auth|אימות|קוד/.test(textBag(el));
    });
    const otpChars = String(otp || '').split('');
    let filled = false;
    let mode = 'single-input';

    if (digitInputs.length >= Math.min(4, otpChars.length)) {
      digitInputs
        .slice(0, otpChars.length)
        .sort((left, right) => {
          const leftRect = left.getBoundingClientRect();
          const rightRect = right.getBoundingClientRect();
          if (Math.abs(leftRect.top - rightRect.top) > 8) return leftRect.top - rightRect.top;
          return leftRect.left - rightRect.left;
        })
        .forEach((el, index) => fillInput(el, otpChars[index] || ''));
      filled = true;
      mode = 'multi-input';
    } else {
      fillInput(primary, otp);
      filled = true;
    }

    const clicked = filled ? (clickVerifyButton(root) || clickVerifyButton(document)) : false;
    return { filled, clicked, mode };
  }, { otp: code });

  if (result?.filled) {
    session.interactionStage = BOOKING_INTERACTION_STAGES.OTP;
    session.notes.push(`Auto-OTP attempted${result.mode === 'multi-input' ? ' with multi-input fill' : ''}${result.clicked ? ' and verify clicked' : ''}.`);
    session.updatedAt = new Date().toISOString();
    session.updatedAtMs = Date.now();
    await recordDebugTransition(session, page, {
      type: 'otp',
      action: 'auto-otp',
      stage: BOOKING_INTERACTION_STAGES.OTP,
      status: 'applied',
      beforeSnapshot,
      metadata: { mode: result.mode || 'single-input', clicked: Boolean(result.clicked) },
    }).catch(() => {});
    return { acted: true, reason: 'auto-otp-attempted' };
  }

  await recordDebugTransition(session, page, {
    type: 'otp',
    action: 'auto-otp',
    stage: BOOKING_INTERACTION_STAGES.OTP,
    status: 'failed',
    beforeSnapshot,
    reason: result?.reason || 'otp-field-not-found',
    errorBucket: classifyErrorBucket(result?.reason || 'otp-field-not-found'),
  }).catch(() => {});
  return { acted: false, reason: result?.reason || 'otp-field-not-found' };
}

function isLikelyNonBookingFormModel(model) {
  const bestScore = Math.max(...((Array.isArray(model?.forms) ? model.forms : []).map((form) => Number(form.intentScore || 0))), Number(model?.bestFormScore || 0), -Infinity);
  return !Number.isFinite(bestScore) || bestScore < 12;
}

function modelHasBookingSignals(model = {}) {
  const blob = normalizeText([
    model?.title,
    model?.href,
    model?.pageText,
    ...(Array.isArray(model?.forms) ? model.forms.map((form) => [
      form?.id,
      form?.name,
      form?.action,
      ...(Array.isArray(form?.fields) ? form.fields.map((field) => [field?.id, field?.name, field?.label, field?.placeholder, field?.type].join(' ')) : []),
      ...(Array.isArray(form?.submitButtons) ? form.submitButtons.map((button) => [button?.id, button?.name, button?.text].join(' ')) : []),
    ].join(' ')) : []),
  ].join(' ')).toLowerCase();
  return /appointment|book|booking|schedule|reserve|slot|calendar|serviceform|schedule=|customertype=|queue|visit|תור|זימון|קביעת|לקבוע/.test(blob);
}

function modelHasConflictingNonBookingSignals(model = {}) {
  const blob = normalizeText([
    model?.title,
    model?.href,
    model?.pageText,
  ].join(' ')).toLowerCase();
  return /pharmacy|pharmacies|healthandsocial|בתי מרקחת|בית מרקחת|מרקחת תורנים/.test(blob);
}

function guardReadyToSubmitState(session, model, reason = 'non-booking-page') {
  if (session?.state !== CHECKPOINT_STATES.READY_TO_SUBMIT) return;
  const lacksBookingSignals = !modelHasBookingSignals(model);
  const hasConflictingSignals = modelHasConflictingNonBookingSignals(model);
  if (!lacksBookingSignals && !hasConflictingSignals) return;
  session.state = CHECKPOINT_STATES.AWAITING_HUMAN;
  session.hitlRequired = true;
  session.hitlReason = reason;
  session.notes.push(`HITL required: ready-to-submit guard blocked non-booking page (${reason}).`);
}

function updateSessionFlowPhase(session, model, noteReason = '') {
  const nextFlowPhase = inferBookingFlowPhase(model);
  const previousPhase = String(session?.flowPhase?.phaseKey || '').toLowerCase();
  session.flowPhase = nextFlowPhase;
  session.formRequirements = extractFormRequirements(model);
  if (nextFlowPhase.phaseKey !== BOOKING_FLOW_PHASES.UNKNOWN && nextFlowPhase.phaseKey !== previousPhase) {
    const suffix = nextFlowPhase.stepNumber ? ` (${nextFlowPhase.stepNumber}/${nextFlowPhase.totalSteps || 3})` : '';
    session.notes.push(`Detected booking flow phase: ${nextFlowPhase.phaseLabel}${suffix}${noteReason ? ` during ${noteReason}` : ''}.`);
  }
}

function inferCanonicalFieldKey(field = {}) {
  const blob = fieldSearchBlob(field);
  if (/first name|given name|forename|fname|שם פרטי/.test(blob)) return 'firstName';
  if (/last name|surname|family name|lname|שם משפחה/.test(blob)) return 'lastName';
  if (/username|user name|login name|שם משתמש/.test(blob)) return 'username';
  if (/full name|שם מלא/.test(blob)) return 'fullName';
  if (/id number|id no|identity|teudat|תעודת זהות|מספר זהות|tz/.test(blob)) return 'idNumber';
  if (/phone|mobile|telephone|טלפון|נייד/.test(blob)) return 'phone';
  if (/email|e-mail|דוא"ל|מייל/.test(blob)) return 'email';
  if (/address|residence|כתובת/.test(blob)) return 'address';
  if (/city|town|יישוב|עיר/.test(blob)) return 'city';
  if (/street|road|st\.|רחוב/.test(blob)) return 'street';
  if (/house|home number|building|מספר בית/.test(blob)) return 'houseNumber';
  if (/apartment|apt|דירה/.test(blob)) return 'apartment';
  if (/zip|postal|מיקוד/.test(blob)) return 'zipCode';
  if (/note|details|description|הערות|פירוט/.test(blob)) return 'notes';
  return null;
}

function extractFormRequirements(model = {}) {
  const forms = Array.isArray(model?.forms) ? model.forms : [];
  const ranked = [...forms]
    .map((form) => ({
      ...form,
      intentScore: Number(form?.intentScore || scoreBookingFormCandidate(form, model?.pageText || '')),
    }))
    .sort((left, right) => (right.intentScore || 0) - (left.intentScore || 0));

  const top = ranked[0]?.intentScore || 0;
  const candidateForms = ranked.filter((form) => (form.intentScore || 0) >= Math.max(8, top - 6));
  const fields = candidateForms
    .flatMap((form) => Array.isArray(form?.fields) ? form.fields : [])
    .filter((field) => {
      const tag = String(field?.tag || '').toLowerCase();
      const type = String(field?.type || '').toLowerCase();
      if (!['input', 'select', 'textarea'].includes(tag)) return false;
      if (['hidden', 'button', 'submit', 'reset'].includes(type)) return false;
      return true;
    });

  const seen = new Set();
  const requirements = [];
  for (const field of fields) {
    const key = `${String(field?.name || '').toLowerCase()}|${String(field?.id || '').toLowerCase()}|${String(field?.label || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requirements.push({
      key: inferCanonicalFieldKey(field),
      label: normalizeText(field?.label || field?.placeholder || field?.name || field?.id || ''),
      name: String(field?.name || ''),
      id: String(field?.id || ''),
      type: String(field?.type || ''),
      required: Boolean(field?.required),
    });
  }
  return requirements.slice(0, 30);
}

export function scoreBookingFormCandidate(form = {}, pageText = '') {
  const fieldBlob = normalizeText([
    form.id,
    form.name,
    form.action,
    form.method,
    ...(Array.isArray(form.fields) ? form.fields.map((field) => [field.id, field.name, field.placeholder, field.ariaLabel, field.label, field.type].join(' ')) : []),
    ...(Array.isArray(form.submitButtons) ? form.submitButtons.map((button) => [button.id, button.name, button.text, button.type].join(' ')) : []),
  ].join(' ')).toLowerCase();
  const pageBlob = normalizeText(pageText || '').toLowerCase();

  let score = 0;
  if (/appointment|book|schedule|reserve|זימון|תור|קבע/.test(fieldBlob)) score += 18;
  if (/appointment|book|schedule|reserve|זימון|תור|קבע/.test(pageBlob)) score += 10;
  if (/captcha|otp|sms|אימות/.test(fieldBlob)) score += 6;
  if (/schedule=1|departmentid=|select-date=/.test(String(form.action || '').toLowerCase())) score += 16;

  const fieldHits = [
    /full name|שם מלא/,
    /phone|mobile|טלפון|נייד/,
    /email|דוא"ל|מייל/,
    /id number|תעודת זהות|tz/,
  ].reduce((sum, pattern) => sum + (pattern.test(fieldBlob) ? 1 : 0), 0);
  score += fieldHits * 8;

  const submitHits = [
    /submit|book|schedule|continue|verify|שלח|זימון|קבע|אישור/,
  ].some((pattern) => pattern.test(fieldBlob));
  if (submitHits) score += 8;

  const feedbackSignals = /feedback|did this page help|helpful|עמוד זה עזר|נשמח אם תפרט|שתף את העמוד/.test(fieldBlob) || /feedback_yes|feedback_no|feedback_description/.test(fieldBlob);
  if (feedbackSignals) score -= 40;

  const feedbackOnlyFields = /name/.test(fieldBlob) && /email/.test(fieldBlob) && /phone/.test(fieldBlob) && /description/.test(fieldBlob) && /feedback/.test(fieldBlob);
  if (feedbackOnlyFields) score -= 25;

  return score;
}

export function scoreTelAvivFlowActionCandidate(action = {}, { intentText = '', mode = 'booking' } = {}) {
  const blob = normalizeText([
    action.text,
    action.href,
    action.onclick,
    action.id,
    action.name,
    action.className,
    action.ariaLabel,
    action.title,
  ].join(' ')).toLowerCase();
  const href = String(action.href || '').toLowerCase();
  const intent = normalizeText(intentText).toLowerCase();
  const isPaymentMode = String(mode || 'booking').toLowerCase() === 'payment';
  let score = 0;

  if (!blob) return -100;
  if (/feedback|helpful|עמוד זה עזר|צור קשר|whatsapp|facebook|instagram|tiktok|telegram|chat/.test(blob)) score -= 50;
  if (/menu|תפריט|search|חיפוש|language|שפות|accessibility|נגישות|privacy|פרטיות/.test(blob)) score -= 20;

  if (/client_\d+|client_type|getcustomertype/.test(blob)) score += 28;
  if (/service_\d+|service_type|getservicetype|getservicelist|getservice/.test(blob)) score += 26;
  if (/subject|topic|channel|continue|next|המשך|הבא|בחרו|בחירה/.test(blob)) score += 12;

  if (/appointment|queue|reservation|book|schedule|זימון|תור|קבע/.test(blob)) score += isPaymentMode ? 2 : 20;
  if (/payment|pay|invoice|bill|fine|arnona|ארנונה|תשלום|חשבונית|דוח/.test(blob)) score += isPaymentMode ? 26 : 12;
  if (/לקוח פרטי|פרטי|private/.test(blob)) score += intent.includes('business') || intent.includes('עסקי') ? 2 : 18;
  if (/לקוח עסקי|עסקי|business/.test(blob)) score += intent.includes('business') || intent.includes('עסקי') ? 18 : 4;
  if (/arnonaswitching|חילופי מחזיקים/.test(blob)) score += 22;
  if (/tlvqueuereservation|default\.aspx/.test(blob)) score += isPaymentMode ? 0 : 16;
  if (/mydigitel|דיגיתל/.test(blob)) score += isPaymentMode ? 4 : 10;
  if (/cancel|ביטול|שינוי תור/.test(blob)) score += intent.includes('cancel') || intent.includes('change') ? 10 : -12;

  if (href.includes('/residents/arnona/pages/arnonaswitching.aspx')) score += 34;
  if (href.includes('/about/pages/payments.aspx')) score += isPaymentMode ? 30 : -10;
  if (href.includes('www5.tel-aviv.gov.il/tlvforms/tlvqueuereservation')) score += isPaymentMode ? -6 : 28;
  if (href.includes('javascript:void(0)')) score += 8;
  if (/credit|visa|mastercard|cvv|card number|כרטיס אשראי|מספר כרטיס|תוקף|cvv/.test(blob)) score += isPaymentMode ? 18 : -8;

  if (!isPaymentMode && intent) {
    if (/arnona|ארנונה|property tax/.test(intent) && /arnona|ארנונה|property tax|חילופי מחזיקים/.test(blob)) score += 24;
    if (/appointment|book|schedule|queue|זימון|תור|קבע/.test(intent) && /appointment|book|schedule|queue|זימון|תור|קבע/.test(blob)) score += 16;
  }
  if (isPaymentMode && intent) {
    if (/pay|payment|arnona|fine|invoice|תשלום|ארנונה|דוח/.test(intent) && /pay|payment|arnona|fine|invoice|תשלום|ארנונה|דוח/.test(blob)) score += 18;
  }

  return score;
}

export function scoreTelAvivPaymentTableCandidate(candidate = {}, { intentText = '' } = {}) {
  const baseScore = scoreTelAvivFlowActionCandidate(candidate, { intentText, mode: 'payment' });
  const intent = normalizeText(intentText).toLowerCase();
  const rowBlob = normalizeText([
    candidate.rowText,
    candidate.sectionText,
    candidate.columnText,
    candidate.text,
    candidate.href,
  ].join(' ')).toLowerCase();
  const href = String(candidate.href || '').toLowerCase();
  let score = baseScore;

  if (/arnona|ארנונה|property tax|municipal tax/.test(rowBlob)) score += 26;
  if (/arnona|ארנונה/.test(intent) && !/arnona|ארנונה|property tax|municipal tax/.test(rowBlob)) score -= 32;
  if (/fine|parking|ticket|דוח|חניה/.test(rowBlob) && /arnona|ארנונה/.test(normalizeText(intentText).toLowerCase())) score -= 18;
  if (/refund|refund request|reimbursement|החזר כספי|בקשה להחזר/.test(rowBlob)) score -= 40;
  if (/רישוי עסקים|שילוט|business licensing|business license/.test(rowBlob) && /arnona|ארנונה/.test(intent)) score -= 30;
  if (/online|digital|internet|מקוון|באינטרנט/.test(rowBlob)) score += 8;
  if (/pay now|לתשלום|תשלום/.test(rowBlob)) score += 12;
  if (/appointment|queue|זימון|תור/.test(rowBlob)) score -= 24;
  if (/javascript:__dopostback|__dopostback/.test(rowBlob)) score += 6;
  if (href && !/tel-aviv\.gov\.il/i.test(href)) score += 20;
  if (Number(candidate.cellCount || 0) >= 2) score += 4;

  return score;
}

async function collectVisibleActionCandidates(page) {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('a[href], button, [role="button"], input[type="button"], input[type="submit"]'));
    return nodes
      .map((el, index) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const visible = style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 10 && rect.height > 10;
        return {
          candidateIndex: index,
          tag: String(el.tagName || '').toLowerCase(),
          text: String(el.innerText || el.textContent || el.getAttribute('value') || '').replace(/\s+/g, ' ').trim(),
          href: el.getAttribute('href') || el.href || '',
          onclick: el.getAttribute('onclick') || '',
          id: el.id || '',
          name: el.getAttribute('name') || '',
          className: typeof el.className === 'string' ? el.className : '',
          ariaLabel: el.getAttribute('aria-label') || '',
          title: el.getAttribute('title') || '',
          visible,
        };
      })
      .filter((item) => item.visible)
      .slice(0, 400);
  });
}

async function clickActionCandidateByFingerprint(page, candidate = {}) {
  return page.evaluate((fingerprint) => {
    const nodes = Array.from(document.querySelectorAll('a[href], button, [role="button"], input[type="button"], input[type="submit"]'));
    const wanted = [
      fingerprint.id,
      fingerprint.name,
      fingerprint.text,
      fingerprint.href,
      fingerprint.onclick,
    ].map((value) => String(value || '').trim()).filter(Boolean);

    function same(el) {
      const values = [
        el.id || '',
        el.getAttribute('name') || '',
        String(el.innerText || el.textContent || el.getAttribute('value') || '').replace(/\s+/g, ' ').trim(),
        el.getAttribute('href') || el.href || '',
        el.getAttribute('onclick') || '',
      ].map((value) => String(value || '').trim());
      return wanted.every((token) => values.includes(token) || values.some((value) => value && token && value.includes(token)));
    }

    const target = nodes.find((el) => same(el)) || null;
    if (!target) return { clicked: false, reason: 'not-found' };
    try {
      target.scrollIntoView({ block: 'center', inline: 'center' });
    } catch {
    }
    try {
      target.click();
      return { clicked: true };
    } catch (error) {
      return { clicked: false, reason: error?.message || String(error) };
    }
  }, candidate);
}

async function dismissCookieBannerIfPresent(page) {
  try {
    const clicked = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
      const exactRe = /^(הבנתי|accept|agree|got it|ok)$/i;
      for (const el of nodes) {
        const text = String(el.innerText || el.textContent || el.getAttribute('value') || el.getAttribute('aria-label') || '').trim();
        if (!text) continue;
        const containerText = String(el.parentElement?.innerText || el.closest('[role="dialog"], .cookie, .cookies, .cookie-banner, .consent')?.innerText || '').toLowerCase();
        const looksLikeCookieBanner = /cookie|cookies|עוגיות/.test(containerText);
        if (!exactRe.test(text) && !(looksLikeCookieBanner && /אישור|accept|agree|ok|הבנתי/i.test(text))) continue;
        try {
          el.click();
          return text;
        } catch {
        }
      }
      return '';
    });
    return { clicked: Boolean(clicked), label: clicked || null };
  } catch {
    return { clicked: false, label: null };
  }
}

async function waitForPageDomStable(page, waitMs = 800) {
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(Math.max(200, Number(waitMs) || 800));
}

async function collectTelAvivFlowSnapshot(page) {
  return page.evaluate(() => {
    const text = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const linkTexts = Array.from(document.querySelectorAll('a, button, [role="button"]'))
      .map((el) => String(el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 250);
    return {
      href: window.location.href,
      title: document.title || '',
      text,
      linkTexts,
      hasClientTypePrompt: /האם הנך לקוח פרטי או עסקי|בחרו סוג לקוח/i.test(text),
      hasArnonaPage: /ארנונה|arnona/i.test(text),
      hasMoreDetailsLink: /פרטים נוספים|פרטים מלאים|more details/i.test(text),
      hasDigitelLogin: /דיגיתל|mydigitel|התחבר|כניסה/i.test(text),
      hasQueueReservationHost: /www5\.tel-aviv\.gov\.il\/TlvForms\/TlvQueueReservation/i.test(window.location.href),
    };
  });
}

async function tryClickPreferredSelector(page, selectors = []) {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    try {
      if (!await loc.count()) continue;
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ timeout: 4000, force: true }).catch(async () => {
        await loc.click({ timeout: 4000 });
      });
      return { clicked: true, selector };
    } catch {
    }
  }
  return { clicked: false, selector: null };
}

async function tryAdvanceTelAvivAppointmentAdapter(page, { intentText = '', applicant = {}, maxSteps = 5 } = {}) {
  const steps = [];
  const wantsBusiness = shouldPreferBusinessApplicant(intentText, applicant);
  const cookieDismissal = await dismissCookieBannerIfPresent(page);
  if (cookieDismissal.clicked) {
    await waitForPageDomStable(page, 400);
    steps.push({ action: 'dismiss-cookie-banner', label: cookieDismissal.label });
  }

  for (let index = 0; index < Math.max(1, Number(maxSteps) || 5); index += 1) {
    const snapshot = await collectTelAvivFlowSnapshot(page).catch(() => null);
    if (!snapshot) break;
    if (snapshot.hasQueueReservationHost || /ArnonaSwitching\.aspx/i.test(snapshot.href)) break;

    const beforeUrl = snapshot.href;
    let click = { clicked: false, selector: null };
    let label = '';

    if (snapshot.hasClientTypePrompt) {
      click = await tryClickPreferredSelector(page, wantsBusiness
        ? ['#client_25', '[name="client_type"]:has-text("לקוח עסקי")', 'a[onclick*="getCustomerType"]:has-text("לקוח עסקי")']
        : ['#client_24', '[name="client_type"]:has-text("לקוח פרטי")', 'a[onclick*="getCustomerType"]:has-text("לקוח פרטי")']);
      label = wantsBusiness ? 'select-client-business' : 'select-client-private';
    } else if (!/ArnonaSwitching\.aspx/i.test(snapshot.href) && (snapshot.hasArnonaPage || /arnona|ארנונה|property tax/i.test(intentText))) {
      click = await tryClickPreferredSelector(page, [
        'a[href*="/Residents/Arnona/Pages/ArnonaSwitching.aspx"]',
        'a:has-text("חילופי מחזיקים")',
        'a:has-text("ארנונה")',
        'a[href*="/Residents/Arnona/Pages/Arnona.aspx"]',
        'a:has-text("פרטים נוספים")',
      ]);
      label = 'advance-arnona-path';
    } else if (snapshot.hasMoreDetailsLink) {
      click = await tryClickPreferredSelector(page, [
        'a:has-text("פרטים נוספים")',
        'a:has-text("פרטים מלאים")',
        'a[href*="ArnonaSwitching.aspx"]',
      ]);
      label = 'advance-more-details';
    }

    if (!click.clicked) break;
    await waitForPageDomStable(page, 1400);
    const afterUrl = page.url();
    steps.push({
      action: label || 'adapter-step',
      selector: click.selector,
      beforeUrl,
      afterUrl,
      changedUrl: beforeUrl !== afterUrl,
    });
  }

  return { ok: true, steps };
}

async function extractTelAvivPaymentTableCandidates(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const rows = Array.from(document.querySelectorAll('table tr'));
    const results = [];

    rows.forEach((row, rowIndex) => {
      const cells = Array.from(row.querySelectorAll('th, td'));
      const rowText = normalize(cells.map((cell) => cell.innerText || cell.textContent || '').join(' | ') || row.innerText || '');
      const table = row.closest('table');
      const sectionNode = table?.previousElementSibling || row.closest('section, article, .content, .main-content');
      const sectionText = normalize(sectionNode?.innerText || '');
      const actionNodes = Array.from(row.querySelectorAll('a[href], button, [role="button"], input[type="button"], input[type="submit"]'));

      actionNodes.forEach((el, actionIndex) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (!style || style.visibility === 'hidden' || style.display === 'none' || rect.width <= 6 || rect.height <= 6) return;
        results.push({
          rowIndex,
          actionIndex,
          cellCount: cells.length,
          rowText,
          sectionText,
          columnText: normalize(cells.map((cell) => cell.getAttribute('data-title') || cell.getAttribute('headers') || '').join(' | ')),
          text: normalize(el.innerText || el.textContent || el.getAttribute('value') || el.getAttribute('aria-label') || ''),
          href: el.getAttribute('href') || el.href || '',
          onclick: el.getAttribute('onclick') || '',
          id: el.id || '',
          name: el.getAttribute('name') || '',
          className: typeof el.className === 'string' ? el.className : '',
          ariaLabel: el.getAttribute('aria-label') || '',
          title: el.getAttribute('title') || '',
          tag: String(el.tagName || '').toLowerCase(),
        });
      });
    });

    return results.slice(0, 200);
  });
}

function truncatePaymentEvidenceText(value = '', maxLength = 12000) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 16))}\n...[truncated]`;
}

function normalizePaymentHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers || {})
      .map(([key, value]) => [String(key || '').trim().toLowerCase(), String(value ?? '').trim()])
      .filter(([key, value]) => key && value)
      .slice(0, 80)
  );
}

function shouldCaptureResponseBody(headers = {}) {
  const contentType = String(headers['content-type'] || '').toLowerCase();
  return /text|json|javascript|xml|html|svg/.test(contentType);
}

function createPaymentBoundaryNetworkCapture(page) {
  const requests = [];
  const responses = [];
  const pendingTasks = new Set();

  const onRequest = (request) => {
    if (requests.length >= PAYMENT_BOUNDARY_CAPTURE_LIMIT) return;
    requests.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      headers: normalizePaymentHeaders(request.headers()),
      postDataPreview: truncatePaymentEvidenceText(request.postData() || '', 4000),
      capturedAt: new Date().toISOString(),
    });
  };

  const onResponse = (response) => {
    if (responses.length >= PAYMENT_BOUNDARY_CAPTURE_LIMIT) return;
    const task = (async () => {
      const headers = normalizePaymentHeaders(await response.allHeaders().catch(() => ({})));
      const entry = {
        url: response.url(),
        status: response.status(),
        statusText: response.statusText(),
        headers,
        capturedAt: new Date().toISOString(),
        bodyPreview: '',
      };
      if (shouldCaptureResponseBody(headers)) {
        entry.bodyPreview = truncatePaymentEvidenceText(await response.text().catch(() => ''), 12000);
      }
      responses.push(entry);
    })();
    pendingTasks.add(task);
    task.finally(() => pendingTasks.delete(task));
  };

  page.on('request', onRequest);
  page.on('response', onResponse);

  return {
    requests,
    responses,
    async flush() {
      await Promise.allSettled(Array.from(pendingTasks));
    },
    dispose() {
      page.off('request', onRequest);
      page.off('response', onResponse);
    },
  };
}

async function tryAdvanceTelAvivPaymentAdapter(page, { intentText = '' } = {}) {
  const candidates = await extractTelAvivPaymentTableCandidates(page).catch(() => []);
  const ranked = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({
      ...candidate,
      score: scoreTelAvivPaymentTableCandidate(candidate, { intentText }),
    }))
    .sort((left, right) => right.score - left.score);

  const chosen = ranked.find((candidate) => candidate.score >= 24) || null;
  if (!chosen) {
    return { ok: true, steps: [], candidateLinks: ranked.slice(0, 8) };
  }

  const beforeUrl = page.url();
  const clickResult = await clickActionCandidateByFingerprint(page, chosen);
  if (!clickResult?.clicked) {
    return {
      ok: false,
      steps: [],
      candidateLinks: ranked.slice(0, 8),
      reason: clickResult?.reason || 'payment-link-click-failed',
    };
  }

  await waitForPageDomStable(page, 1800);
  const afterUrl = page.url();
  return {
    ok: true,
    candidateLinks: ranked.slice(0, 8),
    steps: [{
      action: 'payment-table-link',
      pickedText: chosen.text,
      pickedHref: chosen.href,
      rowText: chosen.rowText,
      score: chosen.score,
      beforeUrl,
      afterUrl,
      changedUrl: beforeUrl !== afterUrl,
    }],
  };
}

async function tryAdvanceTelAvivFlow(page, { bookingUrl = '', intentText = '', applicant = {}, mode = 'booking', maxSteps = 3 } = {}) {
  const steps = [];
  const seenKeys = new Set();
  let candidateLinks = [];
  if (isTelAvivAppointmentsUrl(bookingUrl) && String(mode || 'booking').toLowerCase() === 'booking') {
    const adapted = await tryAdvanceTelAvivAppointmentAdapter(page, { intentText, applicant, maxSteps: Math.max(3, Number(maxSteps) || 3) });
    steps.push(...(adapted?.steps || []));
    const currentUrl = page.url();
    if (/www5\.tel-aviv\.gov\.il\/TlvForms\/TlvQueueReservation|ArnonaSwitching\.aspx/i.test(currentUrl)) {
      return { ok: true, mode, steps, adapter: 'tel-aviv-appointment' };
    }
  }
  if (isTelAvivPaymentsUrl(bookingUrl) && String(mode || 'booking').toLowerCase() === 'payment') {
    const adapted = await tryAdvanceTelAvivPaymentAdapter(page, { intentText });
    candidateLinks = adapted?.candidateLinks || [];
    steps.push(...(adapted?.steps || []));
    const currentUrl = page.url();
    if ((adapted?.steps || []).length && !/tel-aviv\.gov\.il/i.test(currentUrl)) {
      return { ok: true, mode, steps, adapter: 'tel-aviv-payment', candidateLinks };
    }
  }
  const cookieDismissal = await dismissCookieBannerIfPresent(page);
  if (cookieDismissal.clicked) {
    await waitForPageDomStable(page, 400);
    steps.push({ action: 'dismiss-cookie-banner', label: cookieDismissal.label });
  }

  for (let attempt = 0; attempt < Math.max(1, Number(maxSteps) || 3); attempt += 1) {
    await waitForPageDomStable(page, 500);
    const beforeUrl = page.url();
    let candidates = [];
    try {
      candidates = await collectVisibleActionCandidates(page);
    } catch (error) {
      if (/Execution context was destroyed/i.test(String(error?.message || error))) {
        await waitForPageDomStable(page, 900);
        candidates = await collectVisibleActionCandidates(page).catch(() => []);
      } else {
        throw error;
      }
    }
    const scored = candidates
      .map((candidate) => ({
        ...candidate,
        score: scoreTelAvivFlowActionCandidate(candidate, { intentText, mode }),
      }))
      .filter((candidate) => candidate.score >= 12)
      .sort((left, right) => right.score - left.score);

    const chosen = scored.find((candidate) => {
      const key = [candidate.text, candidate.href, candidate.onclick, candidate.id, candidate.name].join('|');
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });

    if (!chosen) break;

    const clickResult = await clickActionCandidateByFingerprint(page, chosen);
    if (!clickResult?.clicked) continue;
    await waitForPageDomStable(page, 1500);

    const afterUrl = page.url();
    steps.push({
      action: 'advance-flow',
      mode,
      pickedText: chosen.text,
      pickedHref: chosen.href,
      score: chosen.score,
      beforeUrl,
      afterUrl,
      changedUrl: beforeUrl !== afterUrl,
    });

    if (isTelAvivAppointmentsUrl(bookingUrl) && /www5\.tel-aviv\.gov\.il\/TlvForms\/TlvQueueReservation/i.test(afterUrl)) {
      break;
    }
    if (isTelAvivPaymentsUrl(bookingUrl) && !/tel-aviv\.gov\.il/i.test(afterUrl)) {
      break;
    }
  }

  return { ok: true, mode, steps, candidateLinks };
}

export async function runTelAvivPaymentsBoundaryAssist({
  paymentUrl = 'https://www.tel-aviv.gov.il/About/Pages/Payments.aspx',
  intentText = 'Identify the correct Tel Aviv payment branch and stop before any irreversible payment credentials or confirmation step.',
  headless = true,
  timeoutMs = 90000,
  screenshotRoot = path.resolve(process.cwd(), 'tmp', 'tel-aviv-payments-boundary'),
} = {}) {
  const startedAt = Date.now();
  await ensureDir(screenshotRoot);

  const stealth = buildStealthContextOptions(`${paymentUrl}:${intentText}`);
  const browser = await chromium.launch({ headless: Boolean(headless) });
  const context = await browser.newContext(stealth.contextOptions);
  const page = await context.newPage();
  await applyStealthLite(page, stealth.identity);
  const networkCapture = createPaymentBoundaryNetworkCapture(page);

  try {
    await page.goto(paymentUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await waitForPageDomStable(page, 1200);
    const landingShot = path.join(screenshotRoot, `payments-landing-${Date.now()}.png`);
    await page.screenshot({ path: landingShot, fullPage: true });

    const advance = await tryAdvanceTelAvivFlow(page, {
      bookingUrl: paymentUrl,
      intentText,
      mode: 'payment',
      maxSteps: 3,
    });

    await waitForPageDomStable(page, 1000);

    let pageAnalysis = null;
    let pageText = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        pageAnalysis = await capturePageAnalysis(page);
        pageText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 15000));
        break;
      } catch (error) {
        if (!/Execution context was destroyed/i.test(String(error?.message || error)) || attempt === 2) {
          throw error;
        }
        await waitForPageDomStable(page, 1200);
      }
    }
    const currentUrl = page.url();
    const providerSummary = summarizePaymentProvider(currentUrl, pageText);
    await networkCapture.flush();
    const cookies = await context.cookies().catch(() => []);
    const evidence = {
      requests: networkCapture.requests,
      responses: networkCapture.responses,
      cookies,
      domSnapshotPreview: truncatePaymentEvidenceText(pageAnalysis?.pageSourcePreview || '', 12000),
      pageTextPreview: truncatePaymentEvidenceText(pageText, 8000),
    };
    const adapterAnalysis = analyzePaymentProviderBoundary({
      providerSummary,
      evidence,
      intentText,
    });
    const finalShot = path.join(screenshotRoot, `payments-boundary-${Date.now()}.png`);
    await page.screenshot({ path: finalShot, fullPage: true });
    const savedEvidence = await savePaymentBoundaryEvidence({
      evidenceId: `tel-aviv-payments-boundary-${Date.now()}`,
      mode: 'tel-aviv-payments-boundary-assist',
      paymentUrl,
      finalUrl: currentUrl,
      pageTitle: await page.title(),
      intentText,
      paymentProvider: providerSummary,
      adapter: adapterAnalysis.adapter,
      adapterAnalysis,
      screenshots: [landingShot, finalShot],
      evidence,
      advanceSteps: advance.steps,
      candidateLinks: Array.isArray(pageAnalysis?.links) ? pageAnalysis.links.slice(0, 25) : [],
      paymentTableCandidates: Array.isArray(advance?.candidateLinks) ? advance.candidateLinks.slice(0, 8) : [],
      operatorInstructions: adapterAnalysis.operatorInstructions,
    });

    return {
      ok: true,
      mode: 'tel-aviv-payments-boundary-assist',
      submitted: false,
      requiresHuman: true,
      reason: providerSummary.irreversibleBoundaryDetected
        ? 'payment-credentials-required'
        : (providerSummary.loginRequired ? 'login-required' : 'discovery-boundary'),
      paymentUrl,
      finalUrl: currentUrl,
      pageTitle: await page.title(),
      irreversibleBoundaryDetected: providerSummary.irreversibleBoundaryDetected,
      loginRequired: providerSummary.loginRequired,
      paymentProvider: providerSummary,
      operatorInstructions: adapterAnalysis.operatorInstructions,
      adapter: adapterAnalysis.adapter,
      adapterAnalysis,
      evidenceSummary: buildPaymentBoundaryUiSummary({
        paymentProvider: providerSummary,
        adapter: adapterAnalysis.adapter,
        evidence,
      }),
      savedEvidence,
      candidateLinks: Array.isArray(pageAnalysis?.links) ? pageAnalysis.links.slice(0, 25) : [],
      paymentTableCandidates: Array.isArray(advance?.candidateLinks) ? advance.candidateLinks.slice(0, 8) : [],
      advanceSteps: advance.steps,
      screenshots: [landingShot, finalShot],
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    networkCapture.dispose();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function tryNavigateToAppointmentFlow(page, currentUrl, intentText = '', scrapeSnapshot = null) {
  const candidates = await page.evaluate(() => {
    const list = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => ({
        href: a.href || '',
        text: (a.innerText || a.getAttribute('aria-label') || a.title || '').trim(),
      }))
      .filter((x) => x.href && x.text);
    return list.slice(0, 400);
  });

  const filtered = (candidates || []).filter((x) => {
    const href = String(x.href || '');
    if (!href || href === currentUrl) return false;
    if (href.startsWith('javascript:') || href === '#') return false;
    return true;
  });

  if (filtered.length === 0) return { moved: false };

  const intent = String(intentText || '').toLowerCase();
  const scrapedTerms = Array.isArray(scrapeSnapshot?.relevanceTerms) ? scrapeSnapshot.relevanceTerms : [];
  const intentKeywords = [
    { re: /arnona|ארנונה|property tax|municipal tax|תשלום/, boost: 30 },
    { re: /service center|מרכזי שירות|מוקד/, boost: 12 },
    { re: /appointment|זימון|תור|book/i, boost: 8 },
    { re: /construction|רישוי|פיקוח|בנייה/, boost: -5 },
  ];

  const scored = filtered.map((x) => {
    const text = `${x.text} ${x.href}`.toLowerCase();
    let score = 0;
    let textMatch = false;
    let hrefMatch = false;
    let intentBoost = false;
    for (const rule of intentKeywords) {
      if (rule.re.test(text)) score += rule.boost;
      if (rule.re.test(text)) textMatch = true;
      if (intent && rule.re.test(intent) && rule.re.test(text)) {
        score += 10;
        intentBoost = true;
      }
    }
    for (const term of scrapedTerms.slice(0, 40)) {
      const t = String(term || '').toLowerCase();
      if (t && text.includes(t)) score += 2;
    }
    if (/Residents\/Arnona|Arnona\/Pages/i.test(x.href)) {
      score += 18;
      hrefMatch = true;
    }
    if (/appointment|book|קביעת|זימון|תור|arnona|ארנונה/i.test(x.text)) score += 8;
    return { ...x, score, textMatch, hrefMatch, intentBoost, decisionExplanation: explainDecision({ textMatch, hrefMatch, intentBoost, replayScore: score }) };
  }).sort((a, b) => b.score - a.score);

  const preferred = scored.find((x) => x.score > 0) || scored[0] || filtered[0];
  await page.goto(preferred.href, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(1500);
  return { moved: true, url: preferred.href, text: preferred.text, score: preferred.score, explanation: preferred.decisionExplanation, candidateLinks: scored.slice(0, 8) };
}

async function snapshotFormModel(page) {
  const snapshot = await page.evaluate(() => {
    function labelTextFor(el) {
      if (!el) return '';
      const id = el.id || '';
      const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const parentLabel = el.closest('label');
      const nearby = el.closest('div,td,li,section,article')?.querySelector('label');
      return (byFor?.innerText || parentLabel?.innerText || nearby?.innerText || '').trim();
    }

    const forms = Array.from(document.querySelectorAll('form')).map((form, idx) => {
      const fields = Array.from(form.querySelectorAll('input, select, textarea'))
        .filter((el) => {
          const type = String(el.getAttribute('type') || '').toLowerCase();
          if (type === 'hidden') return false;
          return true;
        })
        .map((el) => {
          const type = String(el.getAttribute('type') || '').toLowerCase() || el.tagName.toLowerCase();
          const options = el.tagName.toLowerCase() === 'select'
            ? Array.from(el.querySelectorAll('option')).map((o) => ({ value: o.value || '', text: (o.innerText || '').trim() })).slice(0, 25)
            : [];
          return {
            tag: el.tagName.toLowerCase(),
            type,
            id: el.id || '',
            name: el.getAttribute('name') || '',
            placeholder: el.getAttribute('placeholder') || '',
            required: el.hasAttribute('required'),
            ariaLabel: el.getAttribute('aria-label') || '',
            label: labelTextFor(el),
            options,
          };
        });

      const submitButtons = Array.from(form.querySelectorAll('button, input[type="submit"], input[type="button"]')).map((b) => ({
        tag: b.tagName.toLowerCase(),
        type: (b.getAttribute('type') || '').toLowerCase(),
        id: b.id || '',
        name: b.getAttribute('name') || '',
        text: (b.innerText || b.getAttribute('value') || '').trim(),
      }));

      return {
        formIndex: idx,
        synthetic: false,
        id: form.id || '',
        name: form.getAttribute('name') || '',
        action: form.getAttribute('action') || '',
        method: (form.getAttribute('method') || 'get').toLowerCase(),
        fields,
        submitButtons,
      };
    });

    const standaloneFields = Array.from(document.querySelectorAll('input, select, textarea'))
      .filter((el) => !el.closest('form'))
      .filter((el) => String(el.getAttribute('type') || '').toLowerCase() !== 'hidden')
      .map((el) => {
        const type = String(el.getAttribute('type') || '').toLowerCase() || el.tagName.toLowerCase();
        const options = el.tagName.toLowerCase() === 'select'
          ? Array.from(el.querySelectorAll('option')).map((o) => ({ value: o.value || '', text: (o.innerText || '').trim() })).slice(0, 25)
          : [];
        return {
          tag: el.tagName.toLowerCase(),
          type,
          id: el.id || '',
          name: el.getAttribute('name') || '',
          placeholder: el.getAttribute('placeholder') || '',
          required: el.hasAttribute('required'),
          ariaLabel: el.getAttribute('aria-label') || '',
          label: labelTextFor(el),
          options,
        };
      });

    const standaloneSubmitButtons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'))
      .filter((el) => !el.closest('form'))
      .map((b) => ({
        tag: b.tagName.toLowerCase(),
        type: (b.getAttribute('type') || '').toLowerCase(),
        id: b.id || '',
        name: b.getAttribute('name') || '',
        text: (b.innerText || b.getAttribute('value') || '').trim(),
      }));

    if (standaloneFields.length >= 3 && standaloneSubmitButtons.length) {
      forms.push({
        formIndex: forms.length,
        synthetic: true,
        id: 'synthetic-page-form',
        name: 'synthetic-page-form',
        action: window.location.href,
        method: 'post',
        fields: standaloneFields,
        submitButtons: standaloneSubmitButtons,
      });
    }

    const pageText = (document.body?.innerText || '').slice(0, 15000);
    const title = document.title || '';
    const href = window.location.href;

    return { forms, pageText, title, href };
  });

  const scoredForms = (Array.isArray(snapshot?.forms) ? snapshot.forms : [])
    .map((form) => ({ ...form, intentScore: scoreBookingFormCandidate(form, snapshot?.pageText || '') }))
    .sort((left, right) => (right.intentScore || 0) - (left.intentScore || 0));

  return {
    ...snapshot,
    forms: scoredForms,
    bestFormScore: scoredForms[0]?.intentScore || 0,
  };
}

function fieldSearchBlob(field) {
  return normalizeText([
    field.id,
    field.name,
    field.placeholder,
    field.ariaLabel,
    field.label,
    field.type,
  ].join(' ')).toLowerCase();
}

function pickValueForField(field, applicant = {}) {
  const blob = fieldSearchBlob(field);
  const computedFullName = normalizeText(applicant.fullName || [applicant.firstName, applicant.lastName].filter(Boolean).join(' '));
  const usernameValue = String(applicant.username || applicant.loginUsername || computedFullName || applicant.firstName || '').trim();
  const map = [
    { keys: ['username', 'user name', 'login name', 'שם משתמש'], value: usernameValue },
    { keys: ['first name', 'given name', 'forename', 'fname', 'שם פרטי'], value: applicant.firstName },
    { keys: ['last name', 'surname', 'family name', 'lname', 'שם משפחה'], value: applicant.lastName },
    { keys: ['full name', 'שם מלא', 'applicant'], value: computedFullName },
    { keys: ['id number', 'id no', 'identity', 'teudat', 'תעודת זהות', 'מספר זהות', 'tz'], value: applicant.idNumber },
    { keys: ['phone', 'mobile', 'telephone', 'טלפון', 'נייד'], value: applicant.phone },
    { keys: ['email', 'e-mail', 'דוא"ל', 'מייל'], value: applicant.email },
    { keys: ['city', 'town', 'יישוב', 'עיר'], value: applicant.city },
    { keys: ['street', 'road', 'st.', 'רחוב'], value: applicant.street },
    { keys: ['house number', 'home number', 'building', 'מספר בית'], value: applicant.houseNumber },
    { keys: ['apartment', 'apt', 'דירה'], value: applicant.apartment },
    { keys: ['zip', 'postal', 'מיקוד'], value: applicant.zipCode },
    { keys: ['arnona', 'ארנונה', 'property tax'], value: applicant.arnonaAccount || applicant.topic || 'Arnona' },
    { keys: ['address', 'residence', 'כתובת'], value: applicant.address },
    { keys: ['note', 'details', 'description', 'הערות', 'פירוט'], value: applicant.notes },
  ];

  for (const entry of map) {
    if (entry.value == null || entry.value === '') continue;
    if (entry.keys.some((k) => blob.includes(k.toLowerCase()))) {
      return String(entry.value);
    }
  }

  const extraFields = applicant?.extraFields && typeof applicant.extraFields === 'object'
    ? applicant.extraFields
    : {};
  for (const [key, rawValue] of Object.entries(extraFields)) {
    const normalizedKey = normalizeText(key).toLowerCase();
    if (!normalizedKey || rawValue == null || rawValue === '') continue;
    if (blob.includes(normalizedKey)) {
      return String(rawValue);
    }
  }
  return null;
}

async function attemptPrefill(page, formModel, applicant = {}) {
  const filled = [];
  const forms = [...(formModel.forms || [])]
    .sort((left, right) => (right.intentScore || 0) - (left.intentScore || 0));
  const topScore = forms[0]?.intentScore || 0;
  const candidateForms = forms.filter((form) => (form.intentScore || 0) >= Math.max(8, topScore - 6));

  for (const form of candidateForms) {
    for (const field of form.fields || []) {
      const value = pickValueForField(field, applicant);
      if (!value) continue;
      const selectorCandidates = [];
      if (field.id) selectorCandidates.push(`#${cssEscapeIdentifier(field.id)}`);
      if (field.name) selectorCandidates.push(`[name="${field.name.replace(/"/g, '\\"')}"]`);
      if (field.ariaLabel) selectorCandidates.push(`[aria-label="${field.ariaLabel.replace(/"/g, '\\"')}"]`);
      if (field.placeholder) selectorCandidates.push(`[placeholder="${field.placeholder.replace(/"/g, '\\"')}"]`);
      if (field.type) selectorCandidates.push(`input[type="${String(field.type || '').replace(/"/g, '\\"')}"][name="${String(field.name || '').replace(/"/g, '\\"')}"]`);

      let done = false;
      for (const sel of selectorCandidates) {
        try {
          const locator = page.locator(sel).first();
          const count = await locator.count();
          if (!count) continue;
          const tagName = await locator.evaluate((el) => el.tagName.toLowerCase());
          const type = String(await locator.getAttribute('type') || '').toLowerCase();
          if (tagName === 'select') {
            await locator.selectOption({ label: value }).catch(async () => {
              await locator.selectOption({ value }).catch(async () => {
                await locator.selectOption({ index: 1 }).catch(() => {});
              });
            });
          } else if (type === 'checkbox' || type === 'radio') {
            if (isTruthy(value, false)) {
              await locator.check({ force: true }).catch(() => {});
            }
          } else {
            await locator.fill(value, { timeout: 4000 }).catch(() => {});
          }
          filled.push({ selector: sel, valuePreview: value.slice(0, 60), field });
          done = true;
          break;
        } catch {
        }
      }

      if (!done && field.label) {
        try {
          const byLabel = page.getByLabel(field.label, { exact: false }).first();
          if (await byLabel.count()) {
            await byLabel.fill(value, { timeout: 4000 }).catch(() => {});
            filled.push({ selector: `label:${field.label}`, valuePreview: value.slice(0, 60), field });
          }
        } catch {
        }
      }
    }
  }
  return filled;
}

function compareFieldValue(expectedRaw, actualRaw, field = {}) {
  const expected = String(expectedRaw || '').trim();
  const actual = String(actualRaw || '').trim();
  if (!expected || !actual) return false;
  const type = String(field?.type || '').toLowerCase();
  if (type === 'email') {
    return normalizeText(expected).toLowerCase() === normalizeText(actual).toLowerCase();
  }
  if (/phone|mobile|tel/.test(type)) {
    const expDigits = expected.replace(/\D/g, '');
    const actDigits = actual.replace(/\D/g, '');
    return Boolean(expDigits && actDigits && (actDigits.endsWith(expDigits) || expDigits.endsWith(actDigits)));
  }
  const expNorm = normalizeText(expected).toLowerCase();
  const actNorm = normalizeText(actual).toLowerCase();
  return actNorm.includes(expNorm) || expNorm.includes(actNorm);
}

async function readFieldCurrentValue(page, field = {}) {
  const selectorCandidates = [];
  if (field.id) selectorCandidates.push(`#${cssEscapeIdentifier(field.id)}`);
  if (field.name) selectorCandidates.push(`[name="${String(field.name || '').replace(/"/g, '\\"')}"]`);
  if (field.ariaLabel) selectorCandidates.push(`[aria-label="${String(field.ariaLabel || '').replace(/"/g, '\\"')}"]`);
  if (field.placeholder) selectorCandidates.push(`[placeholder="${String(field.placeholder || '').replace(/"/g, '\\"')}"]`);

  for (const selector of selectorCandidates) {
    try {
      const locator = page.locator(selector).first();
      if (!(await locator.count())) continue;
      const tag = String(await locator.evaluate((el) => el.tagName.toLowerCase())).toLowerCase();
      const type = String(await locator.getAttribute('type') || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        const checked = await locator.isChecked().catch(() => false);
        return checked ? 'checked' : '';
      }
      if (tag === 'select') {
        return String(await locator.inputValue().catch(() => '') || '').trim();
      }
      return String(await locator.inputValue().catch(() => '') || '').trim();
    } catch {
    }
  }

  if (field.label) {
    try {
      const byLabel = page.getByLabel(field.label, { exact: false }).first();
      if (await byLabel.count()) {
        return String(await byLabel.inputValue().catch(() => '') || '').trim();
      }
    } catch {
    }
  }

  return '';
}

async function verifyRequiredFormFieldsFilled(page, model, applicant = {}) {
  const forms = Array.isArray(model?.forms) ? model.forms : [];
  const topScore = forms[0]?.intentScore || 0;
  const candidateForms = forms.filter((form) => (form.intentScore || 0) >= Math.max(8, topScore - 6));
  const requiredFields = candidateForms
    .flatMap((form) => Array.isArray(form?.fields) ? form.fields : [])
    .filter((field) => {
      const type = String(field?.type || '').toLowerCase();
      return Boolean(field?.required) && !['hidden', 'submit', 'button', 'reset'].includes(type);
    });

  const seen = new Set();
  const uniqueRequiredFields = requiredFields.filter((field) => {
    const key = `${String(field?.id || '').toLowerCase()}|${String(field?.name || '').toLowerCase()}|${String(field?.label || '').toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 24);

  const checks = [];
  for (const field of uniqueRequiredFields) {
    const expected = pickValueForField(field, applicant);
    const actual = await readFieldCurrentValue(page, field);
    const hasValue = Boolean(String(actual || '').trim());
    const expectedMatched = expected ? compareFieldValue(expected, actual, field) : hasValue;
    checks.push({
      key: inferCanonicalFieldKey(field),
      label: normalizeText(field?.label || field?.name || field?.id || ''),
      required: true,
      expectedValuePresent: Boolean(expected),
      hasValue,
      expectedMatched,
      valuePreview: hasValue ? String(actual).slice(0, 40) : '',
    });
  }

  const totalRequired = checks.length;
  const missingRequired = checks.filter((entry) => !entry.hasValue).length;
  const expectedChecks = checks.filter((entry) => entry.expectedValuePresent);
  const expectedMismatches = expectedChecks.filter((entry) => !entry.expectedMatched).length;
  const ok = totalRequired > 0 && missingRequired === 0 && expectedMismatches === 0;

  return {
    ok,
    totalRequired,
    missingRequired,
    expectedChecks: expectedChecks.length,
    expectedMismatches,
    checkedAt: new Date().toISOString(),
    checks,
  };
}

export async function startAttendedBookingSession({
  requestId = null,
  bookingUrl = DEFAULT_BOOKING_URL,
  applicant = {},
  intentText = '',
  headless = false,
  timeoutMs = 90000,
  sessionRoot = ATTENDED_SESSION_ROOT,
} = {}) {
  await cleanupExpiredSessions();
  await ensureDir(sessionRoot);
  await persistKnownBookingInputs(applicant).catch(() => {});

  const token = randomUUID();
  const useSharedProfile = isTruthy(applicant?.reusePersistentProfile ?? process.env.BOOKING_REUSE_PROFILE, true);
  let userDataDir = useSharedProfile
    ? SHARED_AUTONOMOUS_PROFILE_DIR
    : path.join(sessionRoot, `profile-${token}`);
  const screenshotRoot = path.join(sessionRoot, `screens-${token}`);
  await ensureDir(userDataDir);
  await ensureDir(screenshotRoot);

  const stealth = buildStealthContextOptions(`${bookingUrl}:${token}`);
  let context = null;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: Boolean(headless),
      ...stealth.contextOptions,
    });
  } catch (error) {
    if (!useSharedProfile) throw error;
    userDataDir = path.join(sessionRoot, `profile-${token}`);
    await ensureDir(userDataDir);
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: Boolean(headless),
      ...stealth.contextOptions,
    });
  }

  const page = context.pages()[0] || await context.newPage();
  await applyStealthLite(page, stealth.identity);
  const session = {
    token,
    requestId,
    bookingUrl,
    userDataDir,
    screenshotRoot,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    state: CHECKPOINT_STATES.AWAITING_LOGIN,
    submitted: false,
    antiBotDetected: false,
    prefilledFields: 0,
    approval: { approved: false, approvedAt: null, approvedBy: null, reason: null },
    screenshots: [],
    notes: [],
    network: [],
    actionLog: [],
    domFailures: [],
    replay: { candidateCount: 0, appliedCount: 0, failureCount: 0, actions: [] },
    flowPhase: inferBookingFlowPhase({ href: bookingUrl, title: '', pageText: '', forms: [] }),
    persistedActionCount: 0,
    persistedFailureCount: 0,
    hitlRequired: false,
    hitlReason: null,
    selectedAppointmentOptions: [],
    formRequirements: [],
    autoSelectionAttempts: 0,
    lastAutoSelectionAt: null,
    confirmation: null,
    debugOptions: normalizeDebugOptions(applicant || {}),
    debug: { timeline: [], snapshots: [], visualLayer: [], errorBuckets: {}, replaySimulator: { lastRun: null } },
    applicant,
    intentText,
    context,
    page,
  };
  ensureSessionDebugState(session);
  await installAttendedActionRecorder(page, session);

  page.on('request', (req) => {
    session.network.push(serializeNetworkEntry({
      ts: new Date().toISOString(),
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      from: 'request',
    }));
    if (session.network.length > 3000) session.network.splice(0, session.network.length - 3000);
  });

  page.on('response', (res) => {
    const req = res.request();
    session.network.push(serializeNetworkEntry({
      ts: new Date().toISOString(),
      method: req?.method?.() || '',
      url: res.url(),
      resourceType: req?.resourceType?.() || '',
      status: res.status(),
      ok: res.ok(),
      from: 'response',
    }));
    if (session.network.length > 3000) session.network.splice(0, session.network.length - 3000);
  });

  attendedSessions.set(token, session);

  try {
    await page.goto(bookingUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(1200);

    let telAvivAdvance = { steps: [] };
    if (isTelAvivAppointmentsUrl(bookingUrl)) {
      telAvivAdvance = await tryAdvanceTelAvivFlow(page, {
        bookingUrl,
        intentText: intentText || applicant?.notes || applicant?.topic || '',
        applicant,
        mode: 'booking',
        maxSteps: 3,
      });
    }

    let model = await snapshotFormModel(page);
    const scrapeSnapshot = await scrapePageRelevanceSnapshot(page, { intentText, applicant });
    if (isLikelyNonBookingFormModel(model)) {
      const nav = await tryNavigateToAppointmentFlow(page, model.href || bookingUrl, intentText || applicant?.notes || applicant?.topic || '', scrapeSnapshot);
      if (nav.moved) {
        session.notes.push(`Navigation hint: ${nav.text} -> ${nav.url}`);
        model = await snapshotFormModel(page);
        if (isTelAvivAppointmentsUrl(bookingUrl)) {
          telAvivAdvance = await tryAdvanceTelAvivFlow(page, {
            bookingUrl,
            intentText: intentText || applicant?.notes || applicant?.topic || '',
            applicant,
            mode: 'booking',
            maxSteps: 2,
          });
          model = await snapshotFormModel(page);
        }
      }
    }

    for (const step of telAvivAdvance.steps || []) {
      session.notes.push(`Tel Aviv flow advance: ${step.pickedText || step.action} (${step.afterUrl || step.beforeUrl || ''})`);
    }

    if (scrapeSnapshot.ok) {
      session.notes.push(`Scraper relevance: kept=${scrapeSnapshot.keptItems}, dropped=${scrapeSnapshot.droppedItems}, arnonaSignal=${scrapeSnapshot.hasArnonaSignal}`);
    }

    const prefilled = await attemptPrefill(page, model, applicant);
    const replayPrefill = await runReplayDrivenPrefill(page, session, model, applicant);
    const replayPrefillCount = Array.isArray(replayPrefill?.filled) ? replayPrefill.filled.length : 0;
    session.replay.candidateCount = Number(session.replay.candidateCount || 0) + Number(replayPrefill?.candidateCount || 0);
    session.replay.appliedCount = Number(session.replay.appliedCount || 0) + replayPrefillCount;
    if (replayPrefillCount > 0) {
      session.notes.push(`Replay-driven prefill filled ${replayPrefillCount} bound field(s).`);
      model = await snapshotFormModel(page);
    }

    if (isLikelyNonBookingFormModel(model) || (model?.forms?.length || 0) === 0) {
      const replayAttempt = await runLearnedDomReplay(page, session, model, { reason: 'attended-start-nonbooking' });
      session.replay.candidateCount = Number(session.replay.candidateCount || 0) + Number(replayAttempt?.candidateCount || 0);
      session.replay.failureCount = Number(session.replay.failureCount || 0) + Number(replayAttempt?.failures?.length || 0);
      if ((replayAttempt?.applied || []).length > 0) {
        model = await snapshotFormModel(page);
        session.notes.push(`Learned DOM replay advanced ${replayAttempt.applied.length} action(s) during session start.`);
      } else if ((replayAttempt?.candidateCount || 0) > 0) {
        await recordSessionDomFailure(session, 'attended-start-replay-failed', { replayCandidateCount: replayAttempt.candidateCount });
      }
    }

    const startPhase = inferBookingFlowPhase(model);
    if (startPhase?.phaseKey === BOOKING_FLOW_PHASES.APPOINTMENT_DIARY) {
      const autoSelection = await tryAutoSelectAppointmentDateTime(page, {
        intentText: intentText || applicant?.notes || applicant?.topic || '',
        applicant,
        maxSelections: 4,
      }).catch(() => ({ applied: false, selectedOptions: [] }));
      session.autoSelectionAttempts = Number(session.autoSelectionAttempts || 0) + 1;
      session.lastAutoSelectionAt = new Date().toISOString();
      session.appointmentCandidatePreview = Array.isArray(autoSelection?.candidatePreview) ? autoSelection.candidatePreview : [];
      if (autoSelection.applied) {
        session.selectedAppointmentOptions = mergeSelectedAppointmentOptions(session.selectedAppointmentOptions, autoSelection.selectedOptions || []);
        model = await snapshotFormModel(page);
        session.notes.push(`Auto-selected appointment options: ${Math.max(1, autoSelection.selectedOptions?.length || 0)} action(s) applied.`);
      }
    }

    const shot = path.join(screenshotRoot, `start-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true });

    updateSessionFlowPhase(session, model, 'start');
    session.currentUrl = model.href;
    session.pageTitle = model.title;
    session.prefilledFields = prefilled.length + replayPrefillCount;
    session.screenshots.push(shot);
    session.antiBotDetected = detectOtpOrCaptchaFromText(model.pageText).captcha;
    updateSessionCheckpointAndStage(session, model, { submitted: false, reason: 'session-start' });
    guardReadyToSubmitState(session, model, 'attended-start-non-booking-page');
    session.updatedAt = new Date().toISOString();
    session.updatedAtMs = Date.now();
    await persistAttendedDomLearning(session).catch(() => {});
    if (session.state === CHECKPOINT_STATES.READY_TO_SUBMIT) {
      session.notes.push('Ready to submit. Awaiting explicit human approval gate.');
    }

    return toPublicSession(session, { includeNetwork: true, networkLimit: 80 });
  } catch (err) {
    session.notes.push(`Start failed: ${err.message}`);
    session.updatedAt = new Date().toISOString();
    session.updatedAtMs = Date.now();
    throw err;
  }
}

export async function getAttendedBookingSessionStatus(token, { includeNetwork = false, networkLimit = 100 } = {}) {
  const session = attendedSessions.get(String(token || ''));
  if (!session) {
    return { ok: false, error: 'Session not found' };
  }

  try {
    let model = await snapshotFormModel(session.page);
    const phase = inferBookingFlowPhase(model);
    if (!session.submitted && phase?.phaseKey === BOOKING_FLOW_PHASES.APPOINTMENT_DIARY) {
      const nowMs = Date.now();
      const lastRunMs = session.lastAutoSelectionAt ? Date.parse(session.lastAutoSelectionAt) : 0;
      if (!lastRunMs || Number.isNaN(lastRunMs) || nowMs - lastRunMs >= 8000) {
        const autoSelection = await tryAutoSelectAppointmentDateTime(session.page, {
          intentText: session.intentText || session.applicant?.notes || session.applicant?.topic || '',
          applicant: session.applicant || {},
          maxSelections: 4,
        }).catch(() => ({ applied: false, selectedOptions: [] }));
        session.autoSelectionAttempts = Number(session.autoSelectionAttempts || 0) + 1;
        session.lastAutoSelectionAt = new Date().toISOString();
        session.appointmentCandidatePreview = Array.isArray(autoSelection?.candidatePreview) ? autoSelection.candidatePreview : [];
        if (autoSelection.applied) {
          session.selectedAppointmentOptions = mergeSelectedAppointmentOptions(session.selectedAppointmentOptions, autoSelection.selectedOptions || []);
          session.notes.push(`Auto-selection advanced diary step (selected=${autoSelection.selectedOptions?.length || 0}, continue=${autoSelection.continuationClicked ? 'yes' : 'no'}).`);
          model = await snapshotFormModel(session.page);
        }
      }
    }
    session.currentUrl = model.href;
    session.pageTitle = model.title;
    session.antiBotDetected = detectOtpOrCaptchaFromText(model.pageText).captcha;
    if (!session.submitted) {
      updateSessionFlowPhase(session, model, 'status');
      updateSessionCheckpointAndStage(session, model, { submitted: false, reason: 'status-refresh' });
      guardReadyToSubmitState(session, model, 'attended-status-non-booking-page');
    }
    if (session.submitted) {
      session.confirmation = extractBookingConfirmationEvidence(model);
    }
    if ((session.replay?.failureCount || 0) > 0 && (isLikelyNonBookingFormModel(model) || (model?.forms?.length || 0) === 0)) {
      session.hitlRequired = true;
      session.hitlReason = session.hitlReason || 'dom-replay-mismatch';
    }
    session.updatedAt = new Date().toISOString();
    session.updatedAtMs = Date.now();
    await persistAttendedDomLearning(session).catch(() => {});
  } catch (err) {
    session.notes.push(`Status snapshot failed: ${err.message}`);
    await recordSessionDomFailure(session, 'attended-status-snapshot-failed', { error: err.message }).catch(() => {});
  }

  return toPublicSession(session, { includeNetwork, networkLimit });
}

export async function resumeAttendedBookingSession(token, { applicant = null } = {}) {
  const session = attendedSessions.get(String(token || ''));
  if (!session) return { ok: false, error: 'Session not found' };

  if (applicant && typeof applicant === 'object') {
    session.applicant = { ...(session.applicant || {}), ...applicant };
    await persistKnownBookingInputs(session.applicant).catch(() => {});
  }

  const model = await snapshotFormModel(session.page);
  const prefilled = await attemptPrefill(session.page, model, session.applicant || {});
  const replayPrefill = await runReplayDrivenPrefill(session.page, session, model, session.applicant || {});
  let resumedModel = replayPrefill?.filled?.length ? await snapshotFormModel(session.page) : model;
  if (isLikelyNonBookingFormModel(resumedModel) || (resumedModel?.forms?.length || 0) === 0) {
    const replayAttempt = await runLearnedDomReplay(session.page, session, resumedModel, { reason: 'attended-resume-nonbooking' });
    session.replay.candidateCount = Number(session.replay.candidateCount || 0) + Number(replayAttempt?.candidateCount || 0);
    session.replay.failureCount = Number(session.replay.failureCount || 0) + Number(replayAttempt?.failures?.length || 0);
    if ((replayAttempt?.applied || []).length > 0) {
      resumedModel = await snapshotFormModel(session.page);
    } else if ((replayAttempt?.candidateCount || 0) > 0) {
      await recordSessionDomFailure(session, 'attended-resume-replay-failed', { replayCandidateCount: replayAttempt.candidateCount });
    }
  }
  const resumePhase = inferBookingFlowPhase(resumedModel);
  if (!session.submitted && resumePhase?.phaseKey === BOOKING_FLOW_PHASES.APPOINTMENT_DIARY) {
    const autoSelection = await tryAutoSelectAppointmentDateTime(session.page, {
      intentText: session.intentText || session.applicant?.notes || session.applicant?.topic || '',
      applicant: session.applicant || {},
      maxSelections: 4,
    }).catch(() => ({ applied: false, selectedOptions: [] }));
    session.autoSelectionAttempts = Number(session.autoSelectionAttempts || 0) + 1;
    session.lastAutoSelectionAt = new Date().toISOString();
    session.appointmentCandidatePreview = Array.isArray(autoSelection?.candidatePreview) ? autoSelection.candidatePreview : [];
    if (autoSelection.applied) {
      session.selectedAppointmentOptions = mergeSelectedAppointmentOptions(session.selectedAppointmentOptions, autoSelection.selectedOptions || []);
      resumedModel = await snapshotFormModel(session.page);
      session.notes.push(`Auto-selection on resume advanced diary step (${autoSelection.selectedOptions?.length || 0} slot click(s)).`);
    }
  }
  const shot = path.join(session.screenshotRoot, `resume-${Date.now()}.png`);
  await session.page.screenshot({ path: shot, fullPage: true });

  updateSessionFlowPhase(session, resumedModel, 'resume');
  session.currentUrl = resumedModel.href;
  session.pageTitle = resumedModel.title;
  session.prefilledFields = prefilled.length + Number(replayPrefill?.filled?.length || 0);
  session.screenshots.push(shot);
  session.antiBotDetected = detectOtpOrCaptchaFromText(resumedModel.pageText).captcha;
  if (!session.submitted) {
    updateSessionCheckpointAndStage(session, resumedModel, { submitted: false, reason: 'session-resume' });
    guardReadyToSubmitState(session, resumedModel, 'attended-resume-non-booking-page');
  }
  session.updatedAt = new Date().toISOString();
  session.updatedAtMs = Date.now();
  await persistAttendedDomLearning(session).catch(() => {});

  return toPublicSession(session, { includeNetwork: false });
}

export async function approveAttendedBookingSubmit(token, { approvedBy = 'human', reason = '' } = {}) {
  const session = attendedSessions.get(String(token || ''));
  if (!session) return { ok: false, error: 'Session not found' };

  session.approval = {
    approved: true,
    approvedAt: new Date().toISOString(),
    approvedBy,
    reason: String(reason || '').trim() || null,
  };
  session.notes.push(`Submit approved by ${approvedBy}${reason ? `: ${reason}` : ''}`);
  if (session.interactionStage !== BOOKING_INTERACTION_STAGES.REVIEW) {
    session.notes.push('Interaction stage transitioned: form -> review (approval granted).');
  }
  session.interactionStage = BOOKING_INTERACTION_STAGES.REVIEW;
  session.updatedAt = new Date().toISOString();
  session.updatedAtMs = Date.now();
  await persistAttendedDomLearning(session).catch(() => {});
  await persistAttendedRequestState(session, {
    bookingCheckpoint: session.state,
    attendedApproval: {
      approved: true,
      approvedAt: session.approval.approvedAt,
      approvedBy,
      reason: session.approval.reason,
    },
    attendedSessionToken: session.token,
    attendedEvent: 'approval-granted',
  });
  return toPublicSession(session, { includeNetwork: false });
}

export async function submitAttendedBookingSession(token) {
  const session = attendedSessions.get(String(token || ''));
  if (!session) return { ok: false, error: 'Session not found' };

  if (!session.approval?.approved) {
    return { ok: false, error: 'Submit blocked: final human approval gate not granted.' };
  }

  const model = await snapshotFormModel(session.page);
  const beforeSnapshot = await captureDebugSnapshot(session.page, session, { label: 'submit:before' }).catch(() => null);
  const currentFlowPhase = inferBookingFlowPhase(model);
  session.flowPhase = currentFlowPhase;
  const inferred = inferCheckpointState({ text: model.pageText, submitted: false, flowPhase: currentFlowPhase });
  if ([CHECKPOINT_STATES.AWAITING_LOGIN, CHECKPOINT_STATES.AWAITING_OTP, CHECKPOINT_STATES.AWAITING_CAPTCHA, CHECKPOINT_STATES.AWAITING_HUMAN].includes(inferred)) {
    session.state = inferred;
    session.notes.push(`Submit blocked: checkpoint state is ${inferred}`);
    session.updatedAt = new Date().toISOString();
    session.updatedAtMs = Date.now();
    return toPublicSession(session, { includeNetwork: false });
  }

  const clickResult = await clickSubmitAcrossPage(session.page);
  await session.page.waitForTimeout(2500);
  const postModel = await snapshotFormModel(session.page);
  const postFlowPhase = inferBookingFlowPhase(postModel);
  session.flowPhase = postFlowPhase;
  const postState = inferCheckpointState({ text: postModel.pageText, submitted: false, flowPhase: postFlowPhase });
  const shot = path.join(session.screenshotRoot, `submit-${Date.now()}.png`);
  await session.page.screenshot({ path: shot, fullPage: true });

  session.currentUrl = postModel.href;
  session.pageTitle = postModel.title;
  session.screenshots.push(shot);
  session.antiBotDetected = detectOtpOrCaptchaFromText(postModel.pageText).captcha;
  session.submitted = Boolean(clickResult.clicked) && ![CHECKPOINT_STATES.AWAITING_OTP, CHECKPOINT_STATES.AWAITING_CAPTCHA, CHECKPOINT_STATES.AWAITING_LOGIN, CHECKPOINT_STATES.AWAITING_HUMAN].includes(postState);
  session.confirmation = extractBookingConfirmationEvidence(postModel);
  updateSessionCheckpointAndStage(session, postModel, { submitted: session.submitted, reason: 'submit-attempt' });
  session.notes.push(clickResult.clicked ? `Submit attempt via ${clickResult.via}` : 'No submit control found');
  if (session.submitted && session.confirmation?.detected) {
    session.notes.push(`Booking confirmation detected${session.confirmation.confirmationId ? ` (id: ${session.confirmation.confirmationId})` : ''}.`);
  }
  session.updatedAt = new Date().toISOString();
  session.updatedAtMs = Date.now();
  if (!clickResult.clicked) {
    await recordSessionDomFailure(session, 'attended-submit-dom-failed', { submitAttempted: false });
  }
  await recordDebugTransition(session, session.page, {
    type: 'submit',
    action: 'submit-booking',
    stage: session.interactionStage || BOOKING_INTERACTION_STAGES.SUBMIT,
    status: session.submitted ? 'applied' : 'failed',
    beforeSnapshot,
    reason: session.submitted ? 'submit-completed' : 'submit-incomplete',
    errorBucket: session.submitted ? null : classifyErrorBucket(clickResult?.via || 'submit-incomplete'),
    metadata: { via: clickResult.via || null, clicked: Boolean(clickResult.clicked) },
  }).catch(() => {});
  await persistAttendedDomLearning(session).catch(() => {});
  await persistAttendedRequestState(session, {
    bookingCheckpoint: session.state,
    attendedApproval: {
      approved: Boolean(session.approval?.approved),
      approvedAt: session.approval?.approvedAt || null,
      approvedBy: session.approval?.approvedBy || null,
      reason: session.approval?.reason || null,
    },
    attendedSessionToken: session.token,
    attendedEvent: session.submitted ? 'submit-completed' : 'submit-attempted',
  });

  return toPublicSession(session, { includeNetwork: false });
}

export async function callAttendedSessionInternalEndpoint(token, { url, method = 'GET', body = null, headers = {} } = {}) {
  const session = attendedSessions.get(String(token || ''));
  if (!session) return { ok: false, error: 'Session not found' };
  if (!url || !/^https?:\/\//i.test(String(url))) {
    return { ok: false, error: 'Absolute URL is required' };
  }

  const result = await session.page.evaluate(async ({ u, m, b, h }) => {
    try {
      const response = await fetch(u, {
        method: m,
        headers: h || {},
        body: b != null ? (typeof b === 'string' ? b : JSON.stringify(b)) : undefined,
        credentials: 'include',
      });
      const text = await response.text();
      return {
        ok: true,
        status: response.status,
        statusText: response.statusText,
        bodyPreview: String(text || '').slice(0, 2000),
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, { u: String(url), m: String(method || 'GET').toUpperCase(), b: body, h: headers || {} });

  session.notes.push(`Internal endpoint call: ${method} ${url} -> ${result.status || 'error'}`);
  session.updatedAt = new Date().toISOString();
  session.updatedAtMs = Date.now();
  await persistAttendedDomLearning(session).catch(() => {});
  return result;
}

export async function stopAttendedBookingSession(token, { reason = '' } = {}) {
  const session = attendedSessions.get(String(token || ''));
  if (!session) return { ok: false, error: 'Session not found' };

  session.state = CHECKPOINT_STATES.STOPPED;
  session.notes.push(`Session stopped${reason ? `: ${reason}` : ''}`);
  session.updatedAt = new Date().toISOString();
  session.updatedAtMs = Date.now();

  try {
    await persistAttendedDomLearning(session).catch(() => {});
    await session.context?.close();
  } catch {
  }
  attendedSessions.delete(session.token);
  return { ok: true, token: session.token, state: CHECKPOINT_STATES.STOPPED };
}

export async function runTelAvivBrowserBooking({
  bookingUrl = DEFAULT_BOOKING_URL,
  applicant = {},
  intentText = '',
  dryRun = true,
  confirmedSubmit = false,
  headless = false,
  timeoutMs = 90000,
  screenshotRoot = path.resolve(process.cwd(), 'tmp', 'browser-booking'),
} = {}) {
  const startedAt = Date.now();
  await ensureDir(screenshotRoot);
  await persistKnownBookingInputs(applicant).catch(() => {});

  const stealth = buildStealthContextOptions(`${bookingUrl}:${intentText}`);

  const browser = await chromium.launch({ headless: Boolean(headless) });
  const context = await browser.newContext(stealth.contextOptions);
  const page = await context.newPage();
  await applyStealthLite(page, stealth.identity);

  try {
    await page.goto(bookingUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(1200);

    const telAvivAdvance = isTelAvivAppointmentsUrl(bookingUrl)
      ? await tryAdvanceTelAvivFlow(page, {
        bookingUrl,
        intentText: intentText || applicant?.notes || applicant?.topic || '',
        applicant,
        mode: 'booking',
        maxSteps: 3,
      })
      : { steps: [] };

    const landingShot = path.join(screenshotRoot, `landing-${Date.now()}.png`);
    await page.screenshot({ path: landingShot, fullPage: true });

    let model = await snapshotFormModel(page);
    const scrapeSnapshot = await scrapePageRelevanceSnapshot(page, { intentText, applicant });
    let navigationHint = null;
    if (isLikelyNonBookingFormModel(model)) {
      const nav = await tryNavigateToAppointmentFlow(page, model.href || bookingUrl, intentText || applicant?.notes || applicant?.topic || '', scrapeSnapshot);
      if (nav.moved) {
        navigationHint = nav;
        model = await snapshotFormModel(page);
      }
    }
    const flags = detectOtpOrCaptchaFromText(model.pageText || '');
    const prefilled = await attemptPrefill(page, model, applicant);

    const prefillShot = path.join(screenshotRoot, `prefilled-${Date.now()}.png`);
    await page.screenshot({ path: prefillShot, fullPage: true });

    if (flags.captcha || flags.otp) {
      return {
        ok: true,
        stage: 'human-verification-required',
        requiresHuman: true,
        reason: flags.captcha ? 'captcha-detected' : 'otp-detected',
        bookingUrl,
        finalUrl: model.href,
        pageTitle: model.title,
        formsDiscovered: model.forms.length,
        prefilledFields: prefilled.length,
        advanceSteps: telAvivAdvance.steps,
        navigationHint,
        scrapeSignals: scrapeSnapshot.ok ? {
          keptItems: scrapeSnapshot.keptItems,
          droppedItems: scrapeSnapshot.droppedItems,
          hasAppointmentSignal: scrapeSnapshot.hasAppointmentSignal,
          hasArnonaSignal: scrapeSnapshot.hasArnonaSignal,
        } : null,
        screenshots: [landingShot, prefillShot],
        elapsedMs: Date.now() - startedAt,
      };
    }

    if (dryRun || !confirmedSubmit) {
      return {
        ok: true,
        stage: 'prefill-complete',
        submitted: false,
        requiresHuman: true,
        reason: dryRun ? 'dry-run' : 'confirmedSubmit=false',
        bookingUrl,
        finalUrl: model.href,
        pageTitle: model.title,
        formsDiscovered: model.forms.length,
        prefilledFields: prefilled.length,
        advanceSteps: telAvivAdvance.steps,
        navigationHint,
        scrapeSignals: scrapeSnapshot.ok ? {
          keptItems: scrapeSnapshot.keptItems,
          droppedItems: scrapeSnapshot.droppedItems,
          hasAppointmentSignal: scrapeSnapshot.hasAppointmentSignal,
          hasArnonaSignal: scrapeSnapshot.hasArnonaSignal,
        } : null,
        screenshots: [landingShot, prefillShot],
        formModel: model.forms,
        elapsedMs: Date.now() - startedAt,
      };
    }

    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("קבע")',
      'button:has-text("זימון")',
      'button:has-text("שליחה")',
      'button:has-text("Submit")',
      'button:has-text("Book")',
    ];

    let submitted = false;
    for (const selector of submitSelectors) {
      const loc = page.locator(selector).first();
      if (await loc.count()) {
        await loc.click({ timeout: 5000 }).catch(() => {});
        submitted = true;
        break;
      }
    }

    await page.waitForTimeout(2500);
    const submittedShot = path.join(screenshotRoot, `submitted-${Date.now()}.png`);
    await page.screenshot({ path: submittedShot, fullPage: true });

    const postModel = await snapshotFormModel(page);
    const postFlags = detectOtpOrCaptchaFromText(postModel.pageText || '');

    return {
      ok: true,
      stage: submitted ? 'submitted' : 'submit-button-not-found',
      submitted,
      requiresHuman: postFlags.captcha || postFlags.otp,
      reason: postFlags.captcha ? 'captcha-after-submit' : (postFlags.otp ? 'otp-after-submit' : null),
      bookingUrl,
      finalUrl: postModel.href,
      pageTitle: postModel.title,
      formsDiscovered: postModel.forms.length,
      prefilledFields: prefilled.length,
      advanceSteps: telAvivAdvance.steps,
      navigationHint,
      screenshots: [landingShot, prefillShot, submittedShot],
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

export async function runTelAvivFullyAutomatedBooking({
  requestId = null,
  bookingUrl = DEFAULT_BOOKING_URL,
  applicant = {},
  intentText = '',
  headless = true,
  timeoutMs = 90000,
  maxRuntimeMs = 240000,
  pollIntervalMs = 2500,
  keepSessionOnFailure = true,
  allowHumanIntervention = true,
  humanInterventionTimeoutMs = 300000,
  requireFinalHumanApproval = false,
  autoApproveValidatedSubmit = false,
} = {}) {
  const startedAt = Date.now();
  const withAgentDebug = (payload = {}, sessionPayload = null) => ({
    ...payload,
    agentDebug: buildAgentDebugView(sessionPayload || payload?.session || {}, {
      elapsedMs: Date.now() - startedAt,
      mode: payload?.mode || 'autonomous-browser-agent',
    }),
  });

  // Merge saved credentials (applicant fields take precedence over saved creds)
  const savedCreds = await loadBookingCredentials();
  const mergedApplicant = {
    ...(savedCreds ? {
      loginUsername: savedCreds.loginUsername,
      loginPassword: savedCreds.loginPassword,
      otpCode: savedCreds.otpCode,
      otpPolicy: savedCreds.otpPolicy,
      totpSecret: savedCreds.totpSecret,
      ...(savedCreds.applicantProfile || {}),
    } : {}),
    ...(applicant || {}),
  };
  await persistKnownBookingInputs(mergedApplicant).catch(() => {});

  const session = await startAttendedBookingSession({
    requestId,
    bookingUrl,
    applicant: mergedApplicant,
    intentText,
    headless,
    timeoutMs,
  });

  let finalSession = session;
  let failureReason = 'max-runtime-exceeded';

  try {
    async function waitForHumanCheckpointClear(expectedState, reasonLabel) {
      const timeoutAt = Date.now() + Math.max(30000, Number(humanInterventionTimeoutMs) || 300000);
      while (Date.now() < timeoutAt) {
        await sleep(Math.max(800, Number(pollIntervalMs) || 2500));
        const status = await getAttendedBookingSessionStatus(session.token, { includeNetwork: false }).catch(() => null);
        const state = String(status?.state || '').toLowerCase();
        if (!state || state !== String(expectedState || '').toLowerCase()) {
          return { cleared: true, state: status?.state || null, status };
        }
      }
      return { cleared: false, state: expectedState, reason: `${reasonLabel || 'checkpoint'}-timeout` };
    }

    while (Date.now() - startedAt < Math.max(10000, Number(maxRuntimeMs) || 240000)) {
      finalSession = await getAttendedBookingSessionStatus(session.token, { includeNetwork: false });
      const state = String(finalSession?.state || '').toLowerCase();

      if (state === CHECKPOINT_STATES.SUBMITTED) {
        await stopAttendedBookingSession(session.token, { reason: 'autonomous-success' }).catch(() => {});
        return withAgentDebug({
          ok: true,
          mode: 'autonomous-browser-agent',
          automated: true,
          submitted: true,
          requiresHuman: false,
          session: { ...finalSession, state: CHECKPOINT_STATES.SUBMITTED },
          elapsedMs: Date.now() - startedAt,
        }, { ...finalSession, state: CHECKPOINT_STATES.SUBMITTED });
      }

      if (state === CHECKPOINT_STATES.AWAITING_CAPTCHA) {
        if (allowHumanIntervention && !headless) {
          const waitResult = await waitForHumanCheckpointClear(CHECKPOINT_STATES.AWAITING_CAPTCHA, 'captcha');
          if (waitResult.cleared) {
            continue;
          }
          failureReason = waitResult.reason || 'captcha-detected';
          break;
        }
        failureReason = 'captcha-detected';
        break;
      }

      if (state === CHECKPOINT_STATES.AWAITING_LOGIN) {
        const live = attendedSessions.get(session.token);
        const loginStep = await tryAutoLoginStep(live);
        if (!loginStep.acted) {
          if (allowHumanIntervention && !headless) {
            const waitResult = await waitForHumanCheckpointClear(CHECKPOINT_STATES.AWAITING_LOGIN, 'login');
            if (waitResult.cleared) {
              continue;
            }
          }
          failureReason = loginStep.reason || 'login-unresolved';
          break;
        }
        live?.notes?.push('Automation advanced login stage; waiting for OTP or form checkpoint.');
        await sleep(pollIntervalMs);
        continue;
      }

      if (state === CHECKPOINT_STATES.AWAITING_OTP) {
        const live = attendedSessions.get(session.token);
        const otpStep = await tryAutoOtpStep(live);
        if (!otpStep.acted) {
          if (allowHumanIntervention && !headless) {
            const waitResult = await waitForHumanCheckpointClear(CHECKPOINT_STATES.AWAITING_OTP, 'otp');
            if (waitResult.cleared) {
              continue;
            }
          }
          failureReason = otpStep.reason || 'otp-unresolved';
          break;
        }
        live?.notes?.push('Automation advanced OTP stage; waiting for form or review checkpoint.');
        await sleep(pollIntervalMs);
        continue;
      }

      if (state === CHECKPOINT_STATES.AWAITING_HUMAN) {
        const live = attendedSessions.get(session.token);
        const liveFlowPhase = finalSession?.flowPhase?.phaseKey || live?.flowPhase?.phaseKey || null;
        if (String(liveFlowPhase || '').toLowerCase() === BOOKING_FLOW_PHASES.APPOINTMENT_DIARY && live?.page) {
          const autoSelection = await tryAutoSelectAppointmentDateTime(live.page, {
            intentText: intentText || mergedApplicant?.notes || mergedApplicant?.topic || '',
            applicant: mergedApplicant,
            maxSelections: 4,
          }).catch(() => ({ applied: false, selectedOptions: [] }));

          live.autoSelectionAttempts = Number(live.autoSelectionAttempts || 0) + 1;
          live.lastAutoSelectionAt = new Date().toISOString();
          live.appointmentCandidatePreview = Array.isArray(autoSelection?.candidatePreview) ? autoSelection.candidatePreview : [];

          if (autoSelection.applied) {
            live.selectedAppointmentOptions = mergeSelectedAppointmentOptions(live.selectedAppointmentOptions, autoSelection.selectedOptions || []);
            live.notes?.push(`Autonomous diary retry advanced selection (selected=${autoSelection.selectedOptions?.length || 0}, continue=${autoSelection.continuationClicked ? 'yes' : 'no'}).`);
            await sleep(Math.max(900, Number(pollIntervalMs) || 2500));
            continue;
          }
        }

        return withAgentDebug({
          ok: true,
          mode: 'autonomous-browser-agent',
          automated: true,
          submitted: false,
          requiresHuman: true,
          reason: finalSession?.flowPhase?.phaseKey
            ? `flow-phase-${finalSession.flowPhase.phaseKey}`
            : (finalSession?.hitlReason || 'human-checkpoint-required'),
          session: finalSession,
          elapsedMs: Date.now() - startedAt,
        }, finalSession);
      }

      if (state === CHECKPOINT_STATES.READY_TO_SUBMIT) {
        if (requireFinalHumanApproval) {
          if (autoApproveValidatedSubmit) {
            const live = attendedSessions.get(session.token);
            if (live?.page) {
              const liveModel = await snapshotFormModel(live.page).catch(() => null);
              if (liveModel) {
                const validation = await verifyRequiredFormFieldsFilled(live.page, liveModel, mergedApplicant).catch(() => null);
                if (validation) {
                  live.finalValidation = validation;
                  live.notes?.push(`Final form validation: required=${validation.totalRequired}, missing=${validation.missingRequired}, mismatches=${validation.expectedMismatches}.`);
                }
                if (validation?.ok) {
                  await approveAttendedBookingSubmit(session.token, { approvedBy: 'autonomous-validator', reason: 'validated-required-fields-before-submit' });
                  finalSession = await submitAttendedBookingSession(session.token);
                  if (String(finalSession?.state || '').toLowerCase() === CHECKPOINT_STATES.SUBMITTED) {
                    await stopAttendedBookingSession(session.token, { reason: 'autonomous-success' }).catch(() => {});
                    return withAgentDebug({
                      ok: true,
                      mode: 'autonomous-browser-agent',
                      automated: true,
                      submitted: true,
                      requiresHuman: false,
                      session: { ...finalSession, state: CHECKPOINT_STATES.SUBMITTED },
                      elapsedMs: Date.now() - startedAt,
                    }, { ...finalSession, state: CHECKPOINT_STATES.SUBMITTED });
                  }
                }
              }
            }
          }
          finalSession = await getAttendedBookingSessionStatus(session.token, { includeNetwork: false });
          return withAgentDebug({
            ok: true,
            mode: 'autonomous-browser-agent',
            automated: true,
            submitted: false,
            requiresHuman: true,
            reason: 'final-human-approval-required',
            session: finalSession,
            elapsedMs: Date.now() - startedAt,
          }, finalSession);
        }
        await approveAttendedBookingSubmit(session.token, { approvedBy: 'autonomous-system', reason: 'auto-approve ready_to_submit' });
        finalSession = await submitAttendedBookingSession(session.token);
        if (String(finalSession?.state || '').toLowerCase() === CHECKPOINT_STATES.SUBMITTED) {
          await stopAttendedBookingSession(session.token, { reason: 'autonomous-success' }).catch(() => {});
          return withAgentDebug({
            ok: true,
            mode: 'autonomous-browser-agent',
            automated: true,
            submitted: true,
            requiresHuman: false,
            session: { ...finalSession, state: CHECKPOINT_STATES.SUBMITTED },
            elapsedMs: Date.now() - startedAt,
          }, { ...finalSession, state: CHECKPOINT_STATES.SUBMITTED });
        }
      }

      await sleep(pollIntervalMs);
    }

    finalSession = await getAttendedBookingSessionStatus(session.token, { includeNetwork: false }).catch(() => finalSession);
    const response = {
      ok: true,
      mode: 'autonomous-browser-agent',
      automated: true,
      submitted: false,
      requiresHuman: true,
      reason: failureReason,
      session: finalSession,
      elapsedMs: Date.now() - startedAt,
    };

    if (!keepSessionOnFailure) {
      await stopAttendedBookingSession(session.token, { reason: `autonomous-failure:${failureReason}` }).catch(() => {});
      response.session = { ...(response.session || {}), state: CHECKPOINT_STATES.STOPPED };
    }

    return withAgentDebug(response, response.session);
  } catch (err) {
    if (!keepSessionOnFailure) {
      await stopAttendedBookingSession(session.token, { reason: `autonomous-error:${err.message}` }).catch(() => {});
    }
    return withAgentDebug({
      ok: false,
      mode: 'autonomous-browser-agent',
      automated: true,
      error: err?.message || String(err),
      session: finalSession,
      elapsedMs: Date.now() - startedAt,
    }, finalSession);
  }
}

// ─── Network Inspection ───────────────────────────────────────────────────────
// Opens a headless browser, navigates to the Tel Aviv booking page,
// captures all outbound XHR/fetch/api requests, scrapes the page,
// and returns a structured report. Used by the probe pipeline.

export async function inspectBookingSiteNetwork({
  bookingUrl = DEFAULT_BOOKING_URL,
  intentText = 'arnona appointment',
  applicant = {},
  timeoutMs = 60000,
  headless = true,
  maxNetworkEntries = 200,
  autonomousBrowse = false,
  maxAutonomousSteps = 3,
  waitAfterNavigationMs = 1800,
  jsScanTimeoutMs = 30000,
  endpointHarvesting = {},
} = {}) {
  const startedAt = Date.now();
  const networkLog = [];
  const apiResponsePreviews = [];
  const responseReadTasks = [];
  const harvesting = normalizeEndpointHarvestingOptions({
    ...(endpointHarvesting || {}),
    jsScanTimeoutMs: endpointHarvesting?.jsScanTimeoutMs ?? jsScanTimeoutMs,
  });
  const discoveryDeadlineAt = startedAt + Math.max(5000, Number(harvesting.apiDiscoveryDeadlineMs || timeoutMs || 60000));

  const stealth = buildStealthContextOptions(`${bookingUrl}:${intentText}`);

  const browser = await chromium.launch({ headless: Boolean(headless) });
  const context = await browser.newContext(stealth.contextOptions);
  const page = await context.newPage();
  await applyStealthLite(page, stealth.identity);

  page.on('request', (req) => {
    const entry = serializeNetworkEntry({
      ts: new Date().toISOString(),
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      from: 'request',
    });
    if (['xhr', 'fetch'].includes(entry.resourceType) || /\/api\//i.test(entry.url) || /\.json/i.test(entry.url)) {
      networkLog.push(entry);
    }
    if (looksLikeApiUrl(entry.url)) {
      networkLog.push({ ...entry, matchedBy: 'api-request-listener' });
    }
  });

  page.on('response', (res) => {
    const req = res.request();
    const resourceType = req?.resourceType?.() || '';
    const responseUrl = res.url();
    if (['xhr', 'fetch'].includes(resourceType) || /\/api\//i.test(responseUrl) || /\.json/i.test(responseUrl) || looksLikeApiUrl(responseUrl)) {
      networkLog.push(serializeNetworkEntry({
        ts: new Date().toISOString(),
        method: req?.method?.() || '',
        url: responseUrl,
        resourceType,
        status: res.status(),
        ok: res.ok(),
        from: 'response',
      }));

      if (apiResponsePreviews.length < 12 && looksLikeApiUrl(responseUrl)) {
        responseReadTasks.push((async () => {
          try {
            const bodyText = await res.text();
            apiResponsePreviews.push({
              url: responseUrl,
              method: req?.method?.() || '',
              status: res.status(),
              ok: res.ok(),
              contentType: res.headers()['content-type'] || '',
              preview: String(bodyText || '').slice(0, 1200),
            });
          } catch (error) {
            apiResponsePreviews.push({
              url: responseUrl,
              method: req?.method?.() || '',
              status: res.status(),
              ok: res.ok(),
              contentType: res.headers()['content-type'] || '',
              preview: '',
              error: error?.message || String(error),
            });
          }
        })());
      }
    }
  });

  try {
    await page.goto(bookingUrl, { waitUntil: 'domcontentloaded', timeout: Math.max(8000, Math.min(Number(timeoutMs) || 60000, Number(harvesting.apiDiscoveryDeadlineMs || 60000))) });
    await page.waitForTimeout(2000);

    let lastScrapeSnapshot = await scrapePageRelevanceSnapshot(page, { intentText, applicant });
    let currentModel = await snapshotFormModel(page);
    const visited = [];
    const seenUrls = new Set();
    const maxSteps = autonomousBrowse ? Math.max(1, Math.min(8, Number(maxAutonomousSteps) || 3)) : 1;
    const selfHealingHits = [];
    const host = (() => {
      try { return new URL(String(bookingUrl || '')).host || ''; } catch { return ''; }
    })();
    let selectorLearningStore = harvesting.selfLearningSelectors ? await readSelectorHealingLearningStore() : { hosts: {} };
    const learnedSelectors = getLearnedHealingSelectorsForHost(selectorLearningStore, host, 10);
    const selfHealingSelectors = Array.from(new Set([...learnedSelectors, ...getDefaultHealingSelectors(intentText)]));

    if (harvesting.selfHealingSelectors && (isLikelyNonBookingFormModel(currentModel) || (currentModel?.forms?.length || 0) === 0)) {
      const heal = await trySelfHealingSelectorPass(page, { selectors: selfHealingSelectors, timeoutPerSelectorMs: harvesting.browserAutomationHarvesting ? 900 : 1500 });
      if (heal?.clicked) {
        selfHealingHits.push({ ...heal, step: 'initial', at: new Date().toISOString() });
        await page.waitForTimeout(700);
        currentModel = await snapshotFormModel(page);
        lastScrapeSnapshot = await scrapePageRelevanceSnapshot(page, { intentText, applicant });
      }
    }

    for (let step = 0; step < maxSteps; step += 1) {
      if (Date.now() >= discoveryDeadlineAt) break;
      const currentUrl = currentModel?.href || page.url();
      if (!seenUrls.has(currentUrl)) {
        seenUrls.add(currentUrl);
        visited.push({
          step,
          url: currentUrl,
          title: currentModel?.title || '',
          formsDiscovered: Array.isArray(currentModel?.forms) ? currentModel.forms.length : 0,
          hasAppointmentSignal: Boolean(lastScrapeSnapshot?.hasAppointmentSignal),
          hasArnonaSignal: Boolean(lastScrapeSnapshot?.hasArnonaSignal),
        });
      }

      const shouldTryNavigate = isLikelyNonBookingFormModel(currentModel) || autonomousBrowse;
      if (!shouldTryNavigate || step >= maxSteps - 1) break;

      if (harvesting.selfHealingSelectors && isLikelyNonBookingFormModel(currentModel)) {
        const heal = await trySelfHealingSelectorPass(page, { selectors: selfHealingSelectors, timeoutPerSelectorMs: harvesting.browserAutomationHarvesting ? 900 : 1500 });
        if (heal?.clicked) {
          selfHealingHits.push({ ...heal, step, at: new Date().toISOString() });
          await page.waitForTimeout(500);
          currentModel = await snapshotFormModel(page);
          lastScrapeSnapshot = await scrapePageRelevanceSnapshot(page, { intentText, applicant });
          if (!isLikelyNonBookingFormModel(currentModel)) continue;
        }
      }

      const nav = await tryNavigateToAppointmentFlow(page, currentUrl || bookingUrl, intentText, lastScrapeSnapshot).catch(() => ({ moved: false }));
      if (!nav?.moved || !nav?.url || seenUrls.has(nav.url)) break;

      await page.waitForTimeout(Math.max(500, Number(waitAfterNavigationMs) || 1800));
      currentModel = await snapshotFormModel(page);
      lastScrapeSnapshot = await scrapePageRelevanceSnapshot(page, { intentText, applicant });
    }

    const finalModel = await snapshotFormModel(page);
    const pageAnalysis = await capturePageAnalysis(page);
    const htmlSource = await page.content().catch(() => '');
    const htmlRegexJsFiles = extractJsFilesFromHtmlRegex(htmlSource, page.url());
    const workerCandidatesFromHtml = extractWorkerPathCandidates(htmlSource, page.url());
    const workerCandidatesFromPreview = extractWorkerPathCandidates(pageAnalysis?.pageSourcePreview || '', page.url());
    const serviceWorkerCandidates = Array.from(new Set([
      ...workerCandidatesFromHtml,
      ...workerCandidatesFromPreview,
    ])).slice(0, 60);

    const javascriptScan = harvesting.includeJsInspection
      ? await scanJavaScriptFilesForApiPaths({
        scriptUrls: [...(pageAnalysis?.scriptUrls || []), ...htmlRegexJsFiles],
        workerScriptUrls: harvesting.includeWorkerScan ? serviceWorkerCandidates : [],
        baseUrl: page.url(),
        timeoutMs: Math.max(1000, Math.min(harvesting.jsScanTimeoutMs, Math.max(1000, discoveryDeadlineAt - Date.now()))),
        maxFiles: harvesting.maxJsFiles,
        maxCharsPerFile: harvesting.maxJsChars,
        strategy: harvesting.strategy,
      })
      : {
        ok: true,
        skipped: true,
        reason: 'endpoint-harvesting-js-inspection-disabled',
        strategy: harvesting.strategy,
        endpoints: [],
        scannedFiles: [],
        workerScripts: [],
        discoverAPIWebWorkers: [],
      };
    if (harvesting.selfLearningSelectors && host && selfHealingHits.length > 0) {
      for (const hit of selfHealingHits) {
        selectorLearningStore = noteHealingSelectorSuccess(selectorLearningStore, host, String(hit.selector || ''));
      }
      await writeSelectorHealingLearningStore(selectorLearningStore);
    }
    await Promise.allSettled(responseReadTasks);
    const pageSourceApiMatches = extractApiPathCandidates(pageAnalysis?.pageSourcePreview || '', page.url());
    const urlPatternExploration = buildUrlPatternExploration({
      bookingUrl,
      visited,
      networkLog,
      pageAnalysis,
      finalModel,
    });

    const apiCandidates = networkLog
      .filter((e) => e.from === 'response' && e.status && e.status < 400)
      .slice(0, maxNetworkEntries);

    return {
      ok: true,
      bookingUrl,
      finalUrl: finalModel.href,
      pageTitle: finalModel.title,
      scrapeSignals: {
        keptItems: lastScrapeSnapshot.keptItems,
        droppedItems: lastScrapeSnapshot.droppedItems,
        hasAppointmentSignal: lastScrapeSnapshot.hasAppointmentSignal,
        hasArnonaSignal: lastScrapeSnapshot.hasArnonaSignal,
        textPreview: lastScrapeSnapshot.textPreview?.slice(0, 600),
      },
      formsDiscovered: finalModel.forms?.length || 0,
      traversal: {
        autonomousBrowse: Boolean(autonomousBrowse),
        maxAutonomousSteps: maxSteps,
        visited,
      },
      pageAnalysis: {
        buttons: pageAnalysis?.buttonTexts || [],
        forms: pageAnalysis?.formActions || [],
        scriptUrls: pageAnalysis?.scriptUrls || [],
        htmlRegexScriptUrls: htmlRegexJsFiles,
        serviceWorker: pageAnalysis?.serviceWorker || { supported: false, controller: false },
        serviceWorkerCandidates,
        sourceApiMatches: pageSourceApiMatches,
      },
      browserAgent: {
        flow: ['User request', 'Agent opens website', 'Agent analyzes page', 'Agent finds form/API', 'Agent performs action'],
        layers: ['LLM', 'planner', 'browser controller', 'action executor'],
        systemGoalFlow: ['system goal: user question', 'agent reasoning', 'data query OR action', 'browser automation', 'find javascript files', 'scan for api paths', 'print endpoints'],
      },
      endpointHarvesting: {
        ...harvesting,
      },
      selfHealing: {
        enabled: Boolean(harvesting.selfHealingSelectors),
        attemptedSelectors: selfHealingSelectors.slice(0, 20),
        successfulHits: selfHealingHits,
      },
      urlPatternExploration,
      apiResponsePreviews: apiResponsePreviews.slice(0, 12),
      automatedNetworkLogging: {
        enabled: true,
        apiLikeEntries: networkLog.filter((entry) => looksLikeApiUrl(entry.url)).slice(0, maxNetworkEntries),
      },
      javascriptScan,
      networkRequests: apiCandidates,
      networkCount: networkLog.length,
      systemGoal: {
        summary: 'An AI agent capable of understanding a completely new website in under a minute and automatically discovering all forms and APIs.',
        underMinuteTargetMs: harvesting.browserAutomationHarvesting ? Math.min(60000, harvesting.apiDiscoveryDeadlineMs) : 60000,
        underTwentySecondTargetMs: 20000,
        elapsedMs: Date.now() - startedAt,
        metUnderMinuteTarget: (Date.now() - startedAt) <= 60000,
        metUnderTwentySecondTarget: (Date.now() - startedAt) <= 20000,
      },
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      bookingUrl,
      error: err?.message || String(err),
      networkRequests: networkLog.slice(0, maxNetworkEntries),
      networkCount: networkLog.length,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// ─── LLM-Driven DOM Selector Healing (exported) ──────────────────────────────

/**
 * Try CSS selectors on a Playwright page.
 * If all known selectors fail, ask the LLM to inspect the DOM and suggest new ones.
 * Automatically writes successful selectors back to the per-host learning store.
 *
 * @param {object} page              - Playwright Page instance (must be open)
 * @param {object} opts
 * @param {string}   opts.intent     - What we are clicking ("book appointment", "submit form")
 * @param {string[]} opts.selectors  - CSS selectors to try first
 * @param {number}   [opts.timeoutPerSelectorMs] - ms per selector attempt
 * @param {string}   [opts.openaiApiKey]         - OpenAI key; required for LLM fallback
 * @param {string}   [opts.host]                 - Host key for selector learning store
 * @returns {Promise<{clicked:boolean, selector:string|null, mode:string, llmHealing:object|null}>}
 */
export async function trySelectorHealWithLLMFallback(page, {
  intent = 'find and click the booking element',
  selectors = [],
  timeoutPerSelectorMs = 1500,
  openaiApiKey = process.env.OPENAI_API_KEY || '',
  host = '',
  record = null,
} = {}) {
  const url = page.url();
  const learnedSelectors = host
    ? getLearnedHealingSelectorsForHost(await readSelectorHealingLearningStore().catch(() => ({ hosts: {} })), host, 8)
    : [];
  const selectorPlan = buildSelectorExecutionPlan({
    intent,
    record,
    providedSelectors: selectors,
    learnedSelectors,
  });

  const apiReplay = await trySelectorListClick(page, selectorPlan.apiSelectors, {
    timeoutPerSelectorMs,
    mode: 'api-selector',
  });
  if (apiReplay.clicked) return { ...apiReplay, llmHealing: null };

  const roleReplay = await tryRoleBasedSelectorPass(page, selectorPlan.roleHints, { timeoutPerSelectorMs });
  if (roleReplay.clicked) return { ...roleReplay, llmHealing: null };

  const textReplay = await trySelectorListClick(page, selectorPlan.textSelectors, {
    timeoutPerSelectorMs,
    mode: 'text-based-selector',
  });
  if (textReplay.clicked) return { ...textReplay, llmHealing: null };

  const heuristicReplay = await trySelectorListClick(page, selectorPlan.heuristicSelectors, {
    timeoutPerSelectorMs,
    mode: 'heuristic-selector',
  });
  if (heuristicReplay.clicked) return { ...heuristicReplay, llmHealing: null };

  // Phase 5 — LLM DOM inspection (self-healing layer)
  if (!openaiApiKey) {
    const embeddingReplay = await tryEmbeddingClickFallback(page, { intent, record });
    if (embeddingReplay.clicked) return { ...embeddingReplay, llmHealing: { skipped: true, reason: 'no_api_key' } };
    return { clicked: false, selector: null, mode: 'no-match', llmHealing: { skipped: true, reason: 'no_api_key' } };
  }

  const cacheKey = buildSelectorHealingCacheKey({ host, intent, selectors: selectorPlan.heuristicSelectors, url });
  const cachedEntry = getSelectorHealingCacheEntry(cacheKey);

  let domSnapshot = '';
  try {
    domSnapshot = await page.evaluate(() => {
      const els = Array.from(
        document.querySelectorAll('button,a,[role="button"],input,select,form,label,[tabindex]'),
      ).slice(0, 300);
      return els.map((el) => {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `id="${el.id}"` : '';
        const cls = el.className ? `class="${String(el.className).trim().split(/\s+/).slice(0, 4).join(' ')}"` : '';
        const role = el.getAttribute('role') ? `role="${el.getAttribute('role')}"` : '';
        const type = el.getAttribute('type') ? `type="${el.getAttribute('type')}"` : '';
        const text = String(el.innerText || el.textContent || el.getAttribute('aria-label') || el.value || '').trim().slice(0, 80);
        return `<${tag} ${[id, cls, role, type].filter(Boolean).join(' ')}>${text}</${tag}>`;
      }).join('\n').slice(0, 7000);
    });
  } catch {
    try { domSnapshot = (await page.content()).slice(0, 7000); } catch { /* ignore */ }
  }

  const prompt = [
    'You are a browser automation expert. A CSS selector cascade failed.',
    `Goal: "${intent}"`,
    selectorPlan.heuristicSelectors.length ? `Already tried and failed: ${selectorPlan.heuristicSelectors.map((s) => `"${s}"`).join(', ')}` : '',
    '',
    'Relevant DOM elements:',
    '```html',
    domSnapshot,
    '```',
    '',
    'Return ONLY a JSON array of 4 CSS selectors, most specific first.',
    'Example: ["#submit-btn", "button.booking-submit", "form button[type=submit]", "button"]',
  ].filter((l) => l !== undefined).join('\n');

  let llmSelectors = Array.isArray(cachedEntry?.selectors) ? cachedEntry.selectors : [];
  let llmResult = cachedEntry?.llmResult || { ok: false, selectors: [], reason: 'not_attempted' };
  if (!cachedEntry) {
    try {
      const { default: OpenAI } = await import('openai');
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
        try {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed)) {
            llmSelectors = parsed.filter((s) => typeof s === 'string' && s.trim()).slice(0, 4);
            llmResult = { ok: true, selectors: llmSelectors, reason: 'llm_suggested', domSnapshotLength: domSnapshot.length };
          }
        } catch { llmResult = { ok: false, reason: 'json_parse_failed' }; }
      }
    } catch (err) {
      llmResult = { ok: false, reason: String(err?.message || err) };
    }
    setSelectorHealingCacheEntry(cacheKey, { selectors: llmSelectors, llmResult });
  }

  // Phase 5 — try LLM-suggested selectors
  for (const selector of llmSelectors) {
    try {
      const locator = page.locator(selector).first();
      if (!(await locator.count())) continue;
      await locator.click({ timeout: Math.max(500, Number(timeoutPerSelectorMs) || 1500) });

      // Persist successful LLM selector to the per-host learning store
      if (host) {
        try {
          const store = await readSelectorHealingLearningStore();
          noteHealingSelectorSuccess(store, host, selector);
          await writeSelectorHealingLearningStore(store);
        } catch { /* non-fatal */ }
      }

      return {
        clicked: true,
        selector,
        mode: 'llm-healed',
        llmHealing: { ...llmResult, usedSelector: selector },
      };
    } catch { /* try next */ }
  }

  const embeddingReplay = await tryEmbeddingClickFallback(page, { intent, record });
  if (embeddingReplay.clicked) {
    return {
      ...embeddingReplay,
      llmHealing: { ...llmResult, usedSelector: null },
    };
  }

  return {
    clicked: false,
    selector: null,
    mode: 'all-failed',
    llmHealing: { ...llmResult, usedSelector: null },
  };
}
