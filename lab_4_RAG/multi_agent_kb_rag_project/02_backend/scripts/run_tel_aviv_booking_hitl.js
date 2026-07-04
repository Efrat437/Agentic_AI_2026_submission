import 'dotenv/config';

import fs from 'fs/promises';
import path from 'path';

import { runTelAvivFullyAutomatedBooking } from '../making_operations/local_government/browser_appointment_agent.js';

async function main() {
  const outputPath = path.resolve(process.cwd(), '02_backend', 'eval', 'local_government', 'tel-aviv-booking-hitl-eval.json');
  const bookingUrl = process.env.TEL_AVIV_APPOINTMENT_PUBLIC_URL || 'https://www.tel-aviv.gov.il/Contact/Pages/Appointments.aspx';

  const result = await runTelAvivFullyAutomatedBooking({
    bookingUrl,
    applicant: {
      fullName: process.env.APPT_FULL_NAME || 'Eval User',
      idNumber: process.env.APPT_ID || '',
      phone: process.env.APPT_PHONE || '0500000000',
      email: process.env.APPT_EMAIL || 'eval@example.com',
      notes: process.env.APPT_NOTES || 'Arnona appointment. Automate as far as possible, then wait for human help if needed.',
      loginUsername: process.env.APPT_LOGIN_USER || '',
      loginPassword: process.env.APPT_LOGIN_PASS || '',
      otpCode: process.env.APPT_OTP || '',
      otpPolicy: process.env.BOOKING_OTP_POLICY || 'static',
      totpSecret: process.env.BOOKING_TOTP_SECRET || '',
    },
    intentText: process.env.APPT_NOTES || 'Arnona appointment booking with autonomous progression and human fallback where required.',
    headless: String(process.env.APPT_HEADLESS || 'false').toLowerCase() === 'true',
    timeoutMs: Math.max(30000, Number(process.env.APPT_TIMEOUT_MS || 90000) || 90000),
    maxRuntimeMs: Math.max(60000, Number(process.env.APPT_MAX_RUNTIME_MS || 240000) || 240000),
    allowHumanIntervention: String(process.env.APPT_ALLOW_HUMAN_FALLBACK || 'true').toLowerCase() !== 'false',
    humanInterventionTimeoutMs: Math.max(30000, Number(process.env.APPT_HUMAN_TIMEOUT_MS || 300000) || 300000),
    keepSessionOnFailure: true,
    requireFinalHumanApproval: true,
  });

  const output = {
    ok: Boolean(result?.ok),
    mode: 'tel-aviv-booking-hitl-eval',
    site: 'Tel Aviv appointments',
    generatedAt: new Date().toISOString(),
    result,
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});