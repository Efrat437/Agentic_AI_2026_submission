#!/usr/bin/env node
/**
 * setup-autonomous-booking.js
 * 
 * Interactive setup tool for autonomous appointment booking.
 * Guides users through:
 *  1. Credential collection and storage
 *  2. Applicant information entry
 *  3. Configuration preferences
 *  4. Test run to verify everything works
 */

import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'fs/promises';
import path from 'node:path';
import {
  loadBookingCredentials,
  saveBookingCredentials,
} from '../making_operations/local_government/browser_appointment_agent.js';

const rl = readline.createInterface({ input, output });

const CREDS_FILE = path.resolve(process.cwd(), 'tmp', 'booking-creds.json');
const CONFIG_FILE = path.resolve(process.cwd(), 'tmp', 'booking-config.json');

async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // Ignore if exists
  }
}

function banner(title) {
  console.log('\n' + '═'.repeat(70));
  console.log(`  ${title}`);
  console.log('═'.repeat(70) + '\n');
}

function info(msg) {
  console.log(`ℹ️  ${msg}`);
}

function success(msg) {
  console.log(`✅ ${msg}`);
}

function warning(msg) {
  console.log(`⚠️  ${msg}`);
}

function error(msg) {
  console.log(`❌ ${msg}`);
}

async function askYesNo(question) {
  const answer = await rl.question(`${question} (y/n): `);
  return answer.toLowerCase().startsWith('y');
}

async function ensureCredsFile() {
  const parsed = await loadBookingCredentials().catch(() => null);
  if (parsed?.loginUsername && parsed?.loginPassword) {
    success(`Found existing credentials (${parsed.loginUsername.charAt(0)}***)`);
    if (parsed?.applicantProfile?.fullName || parsed?.applicantProfile?.idNumber) {
      info('Found saved applicant profile in shared booking credentials.');
    }
    const update = await askYesNo('Update credentials?');
    if (!update) return parsed;
  }

  // Collect new credentials
  banner('📋 CREDENTIAL SETUP');
  info('These will be saved locally and reused automatically.\n');

  const loginUsername = await rl.question('Login username: ');
  if (!loginUsername.trim()) {
    error('Username is required');
    return null;
  }

  const loginPassword = await rl.question('Login password: ');
  if (!loginPassword.trim()) {
    error('Password is required');
    return null;
  }

  const otpPolicyInput = await rl.question('OTP policy [static/totp/manual] (default: static): ');
  const otpPolicy = (otpPolicyInput || 'static').trim().toLowerCase();
  const otpCode = otpPolicy === 'totp' ? '' : await rl.question('OTP code (if required, or press Enter): ');
  const totpSecret = otpPolicy === 'totp' ? await rl.question('TOTP secret (base32): ') : '';

  const creds = {
    loginUsername: loginUsername.trim(),
    loginPassword: loginPassword.trim(),
    otpCode: otpCode.trim(),
    otpPolicy,
    totpSecret: totpSecret.trim(),
    savedAt: new Date().toISOString(),
  };

  await saveBookingCredentials(creds);
  success(`Credentials saved to ${CREDS_FILE}`);

  return creds;
}

async function collectApplicantInfo(existingApplicant = {}) {
  banner('👤 APPLICANT INFORMATION');
  info('This information will be used for booking.\n');

  const fullName = await rl.question(`Full name [${existingApplicant.fullName || ''}]: `);
  const idNumber = await rl.question(`ID number [${existingApplicant.idNumber || ''}]: `);
  const phone = await rl.question(`Phone number [${existingApplicant.phone || ''}]: `);
  const email = await rl.question(`Email address [${existingApplicant.email || ''}]: `);

  const applicant = {
    fullName: (fullName || existingApplicant.fullName || '').trim(),
    idNumber: (idNumber || existingApplicant.idNumber || '').trim(),
    phone: (phone || existingApplicant.phone || '').trim(),
    email: (email || existingApplicant.email || '').trim(),
  };

  if (!applicant.fullName || !applicant.idNumber) {
    warning('Name and ID are recommended for better booking');
  }

  return applicant;
}

async function getPreferences() {
  banner('⚙️  PREFERENCES');

  const category = (await rl.question('Appointment category (default: arnona): ')).trim() || 'arnona';
  const interval = (await rl.question('Polling interval in seconds (default: 30): ')).trim() || '30';
  const enableSound = await askYesNo('Enable audio alerts?');
  const autoBook = await askYesNo('Auto-book when slots found?');

  return {
    category,
    interval: Math.max(15, Number(interval) || 30),
    enableSound,
    autoBook,
  };
}

async function saveConfig(applicant, prefs) {
  const config = {
    applicant,
    preferences: prefs,
    createdAt: new Date().toISOString(),
  };

  await ensureDir(path.dirname(CONFIG_FILE));
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  success(`Configuration saved to ${CONFIG_FILE}`);
}

async function updateEnvVars(applicant, creds) {
  // Set env vars for this session
  if (applicant.fullName) process.env.APPT_FULL_NAME = applicant.fullName;
  if (applicant.idNumber) process.env.APPT_ID = applicant.idNumber;
  if (applicant.phone) process.env.APPT_PHONE = applicant.phone;
  if (applicant.email) process.env.APPT_EMAIL = applicant.email;
  if (creds?.loginUsername) process.env.APPT_LOGIN_USER = creds.loginUsername;
  if (creds?.loginPassword) process.env.APPT_LOGIN_PASS = creds.loginPassword;
  if (creds?.otpCode) process.env.APPT_OTP = creds.otpCode;
  if (creds?.otpPolicy) process.env.BOOKING_OTP_POLICY = creds.otpPolicy;
  if (creds?.totpSecret) process.env.BOOKING_TOTP_SECRET = creds.totpSecret;
}

async function testConnection() {
  banner('🧪 TEST CONNECTION');
  info('Testing connection to booking website...\n');

  try {
    const url = 'https://www.tel-aviv.gov.il/Contact/Pages/Appointments.aspx';
    const response = await fetch(url, { timeout: 10000 });
    if (response.ok) {
      success(`Website is accessible (${response.status})`);
      return true;
    } else {
      warning(`Website returned ${response.status}`);
      return false;
    }
  } catch (err) {
    error(`Cannot reach website: ${err.message}`);
    return false;
  }
}

async function showSummary(creds, applicant, prefs) {
  banner('📊 SETUP SUMMARY');

  console.log('Credentials:');
  console.log(`  Username: ${creds.loginUsername.charAt(0)}*** (${creds.loginUsername.length} chars)`);
  console.log(`  Password: ${'*'.repeat(Math.max(1, creds.loginPassword.length - 2))}${creds.loginPassword.slice(-2)}`);
  if (creds.otpCode) {
    console.log(`  OTP: ${creds.otpCode}`);
  }
  console.log(`  OTP policy: ${creds.otpPolicy || 'static'}`);
  if (creds.totpSecret) {
    console.log('  TOTP secret: ***');
  }

  console.log('\nApplicant:');
  console.log(`  Name: ${applicant.fullName || '(not set)'}`);
  console.log(`  ID: ${applicant.idNumber || '(not set)'}`);
  console.log(`  Phone: ${applicant.phone || '(not set)'}`);
  console.log(`  Email: ${applicant.email || '(not set)'}`);

  console.log('\nPreferences:');
  console.log(`  Category: ${prefs.category}`);
  console.log(`  Polling: Every ${prefs.interval}s`);
  console.log(`  Sound alerts: ${prefs.enableSound ? 'yes' : 'no'}`);
  console.log(`  Auto-book: ${prefs.autoBook ? 'yes' : 'no'}`);

  console.log('\nFiles:');
  console.log(`  Credentials: ${CREDS_FILE}`);
  console.log(`  Config: ${CONFIG_FILE}`);
}

async function showNextSteps() {
  banner('🚀 READY TO START');

  console.log('Your autonomous booking system is set up!\n');

  const commands = [
    {
      title: 'Standard monitoring',
      cmd: 'npm run local-gov:autonomous:polling:arnona',
    },
    {
      title: 'Fast checking (15s intervals)',
      cmd: 'npm run local-gov:autonomous:polling:fast',
    },
    {
      title: 'Silent monitoring (no sounds)',
      cmd: 'npm run local-gov:autonomous:polling:silent',
    },
    {
      title: 'Custom (2 hours max)',
      cmd: 'npm run local-gov:autonomous:polling -- --max-runtime 120',
    },
  ];

  console.log('Quick commands:\n');
  commands.forEach((c, i) => {
    console.log(`${i + 1}. ${c.title}`);
    console.log(`   ${c.cmd}\n`);
  });

  console.log('\nDocumentation:');
  console.log('  Read AUTONOMOUS_BOOKING_GUIDE.md for full details');
  console.log('  More options: npm run local-gov:autonomous:polling -- --help\n');
}

async function main() {
  try {
    console.clear();
    console.log('╔════════════════════════════════════════════════════════════════════╗');
    console.log('║        🤖 AUTONOMOUS APPOINTMENT BOOKING - SETUP WIZARD            ║');
    console.log('╚════════════════════════════════════════════════════════════════════╝\n');

    // Step 1: Credentials
    const creds = await ensureCredsFile();
    if (!creds) {
      error('Setup cancelled - credentials required');
      process.exit(1);
    }

    // Step 2: Applicant info
    const applicant = await collectApplicantInfo(creds.applicantProfile || {});
    await saveBookingCredentials({
      loginUsername: creds.loginUsername,
      loginPassword: creds.loginPassword,
      otpCode: creds.otpCode,
      otpPolicy: creds.otpPolicy,
      totpSecret: creds.totpSecret,
      applicantProfile: applicant,
    });

    // Step 3: Preferences
    const prefs = await getPreferences();

    // Step 4: Save config
    await saveConfig(applicant, prefs);

    // Step 5: Update env vars for current session
    await updateEnvVars(applicant, creds);

    // Step 6: Test connection
    const connected = await testConnection();
    if (!connected) {
      warning('Website may not be accessible right now');
      const proceed = await askYesNo('Continue anyway?');
      if (!proceed) {
        process.exit(0);
      }
    }

    // Step 7: Summary
    await showSummary(creds, applicant, prefs);

    // Step 8: Done
    await showNextSteps();

    success('Setup complete!');
    process.exit(0);
  } catch (err) {
    error(`Setup failed: ${err.message}`);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
