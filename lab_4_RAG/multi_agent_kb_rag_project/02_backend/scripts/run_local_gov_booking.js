/**
 * run_local_gov_booking.js
 *
 * CLI script to run the fully-automated Tel Aviv appointment booking flow.
 * Usage:
 *   node ./02_backend/scripts/run_local_gov_booking.js
 *   npm run local-gov:booking:run
 *
 * Env vars (or use saved credentials via UI first):
 *   APPT_FULL_NAME      - applicant full name
 *   APPT_ID             - applicant ID number
 *   APPT_PHONE          - applicant phone
 *   APPT_EMAIL          - applicant email
 *   APPT_NOTES          - intent/notes (default: "Arnona appointment")
 *   APPT_LOGIN_USER     - login username (overrides saved creds)
 *   APPT_LOGIN_PASS     - login password (overrides saved creds)
 *   APPT_OTP            - OTP code if known in advance
 *   APPT_HEADLESS       - headless browser (default: true)
 *   APPT_MAX_RUNTIME_MS - max runtime in ms (default: 300000)
 */
import 'dotenv/config';
import { ensureGovernmentRequestsTable, createGovernmentRequest } from '../agents/dbTools.js';
import { runTelAvivFullyAutomatedBooking, saveBookingCredentials } from '../making_operations/local_government/browser_appointment_agent.js';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const args = process.argv.slice(2);
const askOnceAhead = args.includes('--ask-once') || String(process.env.APPT_ASK_ONCE || 'false').toLowerCase() === 'true';

function askableTty() {
  return Boolean(process.stdin?.isTTY && process.stdout?.isTTY);
}

function masked(value = '') {
  const text = String(value || '').trim();
  if (!text) return '(not set)';
  if (text.length <= 2) return '*'.repeat(text.length);
  return `${'*'.repeat(Math.max(1, text.length - 2))}${text.slice(-2)}`;
}

async function maybeAskOnceAhead() {
  if (!askOnceAhead || !askableTty()) return;

  const rl = readline.createInterface({ input, output });
  try {
    console.log('\n──── One-time human input (optional) ────');
    console.log('Press Enter to keep existing env/saved value.');

    const loginUsername = await rl.question(`Login username [${process.env.APPT_LOGIN_USER ? masked(process.env.APPT_LOGIN_USER) : ''}]: `);
    const loginPassword = await rl.question(`Login password [${process.env.APPT_LOGIN_PASS ? masked(process.env.APPT_LOGIN_PASS) : ''}]: `);
    const otpCode = await rl.question(`OTP code [${process.env.APPT_OTP ? masked(process.env.APPT_OTP) : ''}]: `);
    const fullName = await rl.question(`Applicant full name [${process.env.APPT_FULL_NAME || ''}]: `);
    const idNumber = await rl.question(`Applicant ID [${process.env.APPT_ID || ''}]: `);
    const phone = await rl.question(`Applicant phone [${process.env.APPT_PHONE || ''}]: `);
    const email = await rl.question(`Applicant email [${process.env.APPT_EMAIL || ''}]: `);

    const finalLoginUser = String(loginUsername || process.env.APPT_LOGIN_USER || '').trim();
    const finalLoginPass = String(loginPassword || process.env.APPT_LOGIN_PASS || '').trim();
    const finalOtp = String(otpCode || process.env.APPT_OTP || '').trim();

    if (finalLoginUser || finalLoginPass || finalOtp) {
      await saveBookingCredentials({
        loginUsername: finalLoginUser,
        loginPassword: finalLoginPass,
        otpCode: finalOtp,
      });
    }

    if (String(fullName || '').trim()) process.env.APPT_FULL_NAME = String(fullName).trim();
    if (String(idNumber || '').trim()) process.env.APPT_ID = String(idNumber).trim();
    if (String(phone || '').trim()) process.env.APPT_PHONE = String(phone).trim();
    if (String(email || '').trim()) process.env.APPT_EMAIL = String(email).trim();
    if (finalLoginUser) process.env.APPT_LOGIN_USER = finalLoginUser;
    if (finalLoginPass) process.env.APPT_LOGIN_PASS = finalLoginPass;
    if (finalOtp) process.env.APPT_OTP = finalOtp;
  } finally {
    rl.close();
  }
}

async function main() {
  await maybeAskOnceAhead();
  await ensureGovernmentRequestsTable();

  const notes = process.env.APPT_NOTES || 'Arnona appointment - property tax section';
  const applicant = {
    fullName: process.env.APPT_FULL_NAME || '',
    idNumber: process.env.APPT_ID || '',
    phone: process.env.APPT_PHONE || '',
    email: process.env.APPT_EMAIL || '',
    notes,
    // These override saved credentials if provided
    ...(process.env.APPT_LOGIN_USER ? { loginUsername: process.env.APPT_LOGIN_USER } : {}),
    ...(process.env.APPT_LOGIN_PASS ? { loginPassword: process.env.APPT_LOGIN_PASS } : {}),
    ...(process.env.APPT_OTP ? { otpCode: process.env.APPT_OTP } : {}),
  };

  console.log('\n──── Tel Aviv Fully Automated Booking ────');
  console.log(`Applicant: ${applicant.fullName || '(not set)'}`);
  console.log(`Intent: ${notes}`);
  console.log('Starting...  (saved credentials will be merged automatically)\n');

  const trackedRequest = await createGovernmentRequest({
    userId: 'cli-booking',
    description: notes,
    status: 'new',
    notes: 'Initiated from local-gov:booking:run CLI script',
  });

  const result = await runTelAvivFullyAutomatedBooking({
    requestId: trackedRequest.id,
    applicant,
    intentText: notes,
    headless: String(process.env.APPT_HEADLESS || 'true').toLowerCase() !== 'false',
    maxRuntimeMs: Math.max(30000, Number(process.env.APPT_MAX_RUNTIME_MS || 300000)),
    pollIntervalMs: 2500,
    keepSessionOnFailure: true,
  });

  console.log('\n──── Result ────');
  console.log(JSON.stringify(result, null, 2));

  if (result?.submitted) {
    console.log('\n✓  Booking successfully submitted!');
  } else if (result?.session?.state === 'awaiting_login') {
    console.log('\n⚠  Stopped at login gate.');
    console.log('   → Save your credentials once via the UI (Save Credentials panel),');
    console.log('     then re-run this script. OR set APPT_LOGIN_USER and APPT_LOGIN_PASS env vars.');
  } else if (result?.session?.state === 'awaiting_otp') {
    console.log('\n⚠  Stopped awaiting OTP.');
    console.log(`   → Resume via: APPT_OTP=<your-code> npm run local-gov:booking:run`);
    console.log(`   → Or use the "Attended Resume" button in the UI with token: ${result?.session?.resumeToken || '(see output above)'}`);
  } else if (result?.session?.state === 'awaiting_captcha') {
    console.log('\n⚠  CAPTCHA detected. Manual intervention required.');
    console.log(`   → Use the Attended flow in the UI with token: ${result?.session?.resumeToken || '(see output above)'}`);
  } else {
    console.log(`\n⚠  Not fully completed. State: ${result?.session?.state || 'unknown'}. Reason: ${result?.reason || result?.error || 'unknown'}`);
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
