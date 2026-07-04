/**
 * run_local_gov_api_booking.js
 *
 * Full efficient command-bus orchestration flow for municipal appointment handling.
 * PRE-STEP: security:init runs automatically via npm "prelocal-gov:api:book" hook.
 *
 * Includes (efficiently, in one script):
 *  1) Official API check
 *  2) Cached data check (RAG docs)
 *  3) Browser scraper + optional re-ingest + autonomous browser automation
 *  4) Network inspection + resources/page inspection
 *  5) Command bus orchestration
 *  6) Action index + tool retrieval + permission grant ahead + monitor engine (via backend endpoint)
 *  7) Store all results
 *
 * Additional capabilities integrated:
 *  - Human-in-the-loop checkpoints (login / OTP / captcha)
 *  - Autonomous API discovery (any website) + reverse engineering
 *  - GET /slots + POST /schedule endpoint execution path
 *  - page.on('response') powered inspection (inside inspectBookingSiteNetwork)
 *  - JavaScript scan + web worker + service worker discovery
 *  - Endpoint harvesting + self-healing automation + self-extending architecture
 */
import 'dotenv/config';

import { getPoolSummary, waitForDatabaseReady } from '../config/db.js';
import {
  ensureGovernmentRequestsTable,
  createGovernmentRequest,
} from '../agents/dbTools.js';
import {
  ingestLocalGovernmentWebToRag,
  getLocalGovernmentRagStats,
} from '../making_operations/local_government/operations.js';
import {
  getTelAvivOfficialAppointmentApiConfig,
  scheduleTelAvivAppointmentOfficial,
  MunicipalityApiUnavailableError,
  MunicipalityApiCallError,
} from '../making_operations/local_government/official_appointment_api.js';
import {
  inspectBookingSiteNetwork,
  runTelAvivFullyAutomatedBooking,
  loadBookingCredentials,
  getBookingCredentialsMeta,
  saveBookingCredentials,
} from '../making_operations/local_government/browser_appointment_agent.js';
import { runDiscoverAPINode } from '../making_operations/local_government/discover_api_node.js';
import { runSelfExtendingAgent } from '../making_operations/local_government/self_extending_agent.js';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const args = process.argv.slice(2);

const hasFlag = (name) => args.includes(name);
function getArgValue(name, fallback = '') {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return String(args[idx + 1] || '').trim();
  return fallback;
}

const flowOptions = {
  websiteUrl: getArgValue('--website-url', process.env.TEL_AVIV_APPOINTMENT_PUBLIC_URL || 'https://www.tel-aviv.gov.il/Contact/Pages/Appointments.aspx'),
  userRequest: getArgValue('--request', process.env.APPT_NOTES || 'arnona appointment - check slots and schedule'),
  userId: process.env.APPT_USER_ID || 'cli-api-booking',
  category: process.env.APPT_CATEGORY || 'arnona',
  dryRun: hasFlag('--dry-run') || String(process.env.APPT_DRY_RUN || 'false').toLowerCase() === 'true',
  skipRagIngest: hasFlag('--skip-rag-ingest'),
  skipNetwork: hasFlag('--skip-network'),
  skipDiscovery: hasFlag('--skip-discovery'),
  skipSelfExtending: hasFlag('--skip-self-extending'),
  skipBrowserAutomation: hasFlag('--skip-browser-automation'),
  apiOnly: hasFlag('--api-only'),
  browserOnly: hasFlag('--browser-only'),
  monitor: !hasFlag('--skip-monitor'),
  autonomous: !hasFlag('--human-only'),
  humanInLoop: !hasFlag('--no-hitl'),
  allowOneTimeHumanFallback: !hasFlag('--disable-human-fallback') && String(process.env.APPT_ALLOW_HUMAN_FALLBACK || 'true').toLowerCase() !== 'false',
  humanInterventionTimeoutMs: Math.max(60000, Number(getArgValue('--human-timeout-ms', process.env.APPT_HUMAN_TIMEOUT_MS || 600000)) || 600000),
  otpPolicyDefault: String(process.env.BOOKING_OTP_POLICY || process.env.APPT_OTP_POLICY || 'static').toLowerCase(),
  askOnceAhead: hasFlag('--ask-once') || String(process.env.APPT_ASK_ONCE || 'false').toLowerCase() === 'true',
  grantPermissionAhead: !hasFlag('--skip-permission-grant'),
  backendBaseUrl: getArgValue('--backend-base-url', process.env.BACKEND_BASE_URL || 'http://localhost:3000'),
  maxAutonomousSteps: Math.max(1, Math.min(8, Number(getArgValue('--max-autonomous-steps', process.env.APPT_MAX_AUTONOMOUS_STEPS || 4)) || 4)),
  maxNetworkEntries: Math.max(50, Number(getArgValue('--max-network-entries', process.env.APPT_MAX_NETWORK_ENTRIES || 250)) || 250),
  forceRagIngest: hasFlag('--force-rag-ingest'),
  forceNetworkInspection: hasFlag('--force-network-inspection'),
  eagerBrowserFallback: hasFlag('--eager-browser-fallback') || String(process.env.APPT_EAGER_BROWSER_FALLBACK || 'false').toLowerCase() === 'true',
};

const report = {
  ok: true,
  mode: 'local-gov:api:book-command-bus',
  startedAt: new Date().toISOString(),
  options: flowOptions,
  steps: {},
  actionIndex: {},
  commandBus: [],
  humanInLoop: null,
  autonomous: null,
};

function addCommand(command, status, details = null) {
  report.commandBus.push({ command, status, at: new Date().toISOString(), details });
}

function summarizeResources(inspection = {}) {
  const net = Array.isArray(inspection?.networkRequests) ? inspection.networkRequests : [];
  const byMethod = net.reduce((acc, row) => {
    const method = String(row?.method || 'UNKNOWN').toUpperCase();
    acc[method] = Number(acc[method] || 0) + 1;
    return acc;
  }, {});

  return {
    networkCount: Number(inspection?.networkCount || net.length || 0),
    apiLikeCount: net.length,
    byMethod,
    pageResources: {
      scripts: Array.isArray(inspection?.pageAnalysis?.scriptUrls) ? inspection.pageAnalysis.scriptUrls.length : 0,
      forms: Array.isArray(inspection?.pageAnalysis?.forms) ? inspection.pageAnalysis.forms.length : 0,
      buttons: Array.isArray(inspection?.pageAnalysis?.buttons) ? inspection.pageAnalysis.buttons.length : 0,
      sourceApiMatches: Array.isArray(inspection?.pageAnalysis?.sourceApiMatches) ? inspection.pageAnalysis.sourceApiMatches.length : 0,
    },
    javascriptScan: {
      scannedCount: Number(inspection?.javascriptScan?.scannedCount || 0),
      endpointCount: Array.isArray(inspection?.javascriptScan?.endpoints) ? inspection.javascriptScan.endpoints.length : 0,
      workerScripts: Array.isArray(inspection?.javascriptScan?.workerScripts) ? inspection.javascriptScan.workerScripts.length : 0,
      discoverAPIWebWorkers: Array.isArray(inspection?.javascriptScan?.discoverAPIWebWorkers) ? inspection.javascriptScan.discoverAPIWebWorkers.length : 0,
      serviceWorkerSupported: Boolean(inspection?.pageAnalysis?.serviceWorker?.supported),
    },
  };
}

function buildActionIndex(discoveryResult = {}) {
  const apis = Array.isArray(discoveryResult?.catalog?.apis) ? discoveryResult.catalog.apis : [];

  const slotsCandidates = apis.filter((api) => {
    const m = String(api?.method || '').toUpperCase();
    const p = String(api?.path || api?.url || '').toLowerCase();
    return m === 'GET' && (/slot|calendar|avail|times?/.test(p) || String(api?.kind || '').toLowerCase() === 'slots');
  }).slice(0, 12);

  const scheduleCandidates = apis.filter((api) => {
    const m = String(api?.method || '').toUpperCase();
    const p = String(api?.path || api?.url || '').toLowerCase();
    return ['POST', 'PUT', 'PATCH'].includes(m) && (/schedule|book|reserve|appoint|create/.test(p) || String(api?.kind || '').toLowerCase() === 'schedule');
  }).slice(0, 12);

  const calendarCandidates = slotsCandidates.filter((api) => /calendar/.test(String(api?.path || api?.url || '').toLowerCase())).slice(0, 8);

  return {
    totalDiscoveredApis: apis.length,
    toolRetrieval: {
      getSlotsTools: slotsCandidates.map((x) => ({ id: x.id, method: x.method, url: x.url, score: x.score })),
      apiCalendarTools: calendarCandidates.map((x) => ({ id: x.id, method: x.method, url: x.url, score: x.score })),
      postScheduleTools: scheduleCandidates.map((x) => ({ id: x.id, method: x.method, url: x.url, score: x.score })),
    },
  };
}

function askableTty() {
  return Boolean(process.stdin?.isTTY && process.stdout?.isTTY);
}

function challengeStateFromResult(result = {}) {
  const state = String(result?.session?.state || '').toUpperCase();
  if (['AWAITING_LOGIN', 'AWAITING_OTP', 'AWAITING_CAPTCHA'].includes(state)) return state;
  const reason = String(result?.reason || '').toLowerCase();
  if (reason.includes('captcha')) return 'AWAITING_CAPTCHA';
  if (reason.includes('otp')) return 'AWAITING_OTP';
  if (reason.includes('login')) return 'AWAITING_LOGIN';
  return '';
}

function masked(value = '') {
  const text = String(value || '').trim();
  if (!text) return '(not set)';
  if (text.length <= 2) return '*'.repeat(text.length);
  return `${'*'.repeat(Math.max(1, text.length - 2))}${text.slice(-2)}`;
}

async function maybeAskHumanInputAhead() {
  if (!flowOptions.humanInLoop || !flowOptions.askOnceAhead) {
    addCommand('ask-human-input-ahead', 'skipped', { reason: 'disabled' });
    return { skipped: true };
  }
  if (!askableTty()) {
    addCommand('ask-human-input-ahead', 'skipped', { reason: 'non-interactive-terminal' });
    return { skipped: true, reason: 'non-interactive-terminal' };
  }

  const rl = readline.createInterface({ input, output });
  try {
    console.log('\n──── One-time human input (optional) ────');
    console.log('Press Enter to keep existing env/saved value.');

    const loginUsername = await rl.question(`Login username [${process.env.APPT_LOGIN_USER ? masked(process.env.APPT_LOGIN_USER) : ''}]: `);
    const loginPassword = await rl.question(`Login password [${process.env.APPT_LOGIN_PASS ? masked(process.env.APPT_LOGIN_PASS) : ''}]: `);
    const otpPolicyInput = await rl.question(`OTP policy [static/totp/manual] (default: ${flowOptions.otpPolicyDefault}): `);
    const otpPolicy = String(otpPolicyInput || flowOptions.otpPolicyDefault || 'static').trim().toLowerCase();
    const otpCode = otpPolicy === 'totp'
      ? ''
      : await rl.question(`OTP code [${process.env.APPT_OTP ? masked(process.env.APPT_OTP) : ''}]: `);
    const totpSecret = otpPolicy === 'totp'
      ? await rl.question(`TOTP secret [${process.env.BOOKING_TOTP_SECRET ? '***' : ''}]: `)
      : '';
    const fullName = await rl.question(`Applicant full name [${process.env.APPT_FULL_NAME || ''}]: `);
    const idNumber = await rl.question(`Applicant ID [${process.env.APPT_ID || ''}]: `);
    const phone = await rl.question(`Applicant phone [${process.env.APPT_PHONE || ''}]: `);
    const email = await rl.question(`Applicant email [${process.env.APPT_EMAIL || ''}]: `);

    const finalLoginUser = String(loginUsername || process.env.APPT_LOGIN_USER || '').trim();
    const finalLoginPass = String(loginPassword || process.env.APPT_LOGIN_PASS || '').trim();
    const finalOtp = String(otpCode || process.env.APPT_OTP || '').trim();
    const finalTotpSecret = String(totpSecret || process.env.BOOKING_TOTP_SECRET || '').trim();

    if (finalLoginUser || finalLoginPass || finalOtp) {
      await saveBookingCredentials({
        loginUsername: finalLoginUser,
        loginPassword: finalLoginPass,
        otpCode: finalOtp,
        otpPolicy,
        totpSecret: finalTotpSecret,
        applicantProfile: {
          fullName: String(fullName || process.env.APPT_FULL_NAME || '').trim(),
          idNumber: String(idNumber || process.env.APPT_ID || '').trim(),
          phone: String(phone || process.env.APPT_PHONE || '').trim(),
          email: String(email || process.env.APPT_EMAIL || '').trim(),
        },
      });
    } else if (String(fullName || '').trim() || String(idNumber || '').trim() || String(phone || '').trim() || String(email || '').trim()) {
      await saveBookingCredentials({
        loginUsername: process.env.APPT_LOGIN_USER || '',
        loginPassword: process.env.APPT_LOGIN_PASS || '',
        otpCode: process.env.APPT_OTP || '',
        otpPolicy,
        totpSecret: finalTotpSecret,
        applicantProfile: {
          fullName: String(fullName || process.env.APPT_FULL_NAME || '').trim(),
          idNumber: String(idNumber || process.env.APPT_ID || '').trim(),
          phone: String(phone || process.env.APPT_PHONE || '').trim(),
          email: String(email || process.env.APPT_EMAIL || '').trim(),
        },
      });
    }

    if (String(fullName || '').trim()) process.env.APPT_FULL_NAME = String(fullName).trim();
    if (String(idNumber || '').trim()) process.env.APPT_ID = String(idNumber).trim();
    if (String(phone || '').trim()) process.env.APPT_PHONE = String(phone).trim();
    if (String(email || '').trim()) process.env.APPT_EMAIL = String(email).trim();
    if (finalLoginUser) process.env.APPT_LOGIN_USER = finalLoginUser;
    if (finalLoginPass) process.env.APPT_LOGIN_PASS = finalLoginPass;
    if (finalOtp) process.env.APPT_OTP = finalOtp;
    process.env.BOOKING_OTP_POLICY = otpPolicy;
    if (finalTotpSecret) process.env.BOOKING_TOTP_SECRET = finalTotpSecret;

    addCommand('ask-human-input-ahead', 'ok', {
      hasLoginUser: Boolean(finalLoginUser),
      hasLoginPass: Boolean(finalLoginPass),
      hasOtp: Boolean(finalOtp),
      otpPolicy,
      hasTotpSecret: Boolean(finalTotpSecret),
      hasApplicantCore: Boolean(process.env.APPT_FULL_NAME || process.env.APPT_ID),
    });

    return {
      ok: true,
      hasLoginUser: Boolean(finalLoginUser),
      hasLoginPass: Boolean(finalLoginPass),
      hasOtp: Boolean(finalOtp),
      otpPolicy,
      hasTotpSecret: Boolean(finalTotpSecret),
    };
  } finally {
    rl.close();
  }
}

async function collectOneTimeHumanChallengeInputs(stateUpper, baseCreds = {}) {
  if (!askableTty()) return baseCreds;
  const rl = readline.createInterface({ input, output });
  try {
    const creds = { ...(baseCreds || {}) };

    if (stateUpper === 'AWAITING_LOGIN') {
      const loginUsername = await rl.question(`Updated login username [${creds.loginUsername ? masked(creds.loginUsername) : ''}]: `);
      const loginPassword = await rl.question(`Updated login password [${creds.loginPassword ? masked(creds.loginPassword) : ''}]: `);
      if (String(loginUsername || '').trim()) creds.loginUsername = String(loginUsername).trim();
      if (String(loginPassword || '').trim()) creds.loginPassword = String(loginPassword).trim();
    }

    if (stateUpper === 'AWAITING_OTP') {
      const otpPolicyInput = await rl.question(`OTP policy [static/totp/manual] (default: ${creds.otpPolicy || flowOptions.otpPolicyDefault}): `);
      const otpPolicy = String(otpPolicyInput || creds.otpPolicy || flowOptions.otpPolicyDefault || 'static').trim().toLowerCase();
      creds.otpPolicy = otpPolicy;
      if (otpPolicy === 'totp') {
        const totpSecret = await rl.question(`TOTP secret [${creds.totpSecret ? '***' : ''}]: `);
        if (String(totpSecret || '').trim()) creds.totpSecret = String(totpSecret).trim();
        creds.otpCode = '';
      } else {
        const otpCode = await rl.question(`OTP code [${creds.otpCode ? masked(creds.otpCode) : ''}]: `);
        if (String(otpCode || '').trim()) creds.otpCode = String(otpCode).trim();
      }
    }

    await saveBookingCredentials(creds);

    if (creds.loginUsername) process.env.APPT_LOGIN_USER = creds.loginUsername;
    if (creds.loginPassword) process.env.APPT_LOGIN_PASS = creds.loginPassword;
    if (creds.otpCode) process.env.APPT_OTP = creds.otpCode;
    if (creds.otpPolicy) process.env.BOOKING_OTP_POLICY = creds.otpPolicy;
    if (creds.totpSecret) process.env.BOOKING_TOTP_SECRET = creds.totpSecret;

    addCommand('one-time-human-fallback-input', 'ok', {
      state: stateUpper,
      otpPolicy: creds.otpPolicy || flowOptions.otpPolicyDefault,
      hasTotpSecret: Boolean(creds.totpSecret),
    });
    return creds;
  } finally {
    rl.close();
  }
}

async function maybeGrantPermissionAhead() {
  if (!flowOptions.grantPermissionAhead) {
    addCommand('grant-permission-ahead', 'skipped', { reason: '--skip-permission-grant' });
    return { skipped: true };
  }

  const url = `${String(flowOptions.backendBaseUrl || '').replace(/\/+$/, '')}/api/government/agent-permission/grant`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        userId: flowOptions.userId,
        approvedBy: 'cli-user',
        ttlDays: 30,
        scopes: ['bookings'],
        notes: 'local-gov:api:book command bus pre-grant',
      }),
    });
    const parsed = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      addCommand('grant-permission-ahead', 'failed', { status: resp.status, response: parsed });
      return { ok: false, status: resp.status, response: parsed };
    }
    addCommand('grant-permission-ahead', 'ok', { tokenIssued: Boolean(parsed?.permission?.token) });
    return { ok: true, token: parsed?.permission?.token || '', permission: parsed?.permission || null };
  } catch (err) {
    addCommand('grant-permission-ahead', 'skipped', { reason: `backend-unreachable:${err?.message || err}` });
    return { ok: false, skipped: true, reason: err?.message || String(err) };
  }
}

async function maybeStartMonitorEngine(permissionToken = '') {
  if (!flowOptions.monitor) {
    addCommand('appointment-monitor-engine', 'skipped', { reason: '--skip-monitor' });
    return { skipped: true };
  }
  if (!permissionToken) {
    addCommand('appointment-monitor-engine', 'skipped', { reason: 'no-permission-token' });
    return { skipped: true, reason: 'no-permission-token' };
  }

  const url = `${String(flowOptions.backendBaseUrl || '').replace(/\/+$/, '')}/api/government/appointments/monitor/start`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${permissionToken}`,
      },
      body: JSON.stringify({
        userId: flowOptions.userId,
        intentText: flowOptions.userRequest,
        bookingUrl: flowOptions.websiteUrl,
        autonomousBrowse: flowOptions.autonomous,
        maxAutonomousSteps: flowOptions.maxAutonomousSteps,
      }),
    });
    const parsed = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      addCommand('appointment-monitor-engine', 'failed', { status: resp.status, response: parsed });
      return { ok: false, status: resp.status, response: parsed };
    }
    addCommand('appointment-monitor-engine', 'ok', { monitorId: parsed?.monitor?.id || null });
    return { ok: true, monitor: parsed?.monitor || null, firstResult: parsed?.firstResult || null };
  } catch (err) {
    addCommand('appointment-monitor-engine', 'skipped', { reason: `backend-unreachable:${err?.message || err}` });
    return { ok: false, skipped: true, reason: err?.message || String(err) };
  }
}

async function maybeRunBackendDiscoveryEndpoints(permissionToken = '') {
  if (!permissionToken) {
    addCommand('backend-api-discovery-endpoints', 'skipped', { reason: 'no-permission-token' });
    return { skipped: true, reason: 'no-permission-token' };
  }
  const base = String(flowOptions.backendBaseUrl || '').replace(/\/+$/, '');
  try {
    const runResp = await fetch(`${base}/api/government/appointments/api-discovery/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${permissionToken}`,
      },
      body: JSON.stringify({
        bookingUrl: flowOptions.websiteUrl,
        intentText: flowOptions.userRequest,
        autonomousBrowse: flowOptions.autonomous,
        maxAutonomousSteps: flowOptions.maxAutonomousSteps,
        maxNetworkEntries: flowOptions.maxNetworkEntries,
        persist: true,
      }),
    });
    const runJson = await runResp.json().catch(() => ({}));
    if (!runResp.ok) {
      addCommand('backend-api-discovery-endpoints', 'failed', { stage: 'run', status: runResp.status, response: runJson });
      return { ok: false, stage: 'run', status: runResp.status, response: runJson };
    }

    const catalogResp = await fetch(`${base}/api/government/appointments/api-discovery/catalog?action=slots`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${permissionToken}` },
    });
    const catalogJson = await catalogResp.json().catch(() => ({}));

    const execSlotsResp = await fetch(`${base}/api/government/appointments/api-discovery/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${permissionToken}`,
      },
      body: JSON.stringify({ action: 'slots' }),
    });
    const execSlotsJson = await execSlotsResp.json().catch(() => ({}));

    const execScheduleResp = await fetch(`${base}/api/government/appointments/api-discovery/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${permissionToken}`,
      },
      body: JSON.stringify({
        action: 'schedule',
        payload: {
          userId: flowOptions.userId,
          category: flowOptions.category,
          notes: flowOptions.userRequest,
        },
      }),
    });
    const execScheduleJson = await execScheduleResp.json().catch(() => ({}));

    const result = {
      ok: true,
      run: runJson,
      catalog: catalogJson,
      executeSlots: execSlotsJson,
      executeSchedule: execScheduleJson,
      status: {
        run: runResp.status,
        catalog: catalogResp.status,
        executeSlots: execSlotsResp.status,
        executeSchedule: execScheduleResp.status,
      },
    };

    addCommand('backend-api-discovery-endpoints', 'ok', {
      discovered: Number(runJson?.discoveredApis?.length || 0),
      slotsStatus: execSlotsResp.status,
      scheduleStatus: execScheduleResp.status,
    });
    return result;
  } catch (err) {
    addCommand('backend-api-discovery-endpoints', 'skipped', { reason: `backend-unreachable:${err?.message || err}` });
    return { ok: false, skipped: true, reason: err?.message || String(err) };
  }
}

async function runOfficialApiBooking() {
  const notes = flowOptions.userRequest;
  const category = flowOptions.category;
  const userId = flowOptions.userId;
  try {
    const scheduling = await scheduleTelAvivAppointmentOfficial({ userId, description: notes, notes, category });
    addCommand('official-api-booking', 'ok', {
      endpoint: scheduling?.endpoint || null,
      confirmed: Boolean(scheduling?.appointment?.confirmed),
    });
    return { ok: true, scheduling };
  } catch (err) {
    const known = err instanceof MunicipalityApiUnavailableError || err instanceof MunicipalityApiCallError;
    addCommand('official-api-booking', 'failed', { known, error: err?.message || String(err) });
    return {
      ok: false,
      known,
      error: err?.message || String(err),
      details: err?.details || null,
    };
  }
}

async function runAutonomousBrowserBooking() {
  const savedCreds = await loadBookingCredentials();
  if (savedCreds?.applicantProfile) {
    if (!process.env.APPT_FULL_NAME && savedCreds.applicantProfile.fullName) process.env.APPT_FULL_NAME = savedCreds.applicantProfile.fullName;
    if (!process.env.APPT_ID && savedCreds.applicantProfile.idNumber) process.env.APPT_ID = savedCreds.applicantProfile.idNumber;
    if (!process.env.APPT_PHONE && savedCreds.applicantProfile.phone) process.env.APPT_PHONE = savedCreds.applicantProfile.phone;
    if (!process.env.APPT_EMAIL && savedCreds.applicantProfile.email) process.env.APPT_EMAIL = savedCreds.applicantProfile.email;
  }
  let mergedCreds = {
    loginUsername: String(process.env.APPT_LOGIN_USER || savedCreds?.loginUsername || '').trim(),
    loginPassword: String(process.env.APPT_LOGIN_PASS || savedCreds?.loginPassword || '').trim(),
    otpCode: String(process.env.APPT_OTP || savedCreds?.otpCode || '').trim(),
    otpPolicy: String(process.env.BOOKING_OTP_POLICY || savedCreds?.otpPolicy || flowOptions.otpPolicyDefault || 'static').trim().toLowerCase(),
    totpSecret: String(process.env.BOOKING_TOTP_SECRET || savedCreds?.totpSecret || '').trim(),
  };

  const buildApplicant = () => ({
    fullName: process.env.APPT_FULL_NAME || savedCreds?.applicantProfile?.fullName || '',
    idNumber: process.env.APPT_ID || savedCreds?.applicantProfile?.idNumber || '',
    phone: process.env.APPT_PHONE || savedCreds?.applicantProfile?.phone || '',
    email: process.env.APPT_EMAIL || savedCreds?.applicantProfile?.email || '',
    notes: flowOptions.userRequest,
    ...(mergedCreds.loginUsername ? { loginUsername: mergedCreds.loginUsername } : {}),
    ...(mergedCreds.loginPassword ? { loginPassword: mergedCreds.loginPassword } : {}),
    ...(mergedCreds.otpCode ? { otpCode: mergedCreds.otpCode } : {}),
    ...(mergedCreds.otpPolicy ? { otpPolicy: mergedCreds.otpPolicy } : {}),
    ...(mergedCreds.totpSecret ? { totpSecret: mergedCreds.totpSecret } : {}),
    reusePersistentProfile: true,
  });

  const tracked = await createGovernmentRequest({
    userId: flowOptions.userId,
    description: flowOptions.userRequest,
    status: 'new',
    notes: 'Autonomous browser booking from local-gov:api:book command bus',
  });

  let browserResult = await runTelAvivFullyAutomatedBooking({
    requestId: tracked.id,
    applicant: buildApplicant(),
    intentText: flowOptions.userRequest,
    dryRun: flowOptions.dryRun,
    confirmedSubmit: !flowOptions.dryRun,
    headless: String(process.env.APPT_HEADLESS || 'true').toLowerCase() !== 'false',
    maxRuntimeMs: Math.max(60000, Number(process.env.APPT_MAX_RUNTIME_MS || 300000)),
    pollIntervalMs: 2500,
    keepSessionOnFailure: true,
    allowHumanIntervention: false,
    humanInterventionTimeoutMs: flowOptions.humanInterventionTimeoutMs,
  });

  const checkpointState = challengeStateFromResult(browserResult);
  if (!browserResult?.submitted && checkpointState && flowOptions.humanInLoop && flowOptions.allowOneTimeHumanFallback) {
    mergedCreds = await collectOneTimeHumanChallengeInputs(checkpointState, mergedCreds);
    browserResult = await runTelAvivFullyAutomatedBooking({
      requestId: tracked.id,
      applicant: buildApplicant(),
      intentText: flowOptions.userRequest,
      dryRun: flowOptions.dryRun,
      confirmedSubmit: !flowOptions.dryRun,
      headless: false,
      maxRuntimeMs: flowOptions.humanInterventionTimeoutMs,
      pollIntervalMs: 2000,
      keepSessionOnFailure: true,
      allowHumanIntervention: true,
      humanInterventionTimeoutMs: flowOptions.humanInterventionTimeoutMs,
    });
  }

  const state = String(browserResult?.session?.state || '').toLowerCase();
  const needsHuman = ['awaiting_login', 'awaiting_otp', 'awaiting_captcha'].includes(state);

  report.humanInLoop = {
    enabled: flowOptions.humanInLoop,
    needed: needsHuman,
    state,
    resumeToken: browserResult?.session?.resumeToken || null,
    guidance: !needsHuman
      ? null
      : state === 'awaiting_login'
        ? 'Set APPT_LOGIN_USER/APPT_LOGIN_PASS or save credentials in UI, then rerun.'
        : state === 'awaiting_otp'
          ? 'Provide APPT_OTP and rerun, or use attended resume endpoint.'
          : 'CAPTCHA detected. Resume via attended mode in UI/backend endpoint.',
  };

  addCommand('autonomous-browser-booking', browserResult?.submitted ? 'ok' : (needsHuman ? 'human-in-loop' : 'pending'), {
    submitted: Boolean(browserResult?.submitted),
    sessionState: state || null,
  });

  return { ok: true, trackedRequestId: tracked.id, browserResult };
}

async function runFlow() {
  const dbReady = await waitForDatabaseReady({ access: 'write' });
  report.steps.dbReady = {
    ...dbReady,
    writePool: getPoolSummary('write'),
    readPool: getPoolSummary('read'),
  };
  addCommand('wait-for-db-ready', dbReady.ok ? 'ok' : 'failed', report.steps.dbReady);
  if (!dbReady.ok) {
    throw new Error(`Database not ready after ${dbReady.attempts} attempts: ${dbReady.error}`);
  }

  await ensureGovernmentRequestsTable();
  await maybeAskHumanInputAhead();

  console.log('\n════ local-gov:api:book (full command bus) ════');
  console.log(`website=${flowOptions.websiteUrl}`);
  console.log(`request="${flowOptions.userRequest}"`);

  const apiConfig = getTelAvivOfficialAppointmentApiConfig();
  report.steps.officialApi = {
    configured: apiConfig.configured,
    provider: apiConfig.provider,
    baseUrl: apiConfig.baseUrl,
    publicBookingUrl: apiConfig.publicBookingUrl,
  };
  addCommand('check-official-api', 'ok', { configured: apiConfig.configured });

  const cached = await getLocalGovernmentRagStats();
  report.steps.cachedData = {
    totalDocs: cached.totalDocs,
    distinctSources: cached.distinctSources,
    sources: cached.sources,
  };
  addCommand('check-cached-rag-docs', 'ok', { totalDocs: cached.totalDocs, distinctSources: cached.distinctSources });

  if (!flowOptions.browserOnly) {
    const officialBooking = await runOfficialApiBooking();
    report.steps.officialApiBooking = officialBooking;
  } else {
    report.steps.officialApiBooking = { skipped: true, reason: '--browser-only' };
    addCommand('official-api-booking', 'skipped', { reason: '--browser-only' });
  }

  const officialOk = Boolean(report.steps.officialApiBooking?.ok && report.steps.officialApiBooking?.scheduling?.appointment?.confirmed);
  const needsBrowserFallback = flowOptions.browserOnly || (!flowOptions.apiOnly && !officialOk);
  const shouldRunHeavyBrowserSteps = flowOptions.eagerBrowserFallback || needsBrowserFallback || flowOptions.forceNetworkInspection || flowOptions.forceRagIngest;
  const shouldRunRagIngest = !flowOptions.skipRagIngest && shouldRunHeavyBrowserSteps && (flowOptions.forceRagIngest || cached.totalDocs === 0);
  const shouldRunNetworkInspection = !flowOptions.skipNetwork && shouldRunHeavyBrowserSteps;
  const shouldRunDiscovery = !flowOptions.skipDiscovery && shouldRunHeavyBrowserSteps;
  const shouldRunMonitor = flowOptions.monitor && needsBrowserFallback;

  if (shouldRunRagIngest) {
    try {
      const ingest = await ingestLocalGovernmentWebToRag({
        urls: [flowOptions.websiteUrl],
        replaceExisting: true,
        chunkSize: 900,
        chunkOverlap: 120,
        maxChunksPerUrl: 40,
        minRelevanceScore: 1,
      });
      report.steps.ragIngest = ingest;
      addCommand('browser-scraper-reingest-rag', 'ok', { inserted: ingest?.inserted || 0 });
    } catch (err) {
      report.steps.ragIngest = { ok: false, error: err?.message || String(err) };
      addCommand('browser-scraper-reingest-rag', 'failed', { error: err?.message || String(err) });
    }
  } else {
    report.steps.ragIngest = { skipped: true, reason: flowOptions.skipRagIngest ? '--skip-rag-ingest' : (shouldRunHeavyBrowserSteps ? 'cached-rag-available' : 'browser-fallback-not-needed') };
    addCommand('browser-scraper-reingest-rag', 'skipped', report.steps.ragIngest);
  }

  if (shouldRunNetworkInspection) {
    const inspection = await inspectBookingSiteNetwork({
      bookingUrl: flowOptions.websiteUrl,
      intentText: flowOptions.userRequest,
      autonomousBrowse: flowOptions.autonomous,
      maxAutonomousSteps: flowOptions.maxAutonomousSteps,
      maxNetworkEntries: flowOptions.maxNetworkEntries,
      endpointHarvesting: {
        enabled: true,
        level: 'turbo20',
        strategy: 'high-level-efficient',
        browserAutomationHarvesting: true,
        includeWorkerScan: true,
        includeJsInspection: true,
        selfHealingSelectors: true,
        selfLearningSelectors: true,
      },
    });
    report.steps.networkInspection = inspection;
    report.steps.resourceInspection = summarizeResources(inspection);
    addCommand('network-and-resources-inspection', 'ok', {
      networkCount: report.steps.resourceInspection.networkCount,
      jsEndpoints: report.steps.resourceInspection.javascriptScan.endpointCount,
    });
  } else {
    report.steps.networkInspection = { skipped: true, reason: flowOptions.skipNetwork ? '--skip-network' : 'browser-fallback-not-needed' };
    report.steps.resourceInspection = { skipped: true, reason: report.steps.networkInspection.reason };
    addCommand('network-and-resources-inspection', 'skipped', { reason: report.steps.networkInspection.reason });
  }

  if (shouldRunDiscovery) {
    const discovery = await runDiscoverAPINode({
      websiteUrl: flowOptions.websiteUrl,
      userRequest: flowOptions.userRequest,
      executeAction: true,
      autonomousBrowse: flowOptions.autonomous,
      maxAutonomousSteps: flowOptions.maxAutonomousSteps,
      maxNetworkEntries: flowOptions.maxNetworkEntries,
      endpointHarvesting: {
        level: 'turbo20',
        strategy: 'high-level-efficient',
        browserAutomationHarvesting: true,
        includeWorkerScan: true,
        includeJsInspection: true,
        selfHealingSelectors: true,
        selfLearningSelectors: true,
      },
      adaptiveLearning: true,
      payload: {
        actionHint: 'schedule',
        userId: flowOptions.userId,
        category: flowOptions.category,
      },
    });
    report.steps.discoverAPINode = discovery;
    report.actionIndex = buildActionIndex(discovery);
    addCommand('discover-api-node-and-tool-retrieval', discovery?.ok ? 'ok' : 'failed', {
      discovered: Number(discovery?.discovery?.discoveredCount || 0),
      selected: discovery?.selectedEndpoint?.url || null,
    });
  } else {
    report.steps.discoverAPINode = { skipped: true, reason: flowOptions.skipDiscovery ? '--skip-discovery' : 'browser-fallback-not-needed' };
    report.actionIndex = { skipped: true, reason: report.steps.discoverAPINode.reason };
    addCommand('discover-api-node-and-tool-retrieval', 'skipped', { reason: report.steps.discoverAPINode.reason });
  }

  const permissionGrant = shouldRunMonitor ? await maybeGrantPermissionAhead() : { skipped: true, reason: 'monitor-not-needed' };
  report.steps.permissionGrantAhead = permissionGrant;

  const monitor = shouldRunMonitor ? await maybeStartMonitorEngine(permissionGrant?.token || '') : { skipped: true, reason: 'monitor-not-needed' };
  report.steps.appointmentMonitorEngine = monitor;

  const backendDiscovery = shouldRunHeavyBrowserSteps
    ? await maybeRunBackendDiscoveryEndpoints(permissionGrant?.token || '')
    : { skipped: true, reason: 'browser-fallback-not-needed' };
  report.steps.backendDiscoveryEndpoints = backendDiscovery;

  const credentialsMeta = await getBookingCredentialsMeta();
  report.steps.credentials = credentialsMeta;
  addCommand('check-credentials', 'ok', credentialsMeta);

  if (!flowOptions.apiOnly && (!officialOk || flowOptions.browserOnly) && !flowOptions.skipBrowserAutomation) {
    const autonomous = await runAutonomousBrowserBooking();
    report.steps.autonomousBrowser = autonomous;
    report.autonomous = {
      enabled: true,
      submitted: Boolean(autonomous?.browserResult?.submitted),
      state: autonomous?.browserResult?.session?.state || null,
    };
  } else {
    report.steps.autonomousBrowser = { skipped: true };
    report.autonomous = { enabled: false, reason: flowOptions.apiOnly ? '--api-only' : '--skip-browser-automation or official-confirmed' };
    addCommand('autonomous-browser-booking', 'skipped', report.autonomous);
  }

  if (!flowOptions.skipSelfExtending && shouldRunHeavyBrowserSteps) {
    const trackedSelfExtRequest = await createGovernmentRequest({
      userId: flowOptions.userId,
      description: `self-extending live flow (${flowOptions.userRequest.slice(0, 120)})`,
      status: 'new',
      notes: {
        source: 'run_local_gov_api_booking',
        websiteUrl: flowOptions.websiteUrl,
        bookingState: {
          available_slots: [],
          selected_slot: null,
          booking_status: 'discovering_api',
          last_checked: null,
          user_confirmation: false,
          auto_book: false,
        },
      },
    });
    const selfExt = await runSelfExtendingAgent({
      websiteUrl: flowOptions.websiteUrl,
      requestText: flowOptions.userRequest,
      requestId: trackedSelfExtRequest?.id || null,
      applicantPayload: {
        fullName: process.env.APPT_FULL_NAME || '',
        idNumber: process.env.APPT_ID || '',
        phone: process.env.APPT_PHONE || '',
        email: process.env.APPT_EMAIL || '',
        notes: flowOptions.userRequest,
      },
      headless: String(process.env.APPT_HEADLESS || 'true').toLowerCase() !== 'false',
      maxRetries: 3,
      endpointHarvesting: {
        level: 'turbo20',
        strategy: 'high-level-efficient',
        selfHealingSelectors: true,
        selfLearningSelectors: true,
        selfLearning: true,
        circuitBreaker: {
          enabled: true,
          failureThreshold: 2,
          cooldownMs: 350,
        },
      },
    });
    report.steps.selfExtendingAgent = selfExt;
    addCommand('self-extending-agent-architecture', selfExt?.ok ? 'ok' : 'failed', {
      tools: Number(selfExt?.selfExtension?.dynamicToolsCreated || 0),
      discovered: Number(selfExt?.selfExtension?.discoveredApis || 0),
    });
  } else {
    report.steps.selfExtendingAgent = { skipped: true, reason: flowOptions.skipSelfExtending ? '--skip-self-extending' : 'browser-fallback-not-needed' };
    addCommand('self-extending-agent-architecture', 'skipped', { reason: report.steps.selfExtendingAgent.reason });
  }

  const finalStatus = (
    report.steps.officialApiBooking?.ok ||
    report.steps.autonomousBrowser?.browserResult?.submitted ||
    report.steps.selfExtendingAgent?.ok
  ) ? 'approved' : 'in_progress';

  const stored = await createGovernmentRequest({
    userId: flowOptions.userId,
    description: `local-gov:api:book command-bus run (${flowOptions.userRequest.slice(0, 120)})`,
    status: finalStatus,
    notes: JSON.stringify({
      officialApiConfigured: report.steps.officialApi?.configured,
      cachedDocs: report.steps.cachedData?.totalDocs,
      discoveredApis: report.steps.discoverAPINode?.discovery?.discoveredCount ?? null,
      monitorStarted: Boolean(report.steps.appointmentMonitorEngine?.ok),
      officialApiConfirmed: Boolean(report.steps.officialApiBooking?.scheduling?.appointment?.confirmed),
      browserSubmitted: Boolean(report.steps.autonomousBrowser?.browserResult?.submitted),
      humanInLoopNeeded: Boolean(report.humanInLoop?.needed),
      selfExtendingOk: Boolean(report.steps.selfExtendingAgent?.ok),
    }),
  });

  report.steps.storeResults = { ok: true, requestId: stored.id, status: finalStatus };
  addCommand('store-results', 'ok', { requestId: stored.id, status: finalStatus });

  report.completedAt = new Date().toISOString();
  report.ok = true;

  console.log('\n──── local-gov:api:book summary ────');
  console.log(JSON.stringify({
    ok: report.ok,
    requestId: stored.id,
    status: finalStatus,
    discoveredApis: report.steps.discoverAPINode?.discovery?.discoveredCount ?? null,
    monitorStarted: Boolean(report.steps.appointmentMonitorEngine?.ok),
    officialConfirmed: Boolean(report.steps.officialApiBooking?.scheduling?.appointment?.confirmed),
    browserSubmitted: Boolean(report.steps.autonomousBrowser?.browserResult?.submitted),
    hitlNeeded: Boolean(report.humanInLoop?.needed),
    selfExtendingOk: Boolean(report.steps.selfExtendingAgent?.ok),
  }, null, 2));

  console.log('\n──── command bus trace ────');
  console.log(JSON.stringify(report.commandBus, null, 2));
}

runFlow().catch(async (err) => {
  const message = err?.message || String(err);
  console.error(message);
  try {
    await createGovernmentRequest({
      userId: flowOptions.userId || 'cli-api-booking',
      description: 'local-gov:api:book command-bus failure',
      status: 'error',
      notes: message,
    });
  } catch {
  }
  process.exit(1);
});
