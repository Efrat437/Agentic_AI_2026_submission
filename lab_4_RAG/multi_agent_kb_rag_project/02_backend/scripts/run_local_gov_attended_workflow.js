import 'dotenv/config';

import { loadBookingCredentials } from '../making_operations/local_government/browser_appointment_agent.js';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
function getArgValue(name, fallback = '') {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return String(args[idx + 1] || '').trim();
  return fallback;
}

const config = {
  backendBaseUrl: getArgValue('--backend-base-url', process.env.BACKEND_BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  bookingUrl: getArgValue('--website-url', process.env.TEL_AVIV_APPOINTMENT_PUBLIC_URL || 'https://www.tel-aviv.gov.il/Contact/Pages/Appointments.aspx'),
  description: getArgValue('--request', process.env.APPT_NOTES || 'Tel Aviv Arnona attended booking workflow'),
  userId: process.env.APPT_USER_ID || 'cli-attended-booking',
  notes: getArgValue('--notes', process.env.APPT_OPERATOR_NOTES || 'operator-guided attended workflow'),
  headless: hasFlag('--headless') || String(process.env.APPT_HEADLESS || 'false').toLowerCase() === 'true',
  timeoutMs: Math.max(60000, Number(getArgValue('--timeout-ms', process.env.APPT_TIMEOUT_MS || 120000)) || 120000),
};

function printDivider(title) {
  console.log(`\n=== ${title} ===`);
}

function buildApplicant(savedCreds = null) {
  const savedApplicant = savedCreds?.applicantProfile || {};
  return {
    fullName: String(process.env.APPT_FULL_NAME || savedApplicant.fullName || '').trim(),
    idNumber: String(process.env.APPT_ID || savedApplicant.idNumber || '').trim(),
    phone: String(process.env.APPT_PHONE || savedApplicant.phone || '').trim(),
    email: String(process.env.APPT_EMAIL || savedApplicant.email || '').trim(),
    address: String(process.env.APPT_ADDRESS || savedApplicant.address || '').trim(),
    notes: String(process.env.APPT_NOTES || savedApplicant.notes || config.notes || '').trim(),
    loginUsername: String(process.env.APPT_LOGIN_USER || savedCreds?.loginUsername || '').trim(),
    loginPassword: String(process.env.APPT_LOGIN_PASS || savedCreds?.loginPassword || '').trim(),
    otpCode: String(process.env.APPT_OTP || savedCreds?.otpCode || '').trim(),
    otpPolicy: String(process.env.BOOKING_OTP_POLICY || savedCreds?.otpPolicy || 'static').trim(),
    totpSecret: String(process.env.BOOKING_TOTP_SECRET || savedCreds?.totpSecret || '').trim(),
    reusePersistentProfile: true,
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed };
}

function quotePs(value) {
  return String(value || '').replace(/'/g, "''");
}

function printOperatorSteps({ token, baseUrl, resumeBody, approveBody }) {
  const encodedToken = encodeURIComponent(token);
  const statusUrl = `${baseUrl}/api/government/appointments/attended/${encodedToken}/status`;
  const resumeUrl = `${baseUrl}/api/government/appointments/attended/${encodedToken}/resume`;
  const approveUrl = `${baseUrl}/api/government/appointments/attended/${encodedToken}/approve-submit`;
  const submitUrl = `${baseUrl}/api/government/appointments/attended/${encodedToken}/submit`;
  const stopUrl = `${baseUrl}/api/government/appointments/attended/${encodedToken}/stop`;

  printDivider('Operator Commands');
  console.log(`STATUS URL: ${statusUrl}`);
  console.log(`RESUME URL: ${resumeUrl}`);
  console.log(`APPROVE URL: ${approveUrl}`);
  console.log(`SUBMIT URL: ${submitUrl}`);
  console.log(`STOP URL: ${stopUrl}`);

  printDivider('PowerShell');
  console.log(`Check status:`);
  console.log(`Invoke-RestMethod -Method Get -Uri '${quotePs(statusUrl)}'`);
  console.log('');
  console.log('Resume after human input or login/OTP progress:');
  console.log(`Invoke-RestMethod -Method Post -Uri '${quotePs(resumeUrl)}' -ContentType 'application/json' -Body '${quotePs(JSON.stringify(resumeBody))}'`);
  console.log('');
  console.log('Record human approval before final submit:');
  console.log(`Invoke-RestMethod -Method Post -Uri '${quotePs(approveUrl)}' -ContentType 'application/json' -Body '${quotePs(JSON.stringify(approveBody))}'`);
  console.log('');
  console.log('Submit only after status is ready_to_submit and approval is recorded:');
  console.log(`Invoke-RestMethod -Method Post -Uri '${quotePs(submitUrl)}' -ContentType 'application/json' -Body '{}'`);
  console.log('');
  console.log('Stop and cleanup if needed:');
  console.log(`Invoke-RestMethod -Method Post -Uri '${quotePs(stopUrl)}' -ContentType 'application/json' -Body '{"reason":"operator-stop"}'`);
}

export async function main() {
  const savedCreds = await loadBookingCredentials().catch(() => null);
  const applicant = buildApplicant(savedCreds);

  printDivider('Starting Attended Workflow');
  console.log(`Backend: ${config.backendBaseUrl}`);
  console.log(`Booking URL: ${config.bookingUrl}`);
  console.log(`Headless: ${config.headless}`);

  const response = await postJson(`${config.backendBaseUrl}/api/government/appointments/attended/start`, {
    userId: config.userId,
    description: config.description,
    notes: config.notes,
    bookingUrl: config.bookingUrl,
    applicant,
    headless: config.headless,
    timeoutMs: config.timeoutMs,
  });

  if (response.status >= 400 || !response.body?.ok) {
    throw new Error(`Failed to start attended workflow (${response.status}): ${response.body?.error || response.body?.raw || 'unknown error'}`);
  }

  const session = response.body.session || {};
  const request = response.body.request || {};

  printDivider('Session');
  console.log(`Token: ${session.token || ''}`);
  console.log(`Request ID: ${request.id || session.requestId || ''}`);
  console.log(`State: ${session.state || ''}`);
  console.log(`Requires human: ${String(session.requiresHuman ?? false)}`);
  console.log(`Current URL: ${session.currentUrl || ''}`);
  console.log(`Approval recorded: ${String(session.approval?.approved ?? false)}`);

  printOperatorSteps({
    token: session.token,
    baseUrl: config.backendBaseUrl,
    resumeBody: { applicant: { notes: 'operator-resume', reusePersistentProfile: true } },
    approveBody: { approvedBy: process.env.APPT_APPROVER || 'human-operator', reason: 'final operator approval before submit' },
  });
}

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
})();

if (isDirectRun) {
  main().catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  });
}
