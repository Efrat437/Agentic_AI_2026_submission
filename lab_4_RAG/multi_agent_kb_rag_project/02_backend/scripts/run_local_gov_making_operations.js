import 'dotenv/config';
import { ingestLocalGovernmentWebToRag, getLocalGovernmentRagStats } from '../making_operations/local_government/operations.js';
import { createGovernmentRequest, getGovernmentRequestById, ensureGovernmentRequestsTable } from '../agents/dbTools.js';
import { getTelAvivOfficialAppointmentApiConfig } from '../making_operations/local_government/official_appointment_api.js';
import { getBookingCredentialsMeta, inspectBookingSiteNetwork } from '../making_operations/local_government/browser_appointment_agent.js';

// ─── Script flags ─────────────────────────────────────────────────────────────
// Pass --skip-network to skip the Playwright network inspection step (faster).
// Pass --skip-scrape to skip reinserting RAG documents.
const args = process.argv.slice(2);
const skipNetwork = args.includes('--skip-network');
const skipScrape = args.includes('--skip-scrape');

const TEL_AVIV_URLS = [
  'https://www.tel-aviv.gov.il/Contact/Pages/Appointments.aspx',
  'https://www.tel-aviv.gov.il/Residents/Arnona/Pages/ArnonaSwitching.aspx',
];

async function main() {
  await ensureGovernmentRequestsTable();
  const report = {};

  // ── Step 1: Check official API config ──────────────────────────────────────
  console.log('\n[1] Checking official API configuration...');
  const apiConfig = getTelAvivOfficialAppointmentApiConfig();
  report.officialApi = {
    configured: apiConfig.configured,
    provider: apiConfig.provider,
    publicBookingUrl: apiConfig.publicBookingUrl,
  };
  if (!apiConfig.configured) {
    console.log('    ⚠  Not configured – set TEL_AVIV_APPOINTMENT_API_BASE_URL in .env to enable the direct API path.');
  } else {
    console.log(`    ✓  Configured. Base URL: ${apiConfig.baseUrl}`);
  }

  // ── Step 2: Check cached data ──────────────────────────────────────────────
  console.log('\n[2] Checking cached RAG data...');
  const stats = await getLocalGovernmentRagStats();
  report.cachedData = { totalDocs: stats.totalDocs, distinctSources: stats.distinctSources, sources: stats.sources };
  if (stats.totalDocs > 0) {
    console.log(`    ✓  ${stats.totalDocs} chunks from ${stats.distinctSources} source(s) already in DB.`);
    stats.sources.slice(0, 5).forEach((s) => console.log(`       - ${s.source} (${s.chunks} chunks)`));
  } else {
    console.log('    ⚠  No cached data found – will run browser scraper now.');
  }

  // ── Step 3: Browser scraper ────────────────────────────────────────────────
  if (!skipScrape) {
    console.log('\n[3] Running browser scraper on Tel Aviv URLs...');
    try {
      const scrapeResult = await ingestLocalGovernmentWebToRag({
        urls: TEL_AVIV_URLS,
        replaceExisting: true,
        chunkSize: 900,
        chunkOverlap: 120,
        maxChunksPerUrl: 40,
        minRelevanceScore: 1,
      });
      report.scrape = scrapeResult;
      console.log(`    ✓  Inserted ${scrapeResult.inserted} chunks.`);
      (scrapeResult.pages || []).forEach((p) => {
        if (p.ok) console.log(`       - ${p.url}: ${p.chunks} chunks, ${p.extractedChars} chars`);
        else console.log(`       - ${p.url}: FAILED – ${p.error}`);
      });
    } catch (err) {
      report.scrape = { ok: false, error: err.message };
      console.error(`    ✗  Scrape failed: ${err.message}`);
    }
  } else {
    console.log('\n[3] Skipping browser scraper (--skip-scrape).');
    report.scrape = { skipped: true };
  }

  // ── Step 4: Network inspection ─────────────────────────────────────────────
  if (!skipNetwork) {
    console.log('\n[4] Running network inspection (headless browser)...');
    try {
      const networkResult = await inspectBookingSiteNetwork({
        bookingUrl: 'https://www.tel-aviv.gov.il/Contact/Pages/Appointments.aspx',
        intentText: 'arnona property tax appointment',
        autonomousBrowse: true,
        maxAutonomousSteps: 4,
      });
      report.networkInspection = networkResult;
      console.log(`    ✓  Captured ${networkResult.networkCount} network entries, ${networkResult.networkRequests?.length} XHR/fetch/API calls.`);
      if (Array.isArray(networkResult?.traversal?.visited) && networkResult.traversal.visited.length) {
        console.log(`    ✓  Autonomous crawl visited ${networkResult.traversal.visited.length} page(s).`);
      }
      if (networkResult.networkRequests?.length) {
        console.log('    API endpoints detected:');
        networkResult.networkRequests.slice(0, 8).forEach((e) => console.log(`       [${e.status}] ${e.method} ${e.url}`));
      }
    } catch (err) {
      report.networkInspection = { ok: false, error: err.message };
      console.error(`    ✗  Network inspection failed: ${err.message}`);
    }
  } else {
    console.log('\n[4] Skipping network inspection (--skip-network).');
    report.networkInspection = { skipped: true };
  }

  // ── Step 5: Check saved credentials status ─────────────────────────────────
  console.log('\n[5] Checking saved booking credentials...');
  const credsMeta = await getBookingCredentialsMeta();
  report.credentials = credsMeta;
  if (credsMeta.saved) {
    console.log(`    ✓  Credentials saved (username=${credsMeta.hasUsername ? 'yes' : 'no'}, password=${credsMeta.hasPassword ? 'yes' : 'no'}, savedAt=${credsMeta.savedAt}).`);
  } else {
    console.log('    ⚠  No saved credentials. Use the UI "Save Credentials" panel or POST /api/government/appointments/credentials/save.');
  }

  // ── Step 6: Store results ──────────────────────────────────────────────────
  console.log('\n[6] Storing probe results to DB...');
  const created = await createGovernmentRequest({
    userId: 'local-gov-flow-script',
    description: 'Local government site probe: API check + cached data + browser scrape + network inspection',
    status: 'new',
    notes: `officialApi.configured=${report.officialApi?.configured}; cachedDocs=${stats.totalDocs}; scraped.inserted=${report.scrape?.inserted ?? 'skipped'}; networkEntries=${report.networkInspection?.networkCount ?? 'skipped'}; credsSaved=${credsMeta.saved}`,
  });
  report.savedRequest = created;
  console.log(`    ✓  Stored as government request #${created.id}`);

  console.log('\n──── Full report ────');
  console.log(JSON.stringify(report, null, 2));

  console.log(`
╔══════════════════════════════════════════════════╗
║  To run the BOOKING APPOINTMENT task, use:       ║
║                                                  ║
║  1. npm run backend:start                        ║
║     (starts the server on port 3000)             ║
║                                                  ║
║  2. Open the front-end UI and use the            ║
║     "Schedule (Fully Automated)" button.         ║
║                                                  ║
║  OR via CLI:                                     ║
║     npm run local-gov:booking:run                ║
╚══════════════════════════════════════════════════╝
`);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
