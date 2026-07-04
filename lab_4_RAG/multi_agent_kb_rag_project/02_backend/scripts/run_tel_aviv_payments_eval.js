import 'dotenv/config';

import fs from 'fs/promises';
import path from 'path';

import { inspectBookingSiteNetwork } from '../making_operations/local_government/browser_appointment_agent.js';
import { runDiscoverAPINode } from '../making_operations/local_government/discover_api_node.js';

async function main() {
  const outputPath = path.resolve(process.cwd(), '02_backend', 'eval', 'local_government', 'tel-aviv-payments-discovery-eval.json');
  const websiteUrl = 'https://www.tel-aviv.gov.il/About/Pages/Payments.aspx';

  const inspection = await inspectBookingSiteNetwork({
    bookingUrl: websiteUrl,
    intentText: 'Evaluate the Tel Aviv payments flow autonomously in discovery mode only. Do not submit any payment.',
    autonomousBrowse: true,
    maxAutonomousSteps: 4,
    maxNetworkEntries: 250,
    timeoutMs: 90000,
    endpointHarvesting: {
      browserAutomationHarvesting: true,
      level: 'turbo20',
      strategy: 'high-level-efficient',
      includeWorkerScan: true,
      includeJsInspection: true,
      selfHealingSelectors: true,
      selfLearningSelectors: true,
    },
  });

  const discovery = await runDiscoverAPINode({
    websiteUrl,
    userRequest: 'Discover payment-related endpoints and navigational actions, but do not execute a real payment.',
    executeAction: false,
    autonomousBrowse: true,
    maxAutonomousSteps: 4,
    maxNetworkEntries: 250,
    adaptiveLearning: true,
    endpointHarvesting: {
      level: 'turbo20',
      strategy: 'high-level-efficient',
      browserAutomationHarvesting: true,
      includeWorkerScan: true,
      includeJsInspection: true,
      selfHealingSelectors: true,
      selfLearningSelectors: true,
    },
  });

  const output = {
    ok: Boolean(inspection?.ok || discovery?.ok),
    mode: 'tel-aviv-payments-discovery-eval',
    site: 'Tel Aviv payments',
    generatedAt: new Date().toISOString(),
    inspection,
    discovery,
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});