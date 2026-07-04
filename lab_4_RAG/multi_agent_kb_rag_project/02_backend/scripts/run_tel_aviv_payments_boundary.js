import 'dotenv/config';

import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';

import { runTelAvivPaymentsBoundaryAssist } from '../making_operations/local_government/browser_appointment_agent.js';

export async function main() {
  const outputPath = path.resolve(process.cwd(), '02_backend', 'eval', 'local_government', 'tel-aviv-payments-boundary-eval.json');
  const paymentUrl = 'https://www.tel-aviv.gov.il/About/Pages/Payments.aspx';

  const result = await runTelAvivPaymentsBoundaryAssist({
    paymentUrl,
    intentText: process.env.PAYMENT_NOTES || 'Find the correct Tel Aviv payment branch and stop before any irreversible payment step.',
    headless: String(process.env.APPT_HEADLESS || 'true').toLowerCase() === 'true',
    timeoutMs: Math.max(30000, Number(process.env.APPT_TIMEOUT_MS || 90000) || 90000),
  });

  const output = {
    ok: Boolean(result?.ok),
    mode: 'tel-aviv-payments-boundary-eval',
    site: 'Tel Aviv payments',
    generatedAt: new Date().toISOString(),
    result,
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(JSON.stringify(output, null, 2));
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}