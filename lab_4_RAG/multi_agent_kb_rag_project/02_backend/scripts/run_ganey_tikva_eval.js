import fs from 'fs/promises';
import path from 'path';

import { runTelAvivBrowserBooking } from '../making_operations/local_government/browser_appointment_agent.js';

const args = process.argv.slice(2);

function getArgValue(name, fallback = '') {
  const index = args.indexOf(name);
  if (index >= 0 && index + 1 < args.length) return String(args[index + 1] || '').trim();
  return fallback;
}

async function main() {
  const bookingUrl = getArgValue(
    '--url',
    'https://www.ganeytikva.org.il/appointments/?schedule=1&departmentId=67&date=2026-04-27&time=08%3A30%3A00',
  );
  const outputPath = getArgValue(
    '--output',
    path.resolve(process.cwd(), '02_backend', 'eval', 'local_government', 'ganey-tikva-browser-eval.json'),
  );

  const result = await runTelAvivBrowserBooking({
    bookingUrl,
    applicant: {
      fullName: 'Eval User',
      phone: '0500000000',
      email: 'eval@example.com',
      notes: 'Evaluation only. Do not submit.',
    },
    intentText: 'Schedule municipal engineering appointment. Evaluation only. Do not submit.',
    dryRun: true,
    confirmedSubmit: false,
    headless: true,
    timeoutMs: 90000,
  });

  const output = {
    ok: Boolean(result?.ok),
    mode: 'real-public-site-eval',
    site: 'Ganey Tikva',
    generatedAt: new Date().toISOString(),
    outputPath,
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