import 'dotenv/config';

import fs from 'fs/promises';
import path from 'path';

import { runTelAvivBrowserBooking } from '../making_operations/local_government/browser_appointment_agent.js';

async function main() {
  const outputPath = path.resolve(process.cwd(), '02_backend', 'eval', 'local_government', 'tel-aviv-booking-browser-eval.json');
  const bookingUrl = 'https://www.tel-aviv.gov.il/Contact/Pages/Appointments.aspx';

  const result = await runTelAvivBrowserBooking({
    bookingUrl,
    applicant: {
      fullName: 'Eval User',
      phone: '0500000000',
      email: 'eval@example.com',
      notes: 'Evaluation only. Do not submit.',
    },
    intentText: 'Evaluate the Tel Aviv appointment booking flow autonomously, but stop before any irreversible submission.',
    dryRun: true,
    confirmedSubmit: false,
    headless: true,
    timeoutMs: 90000,
  });

  const output = {
    ok: Boolean(result?.ok),
    mode: 'tel-aviv-booking-dry-run-eval',
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
