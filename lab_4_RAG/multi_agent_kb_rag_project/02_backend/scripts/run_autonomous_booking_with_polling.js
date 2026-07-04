/**
 * run_autonomous_booking_with_polling.js
 *
 * Enhanced autonomous appointment booking with continuous slot polling and alerts.
 *
 * Features:
 *  - One-time interactive credential collection (saved for future runs)
 *  - Continuous polling for slot availability (configurable interval)
 *  - Console alerts with visual indicators and sounds
 *  - Automatic booking attempt when slots are detected
 *  - Supports arnona/tax payments specifically
 *  - Long-running autonomous operation with heartbeats
 *  - Error recovery and exponential backoff
 *
 * Usage:
 *  npm run local-gov:api:book:autonomous
 *  npm run local-gov:api:book:autonomous -- --interval 30 --max-retries 8 --disable-sound
 *  npm run local-gov:api:book:autonomous -- --category arnona --dry-run
 */

import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

import {
  ensureGovernmentRequestsTable,
  createGovernmentRequest,
} from '../agents/dbTools.js';
import {
  inspectBookingSiteNetwork,
  runTelAvivFullyAutomatedBooking,
  startAttendedBookingSession,
  getAttendedBookingSessionStatus,
  approveAttendedBookingSubmit,
  submitAttendedBookingSession,
  loadBookingCredentials,
  saveBookingCredentials,
} from '../making_operations/local_government/browser_appointment_agent.js';

// ────────────────────────────────────────────────────────────────────────────

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHALLENGE_MEMORY_FILE = path.resolve(process.cwd(), 'tmp', 'booking-challenge-memory.json');

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
function getArgValue(name, fallback = '') {
  const idx = args.lastIndexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return String(args[idx + 1] || '').trim();
  return fallback;
}

const explicitPreferenceOverrides = {
  preferredDate: hasFlag('--preferred-date') || Boolean(String(process.env.APPT_PREFERRED_DATE || '').trim()),
  preferredTime: hasFlag('--preferred-time') || Boolean(String(process.env.APPT_PREFERRED_TIME || '').trim()),
  preferredTimes: hasFlag('--preferred-times') || Boolean(String(process.env.APPT_PREFERRED_TIMES || '').trim()),
  preferredTimeWindow: hasFlag('--preferred-time-window') || Boolean(String(process.env.APPT_PREFERRED_TIME_WINDOW || '').trim()),
  slotSelectionPolicy: hasFlag('--slot-selection-policy') || Boolean(String(process.env.APPT_SLOT_SELECTION_POLICY || '').trim()),
};

function normalizeGaneyBookingUrl(url = '') {
  const raw = String(url || '').trim();
  if (!raw) return raw;
  const lowered = raw.toLowerCase();
  if (!/ganeytikva\.org\.il/.test(lowered)) return raw;
  if (/select-date=1/.test(lowered) || /[?&]id=144\b/.test(lowered)) return raw;
  if (/\/appointments\/?(?:\?.*)?$/.test(lowered)) {
    return 'https://www.ganeytikva.org.il/appointments/?id=144&select-date=1';
  }
  return raw;
}

function normalizePollingIntervalMs(rawValue, fallbackMs = 30000) {
  const raw = Number(rawValue);
  if (!Number.isFinite(raw) || raw <= 0) return fallbackMs;
  const interpretedMs = raw <= 1000 ? raw * 1000 : raw;
  return Math.max(15000, interpretedMs);
}

const VALID_SLOT_SELECTION_POLICIES = new Set([
  'score',
  'earliest',
  'exact-only',
  'window-only',
  'preferred-window-fallback-earliest',
]);

function normalizeTimeToken(raw = '') {
  const input = String(raw || '').trim();
  if (!input) return '';

  const cleaned = input
    .replace(/[\.]/g, ':')
    .replace(/[^0-9:]/g, '')
    .trim();
  if (!cleaned) return '';

  let hours = null;
  let minutes = null;

  if (cleaned.includes(':')) {
    const [h, m = '0'] = cleaned.split(':');
    hours = Number(h);
    minutes = Number(m);
  } else if (/^\d{3,4}$/.test(cleaned)) {
    const padded = cleaned.padStart(4, '0');
    hours = Number(padded.slice(0, 2));
    minutes = Number(padded.slice(2));
  }

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return '';
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return '';
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function normalizeDateInput(raw = '') {
  const input = String(raw || '').trim();
  if (!input) return '';

  const iso = input.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
  if (iso) {
    return `${iso[1]}-${String(Number(iso[2])).padStart(2, '0')}-${String(Number(iso[3])).padStart(2, '0')}`;
  }

  const dmy = input.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/);
  if (!dmy) return '';
  const yearRaw = Number(dmy[3]);
  const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
  if (year < 2000 || year > 2100) return '';
  return `${String(year)}-${String(Number(dmy[2])).padStart(2, '0')}-${String(Number(dmy[1])).padStart(2, '0')}`;
}

function normalizePreferredTimesList(raw = '') {
  const tokens = String(raw || '')
    .split(/[,;|]/)
    .map((item) => normalizeTimeToken(item))
    .filter(Boolean);
  return Array.from(new Set(tokens)).join(',');
}

function normalizeTimeWindow(raw = '') {
  const input = String(raw || '').trim();
  if (!input) return '';
  const parts = input.split(/[-–]/).map((p) => normalizeTimeToken(p));
  if (parts.length !== 2 || !parts[0] || !parts[1]) return '';
  return `${parts[0]}-${parts[1]}`;
}

function sanitizePreferenceInputs(profile = {}) {
  const warnings = [];
  const next = { ...profile };

  const normalizedDate = normalizeDateInput(next.preferredDate || '');
  if (String(next.preferredDate || '').trim() && !normalizedDate) {
    warnings.push('Preferred date was invalid and ignored (expected YYYY-MM-DD or DD/MM/YY).');
  }
  next.preferredDate = normalizedDate;

  const normalizedPreferredTime = normalizeTimeToken(next.preferredTime || '');
  if (String(next.preferredTime || '').trim() && !normalizedPreferredTime) {
    warnings.push('Preferred time was invalid and ignored (expected HH:mm).');
  }
  next.preferredTime = normalizedPreferredTime;

  const normalizedPreferredTimes = normalizePreferredTimesList(next.preferredTimes || '');
  if (String(next.preferredTimes || '').trim() && !normalizedPreferredTimes) {
    warnings.push('Preferred times list had no valid HH:mm values and was ignored.');
  }
  next.preferredTimes = normalizedPreferredTimes;

  const normalizedWindow = normalizeTimeWindow(next.preferredTimeWindow || '');
  if (String(next.preferredTimeWindow || '').trim() && !normalizedWindow) {
    warnings.push('Preferred time window was invalid and ignored (expected HH:mm-HH:mm).');
  }
  next.preferredTimeWindow = normalizedWindow;

  const policyRaw = String(next.slotSelectionPolicy || '').trim().toLowerCase();
  if (!VALID_SLOT_SELECTION_POLICIES.has(policyRaw)) {
    const hasTimePreference = Boolean(next.preferredTime || next.preferredTimes || next.preferredTimeWindow);
    next.slotSelectionPolicy = hasTimePreference ? 'exact-only' : 'score';
    warnings.push(`Slot selection policy was invalid and set to ${next.slotSelectionPolicy}.`);
  } else {
    next.slotSelectionPolicy = policyRaw;
  }

  return { profile: next, warnings };
}

const config = {
  // Booking settings
  websiteUrl: normalizeGaneyBookingUrl(getArgValue('--website-url', process.env.TEL_AVIV_APPOINTMENT_PUBLIC_URL || 'https://www.tel-aviv.gov.il/Contact/Pages/Appointments.aspx')),
  category: getArgValue('--category', process.env.APPT_CATEGORY || 'arnona'),
  userRequest: getArgValue('--request', process.env.APPT_NOTES || 'arnona appointment - check slots and schedule'),
  userId: process.env.APPT_USER_ID || 'cli-autonomous-booking',
  preferredDate: String(getArgValue('--preferred-date', process.env.APPT_PREFERRED_DATE || '') || '').trim(),
  preferredTime: String(getArgValue('--preferred-time', process.env.APPT_PREFERRED_TIME || '') || '').trim(),
  preferredTimes: String(getArgValue('--preferred-times', process.env.APPT_PREFERRED_TIMES || '') || '').trim(),
  preferredTimeWindow: String(getArgValue('--preferred-time-window', process.env.APPT_PREFERRED_TIME_WINDOW || '') || '').trim(),
  slotSelectionPolicy: String(getArgValue('--slot-selection-policy', process.env.APPT_SLOT_SELECTION_POLICY || '') || '').trim().toLowerCase(),
  username: String(getArgValue('--username', process.env.APPT_USERNAME || '') || '').trim(),

  // Polling settings
  pollingIntervalMs: normalizePollingIntervalMs(getArgValue('--interval', process.env.POLLING_INTERVAL_MS || 30000), 30000),
  checkHeartbeatEvery: Math.max(1, Number(getArgValue('--heartbeat', process.env.POLLING_HEARTBEAT || 5)) || 5),
  maxRetries: Math.max(3, Number(getArgValue('--max-retries', process.env.MAX_RETRIES || 8)) || 8),
  maxRuntimeMinutes: Math.max(5, Number(getArgValue('--max-runtime', process.env.MAX_RUNTIME_MINUTES || 120)) || 120),
  maxAutonomousSteps: Math.max(1, Math.min(8, Number(getArgValue('--max-autonomous-steps', process.env.APPT_MAX_AUTONOMOUS_STEPS || 4)) || 4)),
  maxNetworkEntries: Math.max(50, Number(getArgValue('--max-network-entries', process.env.APPT_MAX_NETWORK_ENTRIES || 200)) || 200),
  minSlotConfidence: Math.max(0.35, Math.min(0.95, Number(getArgValue('--slot-confidence-threshold', process.env.APPT_SLOT_CONFIDENCE_THRESHOLD || 0.55)) || 0.55)),
  bookingAttemptMaxRuntimeMs: Math.max(30000, Number(getArgValue('--booking-attempt-timeout-ms', process.env.APPT_BOOKING_ATTEMPT_TIMEOUT_MS || 120000)) || 120000),

  // Alert settings
  enableSound: !hasFlag('--disable-sound') && String(process.env.DISABLE_ALERT_SOUND || 'false').toLowerCase() !== 'true',
  enableVisualAlerts: !hasFlag('--quiet'),

  // Automation settings
  autoBookOnSlots: !hasFlag('--no-auto-book'),
  autoBridgeToHitl: !hasFlag('--disable-auto-bridge-hitl') && String(process.env.APPT_AUTO_BRIDGE_HITL || 'true').toLowerCase() !== 'false',
  bridgeAfterChecks: Math.max(1, Number(getArgValue('--bridge-after-checks', process.env.APPT_BRIDGE_AFTER_CHECKS || 8)) || 8),
  headless: String(process.env.APPT_HEADLESS || 'true').toLowerCase() !== 'false',
  dryRun: hasFlag('--dry-run'),
  skipFirstCheck: hasFlag('--skip-first-check'),
  allowOneTimeHumanFallback: !hasFlag('--disable-human-fallback') && String(process.env.APPT_ALLOW_HUMAN_FALLBACK || 'true').toLowerCase() !== 'false',
  humanInterventionTimeoutMs: Math.max(60000, Number(getArgValue('--human-timeout-ms', process.env.APPT_HUMAN_TIMEOUT_MS || 600000)) || 600000),
  otpPolicyDefault: String(process.env.BOOKING_OTP_POLICY || process.env.APPT_OTP_POLICY || 'static').toLowerCase(),
  showActionTrail: hasFlag('--show-action-trail') || String(process.env.APPT_SHOW_ACTION_TRAIL || '').toLowerCase() === 'true',
  maxHitlBridgeFailures: Math.max(1, Number(getArgValue('--max-hitl-bridge-failures', process.env.APPT_MAX_HITL_BRIDGE_FAILURES || 3)) || 3),
  proactiveBookingOnSelectionPage: !hasFlag('--disable-proactive-selection-booking') && String(process.env.APPT_PROACTIVE_SELECTION_BOOKING || 'true').toLowerCase() !== 'false',
  proactiveBookingIntervalChecks: Math.max(1, Number(getArgValue('--proactive-booking-interval-checks', process.env.APPT_PROACTIVE_BOOKING_INTERVAL_CHECKS || 3)) || 3),
  promptMissingProfile: hasFlag('--prompt-missing-profile') || String(process.env.APPT_PROMPT_MISSING_PROFILE || 'false').toLowerCase() === 'true',
  reviewProfileOnStart: hasFlag('--review-profile-on-start') || String(process.env.APPT_REVIEW_PROFILE_ON_START || 'false').toLowerCase() === 'true',
  requireFinalHumanApproval: hasFlag('--require-final-human-approval') || String(process.env.APPT_REQUIRE_FINAL_HUMAN_APPROVAL || 'false').toLowerCase() === 'true',
  autoApproveValidatedSubmit: hasFlag('--auto-approve-validated-submit') || String(process.env.APPT_AUTO_APPROVE_VALIDATED_SUBMIT || 'false').toLowerCase() === 'true',
  interactiveFinalApproval: !hasFlag('--disable-interactive-final-approval') && String(process.env.APPT_DISABLE_INTERACTIVE_FINAL_APPROVAL || 'false').toLowerCase() !== 'true',
};

{
  const hasStartupPreferenceInput = [
    config.preferredDate,
    config.preferredTime,
    config.preferredTimes,
    config.preferredTimeWindow,
    config.slotSelectionPolicy,
  ].some((value) => Boolean(String(value || '').trim()));

  if (hasStartupPreferenceInput) {
    const sanitized = sanitizePreferenceInputs({
      preferredDate: config.preferredDate,
      preferredTime: config.preferredTime,
      preferredTimes: config.preferredTimes,
      preferredTimeWindow: config.preferredTimeWindow,
      slotSelectionPolicy: config.slotSelectionPolicy,
    });
    config.preferredDate = sanitized.profile.preferredDate;
    config.preferredTime = sanitized.profile.preferredTime;
    config.preferredTimes = sanitized.profile.preferredTimes;
    config.preferredTimeWindow = sanitized.profile.preferredTimeWindow;
    config.slotSelectionPolicy = sanitized.profile.slotSelectionPolicy;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ALERT SYSTEM
// ────────────────────────────────────────────────────────────────────────────

function beep() {
  if (!config.enableSound) return;
  try {
    if (process.platform === 'win32') {
      exec('powershell -c [Console]::Beep(1000, 500)');
    } else if (process.platform === 'darwin') {
      exec('afplay /System/Library/Sounds/Glass.aiff');
    } else {
      exec('paplay /usr/share/sounds/freedesktop/stereo/complete.oga');
    }
  } catch {
    // Silent fail if sound not available
  }
}

function alert(message, type = 'info') {
  if (!config.enableVisualAlerts) return;

  const timestamp = new Date().toLocaleTimeString();
  const icons = {
    check: '✓',
    alert: '⚠',
    error: '✗',
    info: 'ℹ',
    heartbeat: '♡',
    slots: '🎯',
  };

  const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
  };

  const typeConfig = {
    success: { icon: icons.check, color: colors.green },
    slots: { icon: icons.slots, color: colors.green },
    warning: { icon: icons.alert, color: colors.yellow },
    error: { icon: icons.error, color: colors.red },
    info: { icon: icons.info, color: colors.cyan },
    heartbeat: { icon: icons.heartbeat, color: colors.blue },
  };

  const { icon, color } = typeConfig[type] || typeConfig.info;
  const formatted = `${color}${icon} [${timestamp}] ${message}${colors.reset}`;
  console.log(formatted);
}

async function alertSlotAvailable(details = {}) {
  const message = `🟢 SLOTS AVAILABLE! Confidence: ${(details.confidence * 100).toFixed(0)}%`;
  alert(message, 'slots');
  beep();
  await new Promise((r) => setTimeout(r, 200));
  beep();
  await new Promise((r) => setTimeout(r, 200));
  beep();
}

// ────────────────────────────────────────────────────────────────────────────
// CREDENTIAL MANAGEMENT
// ────────────────────────────────────────────────────────────────────────────

async function askForCredentialsIfNeeded() {
  // Check if credentials already saved
  const existing = await loadBookingCredentials();
  if (existing?.loginUsername && existing?.loginPassword) {
    const savedProfile = existing?.applicantProfile && typeof existing.applicantProfile === 'object'
      ? { ...existing.applicantProfile }
      : {};
    savedProfile.firstName = String(savedProfile.firstName || '').trim();
    savedProfile.lastName = String(savedProfile.lastName || '').trim();
    savedProfile.fullName = String(savedProfile.fullName || [savedProfile.firstName, savedProfile.lastName].filter(Boolean).join(' ')).trim();
    savedProfile.phone = String(savedProfile.phone || '').trim();
    savedProfile.email = String(savedProfile.email || '').trim();
    savedProfile.address = String(savedProfile.address || '').trim();

    const requiredProfileFields = ['firstName', 'lastName', 'phone', 'email', 'address'];
    const missingProfileFields = requiredProfileFields.filter((field) => !String(savedProfile[field] || '').trim());

    if (config.reviewProfileOnStart && process.stdin?.isTTY && process.stdout?.isTTY) {
      const rl = readline.createInterface({ input, output });
      try {
        alert('📝 Review applicant profile before monitoring starts (press Enter to keep current value)', 'info');
        const q = async (label, current = '') => String(await rl.question(`? ${label} [${String(current || 'none')}]: `) || current || '').trim();

        savedProfile.firstName = await q('Applicant first name', savedProfile.firstName || process.env.APPT_FIRST_NAME || '');
        savedProfile.lastName = await q('Applicant last name', savedProfile.lastName || process.env.APPT_LAST_NAME || '');
        savedProfile.phone = await q('Applicant phone', savedProfile.phone || process.env.APPT_PHONE || '');
        savedProfile.email = await q('Applicant email', savedProfile.email || process.env.APPT_EMAIL || '');
        savedProfile.address = await q('Applicant address', savedProfile.address || process.env.APPT_ADDRESS || '');
        savedProfile.preferredDate = await q('Preferred date (YYYY-MM-DD)', savedProfile.preferredDate || process.env.APPT_PREFERRED_DATE || '');
        savedProfile.preferredTime = await q('Preferred time (HH:mm)', savedProfile.preferredTime || process.env.APPT_PREFERRED_TIME || '');
        savedProfile.preferredTimes = await q('Preferred times list (comma-separated HH:mm)', savedProfile.preferredTimes || process.env.APPT_PREFERRED_TIMES || '');
        savedProfile.preferredTimeWindow = await q('Preferred time window (HH:mm-HH:mm)', savedProfile.preferredTimeWindow || process.env.APPT_PREFERRED_TIME_WINDOW || '');
        savedProfile.slotSelectionPolicy = await q('Slot selection policy (score/earliest/exact-only/window-only/preferred-window-fallback-earliest)', savedProfile.slotSelectionPolicy || process.env.APPT_SLOT_SELECTION_POLICY || 'score');
        const sanitized = sanitizePreferenceInputs(savedProfile);
        Object.assign(savedProfile, sanitized.profile);
        for (const warning of sanitized.warnings) {
          alert(`⚠ ${warning}`, 'warning');
        }

        if (!explicitPreferenceOverrides.preferredDate) config.preferredDate = savedProfile.preferredDate || '';
        if (!explicitPreferenceOverrides.preferredTime) config.preferredTime = savedProfile.preferredTime || '';
        if (!explicitPreferenceOverrides.preferredTimes) config.preferredTimes = savedProfile.preferredTimes || '';
        if (!explicitPreferenceOverrides.preferredTimeWindow) config.preferredTimeWindow = savedProfile.preferredTimeWindow || '';
        if (!explicitPreferenceOverrides.slotSelectionPolicy) config.slotSelectionPolicy = savedProfile.slotSelectionPolicy || '';
        if (!savedProfile.fullName) {
          savedProfile.fullName = [savedProfile.firstName, savedProfile.lastName].filter(Boolean).join(' ').trim();
        }

        await saveBookingCredentials({
          loginUsername: existing.loginUsername,
          loginPassword: existing.loginPassword,
          otpCode: existing.otpCode || '',
          otpPolicy: existing.otpPolicy || 'static',
          totpSecret: existing.totpSecret || '',
          applicantProfile: savedProfile,
        });
        existing.applicantProfile = savedProfile;
        alert('✓ Applicant profile reviewed and saved for autofill.', 'success');
      } finally {
        rl.close();
      }
    }

    if (missingProfileFields.length > 0) {
      const envProfile = {
        firstName: String(process.env.APPT_FIRST_NAME || '').trim(),
        lastName: String(process.env.APPT_LAST_NAME || '').trim(),
        phone: String(process.env.APPT_PHONE || '').trim(),
        email: String(process.env.APPT_EMAIL || '').trim(),
        address: String(process.env.APPT_ADDRESS || '').trim(),
      };
      let appliedFromEnv = false;
      for (const field of missingProfileFields) {
        if (!String(savedProfile[field] || '').trim() && String(envProfile[field] || '').trim()) {
          savedProfile[field] = envProfile[field];
          appliedFromEnv = true;
        }
      }
      if (!savedProfile.fullName) {
        savedProfile.fullName = [savedProfile.firstName, savedProfile.lastName].filter(Boolean).join(' ').trim();
      }
      if (appliedFromEnv) {
        await saveBookingCredentials({
          loginUsername: existing.loginUsername,
          loginPassword: existing.loginPassword,
          otpCode: existing.otpCode || '',
          otpPolicy: existing.otpPolicy || 'static',
          totpSecret: existing.totpSecret || '',
          applicantProfile: savedProfile,
        });
        existing.applicantProfile = savedProfile;
      }
      const remainingMissingProfileFields = requiredProfileFields.filter((field) => !String(savedProfile[field] || '').trim());

      if (!config.promptMissingProfile || !process.stdin?.isTTY || !process.stdout?.isTTY) {
        if (remainingMissingProfileFields.length > 0) {
          alert(`⚠ Saved credentials exist but missing applicant fields: ${remainingMissingProfileFields.join(', ')}`, 'warning');
          alert('ℹ Continuing without pause. Missing fields can be completed via UI/HITL during booking.', 'info');
        } else if (appliedFromEnv) {
          alert('✓ Missing applicant fields were restored from APPT_* environment values and saved.', 'success');
        }
      } else {
        const rl = readline.createInterface({ input, output });
        try {
          alert(`📝 Saved credentials found; please complete missing applicant fields: ${remainingMissingProfileFields.join(', ')}`, 'info');
          if (!savedProfile.firstName) {
            savedProfile.firstName = String(await rl.question(`? Applicant first name [${process.env.APPT_FIRST_NAME || 'none'}]: `) || process.env.APPT_FIRST_NAME || '').trim();
          }
          if (!savedProfile.lastName) {
            savedProfile.lastName = String(await rl.question(`? Applicant last name [${process.env.APPT_LAST_NAME || 'none'}]: `) || process.env.APPT_LAST_NAME || '').trim();
          }
          if (!savedProfile.phone) {
            savedProfile.phone = String(await rl.question(`? Applicant phone [${process.env.APPT_PHONE || 'none'}]: `) || process.env.APPT_PHONE || '').trim();
          }
          if (!savedProfile.email) {
            savedProfile.email = String(await rl.question(`? Applicant email [${process.env.APPT_EMAIL || 'none'}]: `) || process.env.APPT_EMAIL || '').trim();
          }
          if (!savedProfile.address) {
            savedProfile.address = String(await rl.question(`? Applicant address [${process.env.APPT_ADDRESS || 'none'}]: `) || process.env.APPT_ADDRESS || '').trim();
          }
          if (!savedProfile.fullName) {
            savedProfile.fullName = [savedProfile.firstName, savedProfile.lastName].filter(Boolean).join(' ').trim();
          }

          await saveBookingCredentials({
            loginUsername: existing.loginUsername,
            loginPassword: existing.loginPassword,
            otpCode: existing.otpCode || '',
            otpPolicy: existing.otpPolicy || 'static',
            totpSecret: existing.totpSecret || '',
            applicantProfile: savedProfile,
          });

          existing.applicantProfile = savedProfile;
          alert('✓ Missing applicant fields were saved for future runs.', 'success');
        } finally {
          rl.close();
        }
      }
    }

    alert(`✓ Using saved credentials (${existing.loginUsername.charAt(0)}*** last saved ${existing.savedAt})`, 'info');
    if (existing.otpPolicy === 'totp' && existing.totpSecret) {
      alert('✓ OTP policy: TOTP (auto-generated per login)', 'info');
    }
    if (existing?.applicantProfile?.fullName || existing?.applicantProfile?.firstName || existing?.applicantProfile?.idNumber) {
      alert('✓ Saved applicant profile will also be reused during booking attempts', 'info');
    }
    return existing;
  }

  // No credentials saved - ask user
  if (!process.stdin?.isTTY || !process.stdout?.isTTY) {
    alert('⚠ Non-interactive terminal - cannot collect credentials. Set APPT_LOGIN_USER and APPT_LOGIN_PASS env vars.', 'warning');
    return null;
  }

  const rl = readline.createInterface({ input, output });
  try {
    alert('📝 Setting up autonomous booking - collecting credentials (one-time)', 'info');
    console.log('Press Enter to skip a field (use env vars instead).\n');

    const loginUsername = await rl.question(`? Login username [${process.env.APPT_LOGIN_USER ? '***' : 'none'}]: `);
    const loginPassword = await rl.question(`? Login password [${process.env.APPT_LOGIN_PASS ? '***' : 'none'}]: `);
    const otpPolicyInput = await rl.question(`? OTP policy [static/totp/manual] (default: ${config.otpPolicyDefault}): `);
    const otpPolicy = String(otpPolicyInput || config.otpPolicyDefault || 'static').trim().toLowerCase();
    const otpCode = otpPolicy === 'totp'
      ? ''
      : await rl.question(`? OTP code (if required) [${process.env.APPT_OTP ? '***' : 'none'}]: `);
    const totpSecret = otpPolicy === 'totp'
      ? await rl.question('? TOTP secret (base32): ')
      : '';
    const firstName = await rl.question(`? Applicant first name [${process.env.APPT_FIRST_NAME || 'none'}]: `);
    const lastName = await rl.question(`? Applicant last name [${process.env.APPT_LAST_NAME || 'none'}]: `);
    const fullName = await rl.question(`? Applicant full name [${process.env.APPT_FULL_NAME || 'auto from first+last'}]: `);
    const idNumber = await rl.question(`? Applicant ID [${process.env.APPT_ID || 'none'}]: `);
    const phone = await rl.question(`? Applicant phone [${process.env.APPT_PHONE || 'none'}]: `);
    const email = await rl.question(`? Applicant email [${process.env.APPT_EMAIL || 'none'}]: `);
    const address = await rl.question(`? Applicant address [${process.env.APPT_ADDRESS || 'none'}]: `);

    const finalUser = String(loginUsername || process.env.APPT_LOGIN_USER || '').trim();
    const finalPass = String(loginPassword || process.env.APPT_LOGIN_PASS || '').trim();
    const finalOtp = String(otpCode || process.env.APPT_OTP || '').trim();
    const finalTotpSecret = String(totpSecret || process.env.BOOKING_TOTP_SECRET || '').trim();
    const normalizedFirstName = String(firstName || process.env.APPT_FIRST_NAME || '').trim();
    const normalizedLastName = String(lastName || process.env.APPT_LAST_NAME || '').trim();
    const composedFullName = [normalizedFirstName, normalizedLastName].filter(Boolean).join(' ').trim();
    const applicantProfile = {
      firstName: normalizedFirstName,
      lastName: normalizedLastName,
      fullName: String(fullName || process.env.APPT_FULL_NAME || composedFullName).trim(),
      idNumber: String(idNumber || process.env.APPT_ID || '').trim(),
      phone: String(phone || process.env.APPT_PHONE || '').trim(),
      email: String(email || process.env.APPT_EMAIL || '').trim(),
      address: String(address || process.env.APPT_ADDRESS || '').trim(),
    };

    if (!finalUser || !finalPass) {
      alert('⚠ Username and password required for autonomous booking', 'warning');
      return null;
    }

    // Save for future runs
    await saveBookingCredentials({
      loginUsername: finalUser,
      loginPassword: finalPass,
      otpCode: finalOtp,
      otpPolicy,
      totpSecret: finalTotpSecret,
      applicantProfile,
    });

    alert('✓ Credentials saved! Future runs will use these automatically.', 'success');

    return {
      loginUsername: finalUser,
      loginPassword: finalPass,
      otpCode: finalOtp,
      otpPolicy,
      totpSecret: finalTotpSecret,
      applicantProfile,
    };
  } finally {
    rl.close();
  }
}

async function loadChallengeMemory() {
  try {
    const raw = await fs.readFile(CHALLENGE_MEMORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveChallengeMemory(update = {}) {
  const existing = await loadChallengeMemory();
  const merged = {
    ...existing,
    ...update,
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(CHALLENGE_MEMORY_FILE), { recursive: true });
  await fs.writeFile(CHALLENGE_MEMORY_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

async function collectOneTimeHumanChallengeInputs(stateUpper, credentials) {
  if (!process.stdin?.isTTY || !process.stdout?.isTTY) return credentials;

  const rl = readline.createInterface({ input, output });
  try {
    const nextCreds = { ...(credentials || {}) };

    if (stateUpper === 'AWAITING_LOGIN') {
      alert('🔐 Human fallback required once: login credentials update', 'warning');
      const newUser = await rl.question(`? Updated login username [${nextCreds.loginUsername ? '***' : 'none'}]: `);
      const newPass = await rl.question(`? Updated login password [${nextCreds.loginPassword ? '***' : 'none'}]: `);
      if (String(newUser || '').trim()) nextCreds.loginUsername = String(newUser).trim();
      if (String(newPass || '').trim()) nextCreds.loginPassword = String(newPass).trim();
    }

    if (stateUpper === 'AWAITING_OTP') {
      alert('📲 Human fallback required once: OTP/2FA refresh', 'warning');
      const otpPolicyInput = await rl.question(`? OTP policy [static/totp/manual] (current: ${nextCreds.otpPolicy || 'static'}): `);
      const otpPolicy = String(otpPolicyInput || nextCreds.otpPolicy || 'static').trim().toLowerCase();
      nextCreds.otpPolicy = otpPolicy;

      if (otpPolicy === 'totp') {
        const totpSecret = await rl.question(`? TOTP secret (base32) [${nextCreds.totpSecret ? '***' : 'none'}]: `);
        if (String(totpSecret || '').trim()) {
          nextCreds.totpSecret = String(totpSecret).trim();
        }
        nextCreds.otpCode = '';
      } else {
        const oneTimeOtp = await rl.question(`? OTP code now [${nextCreds.otpCode ? '***' : 'none'}]: `);
        if (String(oneTimeOtp || '').trim()) {
          nextCreds.otpCode = String(oneTimeOtp).trim();
        }
      }
    }

    await saveBookingCredentials(nextCreds);
    await saveChallengeMemory({
      lastCheckpoint: stateUpper,
      lastHumanFallbackAt: new Date().toISOString(),
      otpPolicy: nextCreds.otpPolicy || 'static',
      hasTotpSecret: !!nextCreds.totpSecret,
    });

    alert('✓ Human fallback details saved for future autonomous runs', 'success');
    return nextCreds;
  } finally {
    rl.close();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SLOT DETECTION
// ────────────────────────────────────────────────────────────────────────────

function detectSlotAvailability(inspection = {}) {
  if (!inspection) return { available: false, confidence: 0, reason: 'no-inspection-data' };

  // Extract page content
  const scrapeSignals = inspection?.scrapeSignals || {};
  const pageContent = String(inspection?.pageContent || inspection?.markdown || scrapeSignals?.textPreview || '').toLowerCase();
  const pageTitle = String(inspection?.pageTitle || '').toLowerCase();

  if (!pageContent && !pageTitle) {
    return { available: false, confidence: 0, reason: 'no-page-content' };
  }

  // Positive indicators for available slots
  const positivePatterns = [
    /available\s+slot|slots?\s+available/i,
    /זמינות|תור\s*פנוי|תורים\s+זמינים/,
    /(?<!\bno\s)available(?!\s+(?!slot|time|appointment))/i,
    /can\s+(?:schedule|book|reserve)|ready\s+to\s+(?:book|schedule)/i,
    /green|open|select.*time|choose.*time|select.*slot/i,
    /במועד|בזמן קרוב|בקרוב תוכל/,
  ];

  // Negative indicators for booked slots
  const negativePatterns = [
    /no\s+available|fully\s+booked|all\s+slots|out\s+of.*slot/i,
    /אין\s+תורים|בעל כל התורים|תור שלך/,
    /sorry.*book|currently.*open|cannot\s+(?:book|schedule)/i,
    /red|closed|no.*time|unavailable/i,
    /רעך זמוני|סגור|אינו זמין/,
  ];

  let positiveCount = 0;
  let negativeCount = 0;

  for (const pattern of positivePatterns) {
    const matches = pageContent.match(pattern) || pageTitle.match(pattern);
    if (matches) positiveCount += matches.length;
  }

  for (const pattern of negativePatterns) {
    const matches = pageContent.match(pattern) || pageTitle.match(pattern);
    if (matches) negativeCount += matches.length;
  }

  // Calculate confidence
  const hasPositive = positiveCount > 0;
  const hasNegative = negativeCount > 0;

  let confidence = 0;
  let reasoning = 'unclear';

  if (hasPositive && !hasNegative) {
    confidence = Math.min(1, 0.5 + positiveCount * 0.1);
    reasoning = 'positive-signals-found';
  } else if (hasNegative && !hasPositive) {
    confidence = 0;
    reasoning = 'negative-signals-found';
  } else if (hasPositive && hasNegative) {
    confidence = positiveCount > negativeCount ? 0.4 + positiveCount * 0.05 : 0.2;
    reasoning = 'mixed-signals';
  }

  // Add additional evidence from scrape signals and network APIs for better generalization.
  if (scrapeSignals?.hasAppointmentSignal) {
    confidence += 0.1;
  }
  if (config.category === 'arnona' && scrapeSignals?.hasArnonaSignal) {
    confidence += 0.1;
  }

  const apiLikeEntries = Array.isArray(inspection?.networkRequests) ? inspection.networkRequests : [];
  const slotApiHints = apiLikeEntries.filter((entry) => {
    const url = String(entry?.url || '').toLowerCase();
    const status = Number(entry?.status || 0);
    return status > 0 && status < 500 && /(appoint|slot|calendar|availability|timeslot|book)/i.test(url);
  }).length;
  if (slotApiHints > 0) {
    confidence += Math.min(0.15, slotApiHints * 0.02);
  }

  confidence = Math.max(0, Math.min(1, confidence));
  const finalUrl = String(inspection?.finalUrl || '').toLowerCase();
  const reachedDateSelectionStage = /select-date=1|departmentid=|schedule=1/.test(finalUrl)
    || /choose date|choose time|select date|select time|בחר תאריך|בחר שעה|זימון תורים/i.test(pageContent);

  return {
    available: confidence >= config.minSlotConfidence,
    confidence,
    reasoning,
    positiveSignals: positiveCount,
    negativeSignals: negativeCount,
    slotApiHints,
    appointmentSignal: Boolean(scrapeSignals?.hasAppointmentSignal),
    arnonaSignal: Boolean(scrapeSignals?.hasArnonaSignal),
    reachedDateSelectionStage,
    finalUrl: inspection?.finalUrl || '',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// MAIN POLLING LOOP
// ────────────────────────────────────────────────────────────────────────────

let checkCount = 0;
let slotFoundCount = 0;
let lastSlotFoundAt = null;
let consecutiveErrors = 0;
let humanFallbackUsed = false;
let bookingAttemptCount = 0;
let hitlBridgeStarted = false;
let hitlSessionToken = '';
let lastBookingOutcome = null;
let hitlBridgeFailureCount = 0;
let lastProactiveSelectionBookingCheck = 0;
let bookingCompleted = false;
let lastSelectionStageSignature = '';

async function maybeStartHitlBridge(credentials, { force = false, reason = 'no-slots-threshold' } = {}) {
  if (bookingCompleted || lastBookingOutcome?.submitted) {
    return { ok: true, skipped: true, reason: 'booking-already-submitted' };
  }
  if (!config.autoBridgeToHitl) return null;
  if (hitlBridgeStarted) return { ok: true, token: hitlSessionToken, mode: 'already-started' };
  if (hitlBridgeFailureCount >= config.maxHitlBridgeFailures) {
    return { ok: false, skipped: true, reason: 'hitl-bridge-failure-threshold-reached' };
  }
  if (!force && checkCount < config.bridgeAfterChecks) return null;

  try {
    const session = await startAttendedBookingSession({
      requestId: null,
      bookingUrl: config.websiteUrl,
      applicant: {
        ...(credentials?.applicantProfile || {}),
        loginUsername: credentials?.loginUsername || '',
        loginPassword: credentials?.loginPassword || '',
        otpCode: credentials?.otpCode || '',
        otpPolicy: credentials?.otpPolicy || config.otpPolicyDefault,
        totpSecret: credentials?.totpSecret || '',
        notes: config.userRequest,
      },
      intentText: config.userRequest,
      headless: false,
      timeoutMs: config.humanInterventionTimeoutMs,
    });

    hitlBridgeStarted = true;
    hitlBridgeFailureCount = 0;
    hitlSessionToken = String(session?.token || '').trim();

    const status = hitlSessionToken
      ? await getAttendedBookingSessionStatus(hitlSessionToken, { includeNetwork: false, networkLimit: 20 }).catch(() => null)
      : null;

    alert(`🧑‍💻 HITL bridge started (${reason}). token=${hitlSessionToken || 'n/a'} state=${status?.state || session?.state || 'unknown'}`, 'warning');

    await createGovernmentRequest({
      userId: config.userId,
      description: 'HITL bridge started from autonomous polling',
      status: 'new',
      notes: JSON.stringify({
        reason,
        token: hitlSessionToken || null,
        checkCount,
        state: status?.state || session?.state || null,
        startedAt: new Date().toISOString(),
      }),
    }).catch(() => null);

    return { ok: true, token: hitlSessionToken, status: status || null };
  } catch (err) {
    hitlBridgeFailureCount += 1;
    alert(`⚠ HITL bridge start failed: ${err?.message || err}`, 'warning');
    if (hitlBridgeFailureCount >= config.maxHitlBridgeFailures) {
      alert(`⛔ HITL bridge disabled after ${hitlBridgeFailureCount} failures. Fix root cause and rerun.`, 'warning');
    }
    return { ok: false, error: err?.message || String(err) };
  }
}

async function performSlotCheck(credentials) {
  if (bookingCompleted || lastBookingOutcome?.submitted) {
    return { ok: true, skipped: true, reason: 'booking-already-submitted' };
  }
  checkCount++;
  const isHeartbeat = checkCount % config.checkHeartbeatEvery === 0;

  try {
    // Perform network inspection
    const inspectionMaxSteps = /ganeytikva\.org\.il/.test(String(config.websiteUrl || '').toLowerCase())
      && /select-date=1|[?&]id=144\b/.test(String(config.websiteUrl || '').toLowerCase())
      ? 1
      : config.maxAutonomousSteps;
    const inspection = await inspectBookingSiteNetwork({
      bookingUrl: config.websiteUrl,
      intentText: config.userRequest,
      headless: config.headless,
      autonomousBrowse: true,
      maxAutonomousSteps: inspectionMaxSteps,
      maxNetworkEntries: config.maxNetworkEntries,
    });

    // Detect slots
    const slotAnalysis = detectSlotAvailability(inspection);
    const traversalVisited = Array.isArray(inspection?.traversal?.visited) ? inspection.traversal.visited : [];

    if (isHeartbeat || slotAnalysis.available) {
      const lastHop = traversalVisited[traversalVisited.length - 1] || null;
      const crawlSummary = `🧭 Crawl: steps=${traversalVisited.length}, forms=${Number(inspection?.formsDiscovered || 0)}, final=${inspection?.finalUrl || 'n/a'}`;
      alert(crawlSummary, 'info');
      if (lastHop) {
        alert(`   Last hop: step=${lastHop.step ?? '?'} title="${String(lastHop.title || '').slice(0, 80)}"`, 'info');
      }

      if (config.showActionTrail && traversalVisited.length > 0) {
        console.log('   Crawl trail:');
        for (const hop of traversalVisited.slice(-6)) {
          console.log(`     - [${hop.step}] ${String(hop.title || '').slice(0, 70)} => ${hop.url}`);
        }
      }
    }

    if (isHeartbeat || slotAnalysis.available) {
      const statusMsg = slotAnalysis.available
        ? `🟢 SLOTS DETECTED (${(slotAnalysis.confidence * 100).toFixed(0)}% confidence)`
        : `🔵 Check #${checkCount} - No slots (${slotAnalysis.reasoning || 'unclear'}; +${slotAnalysis.positiveSignals || 0}/-${slotAnalysis.negativeSignals || 0}; apiHints=${slotAnalysis.slotApiHints || 0})`;
      alert(statusMsg, slotAnalysis.available ? 'slots' : 'heartbeat');
    }

    if (!slotAnalysis.available && slotAnalysis.reachedDateSelectionStage) {
      const selectionSignature = String(slotAnalysis.finalUrl || 'selection-stage').trim().toLowerCase() || 'selection-stage';
      if (selectionSignature !== lastSelectionStageSignature) {
        lastSelectionStageSignature = selectionSignature;
        alert(`🗓 Reached date/time selection stage (${slotAnalysis.finalUrl || 'unknown URL'})`, 'info');
      }
    } else if (!slotAnalysis.reachedDateSelectionStage) {
      lastSelectionStageSignature = '';
    }

    // Alert if slots found
    if (slotAnalysis.available) {
      slotFoundCount++;
      lastSlotFoundAt = new Date().toISOString();

      // Log the discovery
      await createGovernmentRequest({
        userId: config.userId,
        description: `Slot availability detected (Check #${checkCount})`,
        status: 'approved',
        notes: JSON.stringify({
          confidence: slotAnalysis.confidence,
          reasoning: slotAnalysis.reasoning,
          checkNumber: checkCount,
          detectedAt: lastSlotFoundAt,
        }),
      });

      await alertSlotAvailable(slotAnalysis);

      // Auto-booking logic
      if (config.autoBookOnSlots && credentials) {
        alert('🚀 Starting autonomous booking attempt...', 'info');
        bookingAttemptCount += 1;
        lastBookingOutcome = await attemptAutonomousBooking(credentials);
        if (lastBookingOutcome?.submitted) {
          bookingCompleted = true;
          return { ok: true, slotAnalysis, submitted: true };
        }
      } else if (!config.autoBookOnSlots) {
        alert('ℹ Slots were detected but auto-book is disabled. Use --no-auto-book only when manual confirmation is required.', 'info');
      }
    } else if (
      config.proactiveBookingOnSelectionPage
      && slotAnalysis.reachedDateSelectionStage
      && credentials
      && (checkCount - lastProactiveSelectionBookingCheck >= config.proactiveBookingIntervalChecks)
    ) {
      lastProactiveSelectionBookingCheck = checkCount;
      alert('🧪 Proactive booking attempt from date/time selection stage...', 'info');
      bookingAttemptCount += 1;
      lastBookingOutcome = await attemptAutonomousBooking(credentials);
      if (lastBookingOutcome?.submitted) {
        bookingCompleted = true;
        return { ok: true, slotAnalysis, submitted: true };
      }
    } else if (config.autoBridgeToHitl && !hitlBridgeStarted && checkCount >= config.bridgeAfterChecks) {
      await maybeStartHitlBridge(credentials, { reason: 'no-slots-threshold' });
    }

    consecutiveErrors = 0;
    return { ok: true, slotAnalysis };
  } catch (err) {
    consecutiveErrors++;
    const msg = `⚠ Check failed (${consecutiveErrors}/${config.maxRetries}): ${err?.message || err}`;
    alert(msg, 'warning');

    if (consecutiveErrors >= config.maxRetries) {
      throw new Error(`Max retries exceeded after ${config.maxRetries} failures`);
    }

    return { ok: false, error: err?.message || String(err) };
  }
}

async function attemptAutonomousBooking(credentials) {
  try {
    let mutableCreds = { ...(credentials || {}) };
    const bookingAttemptUrl = normalizeGaneyBookingUrl(config.websiteUrl);

    const buildApplicant = () => ({
      ...(mutableCreds.applicantProfile || {}),
      loginUsername: mutableCreds.loginUsername,
      loginPassword: mutableCreds.loginPassword,
      otpCode: mutableCreds.otpCode || '',
      otpPolicy: mutableCreds.otpPolicy || config.otpPolicyDefault,
      totpSecret: mutableCreds.totpSecret || '',
      reusePersistentProfile: true,
      username: config.username || mutableCreds.loginUsername || mutableCreds?.applicantProfile?.username || '',
      firstName: process.env.APPT_FIRST_NAME || mutableCreds?.applicantProfile?.firstName || '',
      lastName: process.env.APPT_LAST_NAME || mutableCreds?.applicantProfile?.lastName || '',
      fullName: process.env.APPT_FULL_NAME || mutableCreds?.applicantProfile?.fullName || '',
      idNumber: process.env.APPT_ID || mutableCreds?.applicantProfile?.idNumber || '',
      phone: process.env.APPT_PHONE || mutableCreds?.applicantProfile?.phone || '',
      email: process.env.APPT_EMAIL || mutableCreds?.applicantProfile?.email || '',
      address: process.env.APPT_ADDRESS || mutableCreds?.applicantProfile?.address || '',
      preferredDate: explicitPreferenceOverrides.preferredDate
        ? (config.preferredDate || '')
        : String(mutableCreds?.applicantProfile?.preferredDate || config.preferredDate || '').trim(),
      preferredTime: explicitPreferenceOverrides.preferredTime
        ? (config.preferredTime || '')
        : String(mutableCreds?.applicantProfile?.preferredTime || config.preferredTime || '').trim(),
      preferredTimes: explicitPreferenceOverrides.preferredTimes
        ? (config.preferredTimes || '')
        : String(mutableCreds?.applicantProfile?.preferredTimes || config.preferredTimes || '').trim(),
      preferredTimeWindow: explicitPreferenceOverrides.preferredTimeWindow
        ? (config.preferredTimeWindow || '')
        : String(mutableCreds?.applicantProfile?.preferredTimeWindow || config.preferredTimeWindow || '').trim(),
      slotSelectionPolicy: explicitPreferenceOverrides.slotSelectionPolicy
        ? (config.slotSelectionPolicy || 'score')
        : String(mutableCreds?.applicantProfile?.slotSelectionPolicy || config.slotSelectionPolicy || 'score').trim().toLowerCase(),
      notes: config.userRequest,
    });

    const runAttempt = () => runTelAvivFullyAutomatedBooking({
      applicant: buildApplicant(),
      bookingUrl: bookingAttemptUrl,
      intentText: config.userRequest,
      dryRun: config.dryRun,
      confirmedSubmit: !config.dryRun,
      headless: config.headless,
      maxRuntimeMs: config.bookingAttemptMaxRuntimeMs,
      pollIntervalMs: 2500,
      keepSessionOnFailure: false,
      allowHumanIntervention: false,
      humanInterventionTimeoutMs: config.humanInterventionTimeoutMs,
      requireFinalHumanApproval: config.requireFinalHumanApproval,
      autoApproveValidatedSubmit: config.autoApproveValidatedSubmit,
    });

    const bookingApplicant = buildApplicant();
    const usedProfileKeys = ['firstName', 'lastName', 'phone', 'email', 'address']
      .filter((key) => String(bookingApplicant?.[key] || '').trim());
    alert(`🧭 Slot policy: ${String(bookingApplicant.slotSelectionPolicy || 'score')} | preferredTime=${bookingApplicant.preferredTime || 'none'} | preferredTimes=${bookingApplicant.preferredTimes || 'none'} | window=${bookingApplicant.preferredTimeWindow || 'none'}`, 'info');
    if (usedProfileKeys.length) {
      alert(`🧾 Autofill profile fields available: ${usedProfileKeys.join(', ')}`, 'info');
    }

    const hardTimeoutMs = Math.max(45000, Number(config.bookingAttemptMaxRuntimeMs || 120000) + 30000);
    let timeoutHandle = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`booking-attempt-hard-timeout-${hardTimeoutMs}ms`));
      }, hardTimeoutMs);
    });

    let result;
    try {
      result = await Promise.race([runAttempt(), timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    if (result?.submitted) {
      alert('✅ BOOKING SUBMITTED SUCCESSFULLY!', 'success');
      if (result?.session?.state) {
        alert(`📌 Final booking state: ${result.session.state}`, 'success');
      }
      if (Array.isArray(result?.session?.appointmentCandidatePreview) && result.session.appointmentCandidatePreview.length > 0) {
        const topChoices = result.session.appointmentCandidatePreview
          .slice(0, 3)
          .map((item, idx) => {
            const label = item?.text || [item?.dataDate, item?.dataTime].filter(Boolean).join(' ') || 'unknown';
            return `#${idx + 1} ${label} (score=${Number(item?.score || 0)})`;
          })
          .join(' | ');
        alert(`🧪 Top considered slot choices: ${topChoices}`, 'info');
      }
      if (Number(result?.session?.prefilledFields || 0) > 0) {
        alert(`🧾 Autofill evidence: filled ${Number(result.session.prefilledFields)} form field(s).`, 'info');
      }
      if (Array.isArray(result?.session?.formRequirements) && result.session.formRequirements.length > 0) {
        const requiredDetected = result.session.formRequirements.filter((item) => item?.required).length;
        alert(`🧾 Form requirements detected on page: ${result.session.formRequirements.length} (required=${requiredDetected}).`, 'info');
      }
      if (Array.isArray(result?.session?.selectedAppointmentOptions) && result.session.selectedAppointmentOptions.length > 0) {
        const picks = result.session.selectedAppointmentOptions.slice(0, 2)
          .map((pick) => pick?.text || [pick?.dataDate, pick?.dataTime].filter(Boolean).join(' '))
          .filter(Boolean)
          .join(' | ');
        if (picks) {
          alert(`🗓 Selected option(s): ${picks}`, 'success');
        }
      }
      if (result?.session?.confirmation?.detected) {
        const confirmationId = result.session.confirmation.confirmationId ? ` id=${result.session.confirmation.confirmationId}` : '';
        const confirmationTime = [result.session.confirmation.scheduledDate, result.session.confirmation.scheduledTime].filter(Boolean).join(' ');
        alert(`📨 Booking confirmation detected${confirmationId}${confirmationTime ? ` (${confirmationTime})` : ''}`, 'success');
      }

      if (!config.requireFinalHumanApproval) {
        alert('ℹ HITL was not used because autonomous flow reached submit-ready state without blockers.', 'info');
      }

      await createGovernmentRequest({
        userId: config.userId,
        description: 'Autonomous booking successfully submitted',
        status: 'approved',
        notes: JSON.stringify({
          submittedAt: new Date().toISOString(),
          slotCheckNumber: checkCount,
          sessionState: result?.session?.state,
          selectedAppointmentOptions: result?.session?.selectedAppointmentOptions || [],
          confirmation: result?.session?.confirmation || null,
        }),
      });
      bookingCompleted = true;
      return { ok: true, submitted: true };
    } else {
      const state = String(result?.session?.state || '').toUpperCase();
      alert(`⚠ Booking attempt resulted in state: ${state}`, 'warning');
      if (Array.isArray(result?.session?.appointmentCandidatePreview) && result.session.appointmentCandidatePreview.length > 0) {
        const topChoices = result.session.appointmentCandidatePreview
          .slice(0, 3)
          .map((item, idx) => {
            const label = item?.text || [item?.dataDate, item?.dataTime].filter(Boolean).join(' ') || 'unknown';
            return `#${idx + 1} ${label} (score=${Number(item?.score || 0)})`;
          })
          .join(' | ');
        alert(`🧪 Top considered slot choices: ${topChoices}`, 'info');
      }
      if (String(result?.reason || '').toLowerCase() === 'final-human-approval-required') {
        alert('🧑‍💻 Final human approval is required by configuration.', 'warning');
        const sessionToken = String(result?.session?.token || '').trim();
        if (sessionToken) {
          alert(`🔐 HITL session token: ${sessionToken}`, 'info');
        }

        if (config.interactiveFinalApproval && process.stdin?.isTTY && process.stdout?.isTTY && sessionToken) {
          const rl = readline.createInterface({ input, output });
          try {
            const approveAnswer = String(await rl.question('? Approve and submit now? [y/N]: ') || '').trim().toLowerCase();
            if (['y', 'yes'].includes(approveAnswer)) {
              await approveAttendedBookingSubmit(sessionToken, {
                approvedBy: 'human-cli',
                reason: 'interactive-final-approval',
              });
              const submittedSession = await submitAttendedBookingSession(sessionToken);
              const submittedState = String(submittedSession?.state || '').toUpperCase();
              alert(`✅ Final submit executed from CLI prompt (state=${submittedState || 'unknown'})`, 'success');

              await createGovernmentRequest({
                userId: config.userId,
                description: 'Booking submitted via interactive final approval',
                status: 'approved',
                notes: JSON.stringify({
                  submittedAt: new Date().toISOString(),
                  slotCheckNumber: checkCount,
                  sessionState: submittedSession?.state || null,
                  via: 'interactive-final-approval',
                  token: sessionToken,
                }),
              }).catch(() => null);

              bookingCompleted = true;
              return { ok: true, submitted: true, via: 'interactive-final-approval' };
            }
            alert('ℹ Final submit deferred. Session remains in READY_TO_SUBMIT until approved manually.', 'info');
          } finally {
            rl.close();
          }
        } else {
          alert('ℹ Run with a TTY to approve directly in CLI, or use HITL API/UI actions with the session token.', 'info');
        }
      }
      const challengeState = state || String(result?.reason || '').toUpperCase();
      if (['AWAITING_LOGIN', 'AWAITING_OTP', 'AWAITING_CAPTCHA'].includes(challengeState)) {
        alert(`Human-checkpoint detected: ${challengeState}`, 'warning');

        if (config.allowOneTimeHumanFallback && !humanFallbackUsed) {
          humanFallbackUsed = true;
          mutableCreds = await collectOneTimeHumanChallengeInputs(challengeState, mutableCreds);

          alert('🧭 Running one-time headed fallback (human can intervene once, then continue autonomous)', 'info');
          result = await runTelAvivFullyAutomatedBooking({
            applicant: {
              ...buildApplicant(),
              loginUsername: mutableCreds.loginUsername,
              loginPassword: mutableCreds.loginPassword,
              otpCode: mutableCreds.otpCode || '',
              otpPolicy: mutableCreds.otpPolicy || config.otpPolicyDefault,
              totpSecret: mutableCreds.totpSecret || '',
            },
            intentText: config.userRequest,
            dryRun: config.dryRun,
            confirmedSubmit: !config.dryRun,
            headless: false,
            maxRuntimeMs: config.humanInterventionTimeoutMs,
            pollIntervalMs: 2000,
            keepSessionOnFailure: false,
            allowHumanIntervention: true,
            humanInterventionTimeoutMs: config.humanInterventionTimeoutMs,
            requireFinalHumanApproval: config.requireFinalHumanApproval,
            autoApproveValidatedSubmit: config.autoApproveValidatedSubmit,
          });

          if (result?.submitted) {
            alert('✅ Booking submitted after one-time human fallback', 'success');
            if (result?.session?.state) {
              alert(`📌 Final booking state: ${result.session.state}`, 'success');
            }
            return { ok: true, submitted: true, via: 'one-time-human-fallback' };
          }
        }
      }
      return { ok: false, submitted: false, state };
    }
  } catch (err) {
    alert(`✗ Booking attempt failed: ${err?.message || err}`, 'error');
    return { ok: false, error: err?.message || String(err) };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// MAIN ORCHESTRATION
// ────────────────────────────────────────────────────────────────────────────

async function runAutonomousBookingLoop() {
  await ensureGovernmentRequestsTable();

  console.log('\n╔════════════════════════════════════════════════════════════════════╗');
  console.log('║     🤖 AUTONOMOUS BOOKING WITH CONTINUOUS SLOT MONITORING        ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝\n');

  // Collect credentials once
  const credentials = await askForCredentialsIfNeeded();
  if (!credentials) {
    alert('❌ Cannot proceed without credentials', 'error');
    process.exit(1);
  }

  alert(`📋 Configuration:`, 'info');
  console.log(`   Category: ${config.category}`);
  console.log(`   Website: ${config.websiteUrl}`);
  console.log(`   Polling every ${config.pollingIntervalMs / 1000}s`);
  console.log(`   Max runtime: ${config.maxRuntimeMinutes} minutes`);
  console.log(`   Auto-book on slots: ${config.autoBookOnSlots ? 'YES' : 'NO'}\n`);
  console.log(`   Proactive date/time booking: ${config.proactiveBookingOnSelectionPage ? `YES (every ${config.proactiveBookingIntervalChecks} checks)` : 'NO'}\n`);
  const profileForDisplay = credentials?.applicantProfile && typeof credentials.applicantProfile === 'object'
    ? credentials.applicantProfile
    : {};
  const effectiveSlotPolicy = explicitPreferenceOverrides.slotSelectionPolicy
    ? (config.slotSelectionPolicy || 'score')
    : String(profileForDisplay.slotSelectionPolicy || config.slotSelectionPolicy || 'score').trim().toLowerCase();
  const effectivePreferredDate = explicitPreferenceOverrides.preferredDate
    ? (config.preferredDate || 'none')
    : (profileForDisplay.preferredDate || config.preferredDate || 'none');
  const effectivePreferredTime = explicitPreferenceOverrides.preferredTime
    ? (config.preferredTime || 'none')
    : (profileForDisplay.preferredTime || config.preferredTime || 'none');
  const effectivePreferredTimes = explicitPreferenceOverrides.preferredTimes
    ? (config.preferredTimes || 'none')
    : (profileForDisplay.preferredTimes || config.preferredTimes || 'none');
  const effectivePreferredWindow = explicitPreferenceOverrides.preferredTimeWindow
    ? (config.preferredTimeWindow || 'none')
    : (profileForDisplay.preferredTimeWindow || config.preferredTimeWindow || 'none');
  console.log(`   Slot policy: ${effectiveSlotPolicy}`);
  console.log(`   Preferred date/time: date=${effectivePreferredDate}, time=${effectivePreferredTime}, list=${effectivePreferredTimes}, window=${effectivePreferredWindow}`);
  console.log(`   Final human approval required: ${config.requireFinalHumanApproval ? 'YES' : 'NO'}\n`);
  if (config.requireFinalHumanApproval && config.autoApproveValidatedSubmit) {
    console.log('   Final step policy: autonomous validator may approve+submit only if all required fields are filled and matched\n');
  }
  if (config.autoBridgeToHitl) {
    alert(`🧭 HITL auto-bridge enabled (after ${config.bridgeAfterChecks} no-slot checks, max failures ${config.maxHitlBridgeFailures})`, 'info');
  }

  const startTime = Date.now();
  const maxRuntimeMs = config.maxRuntimeMinutes * 60 * 1000;
  let stopped = false;

  // Initial check
  if (!config.skipFirstCheck) {
    alert('🔍 Performing initial check...', 'info');
    await performSlotCheck(credentials);
    if (bookingCompleted || lastBookingOutcome?.submitted) {
      alert('🛑 Booking already submitted in initial check; stopping monitor loop.', 'success');
      stopped = true;
    }
  }

  // Polling loop
  process.on('SIGINT', () => {
    alert('\n⏹ Received stop signal (Ctrl+C)', 'warning');
    stopped = true;
  });

  alert('⏳ Starting polling loop (Ctrl+C to stop)...', 'info');

  while (!stopped) {
    if (bookingCompleted || lastBookingOutcome?.submitted) {
      alert('🛑 Booking submitted already; stopping monitor loop.', 'success');
      break;
    }
    const elapsed = Date.now() - startTime;
    if (elapsed > maxRuntimeMs) {
      alert(`⏰ Max runtime (${config.maxRuntimeMinutes}m) reached. Stopping.`, 'warning');
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, config.pollingIntervalMs));

    const checkResult = await performSlotCheck(credentials);
    if (bookingCompleted || lastBookingOutcome?.submitted) {
      alert('🛑 Booking submitted successfully; stopping monitor loop.', 'success');
      break;
    }
    if (!checkResult.ok && consecutiveErrors >= config.maxRetries) {
      break;
    }
  }

  // Summary
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('\n' + '═'.repeat(70));
  console.log('📊 SESSION SUMMARY:');
  console.log(`   Checks performed: ${checkCount}`);
  console.log(`   Slots found: ${slotFoundCount}`);
  console.log(`   Booking attempts: ${bookingAttemptCount}`);
  console.log(`   Human fallback used: ${humanFallbackUsed ? 'YES' : 'NO'}`);
  console.log(`   HITL bridge started: ${hitlBridgeStarted ? 'YES' : 'NO'}`);
  console.log(`   HITL bridge failures: ${hitlBridgeFailureCount}`);
  if (lastBookingOutcome) {
    console.log(`   Last booking outcome: ${JSON.stringify(lastBookingOutcome)}`);
  }
  if (hitlSessionToken) {
    console.log(`   HITL session token: ${hitlSessionToken}`);
  }
  if (lastSlotFoundAt) {
    console.log(`   Last slot found: ${lastSlotFoundAt}`);
  }
  console.log(`   Runtime: ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
  console.log('═'.repeat(70) + '\n');

  alert('✓ Autonomous booking session ended', 'info');
}

// ────────────────────────────────────────────────────────────────────────────

runAutonomousBookingLoop().catch(async (err) => {
  const message = err?.message || String(err);
  alert(`❌ ERROR: ${message}`, 'error');
  try {
    await createGovernmentRequest({
      userId: config.userId,
      description: 'Autonomous booking session failed',
      status: 'error',
      notes: message,
    });
  } catch {
    // Silent fail
  }
  process.exit(1);
});
