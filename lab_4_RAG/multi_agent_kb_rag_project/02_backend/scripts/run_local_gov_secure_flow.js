/**
 * run_local_gov_secure_flow.js
 *
 * Integrated local-government flow:
 *   PRE-STEP: security:init runs automatically via npm "prelocal-gov:secure:all" hook.
 *
 *   Stage 1 — Probe (unless --skip-probe)
 *     1a. Check official REST API configuration (official_appointment_api.js)
 *     1b. Check cached RAG data (getLocalGovernmentRagStats)
 *     1c. Browser scrape + ingest (unless --fast or --skip-scrape)
 *     1d. Network inspection (unless --fast or --skip-network)
 *     1e. Check saved booking credentials
 *     1f. Store probe report → government_requests table
 *
 *   Stage 2 — Booking attempt (unless --skip-booking)
 *     2a. Try official REST API (scheduleTelAvivAppointmentOfficial) if configured
 *     2b. Fall back to Playwright browser automation (runTelAvivFullyAutomatedBooking)
 *     2c. Store booking result → government_requests table
 *
 * CLI flags:
 *   --fast            Skip browser scrape + network inspection (quick probe only)
 *   --skip-probe      Skip stage 1 entirely
 *   --skip-booking    Skip stage 2 entirely
 *   --skip-scrape     Skip browser scrape within probe (keep network inspection)
 *   --skip-network    Skip network inspection within probe (keep scrape)
 *   --api-only        Stage 2: attempt official API only — do NOT fall back to Playwright
 *   --browser-only    Stage 2: skip official API attempt and go straight to Playwright
 *   --dry-run         Do not submit the actual booking (Playwright dryRun=true)
 *
 * Usage:
 *   npm run local-gov:secure:all
 *   node ./02_backend/scripts/run_local_gov_secure_flow.js --fast
 *   node ./02_backend/scripts/run_local_gov_secure_flow.js --skip-probe
 *   node ./02_backend/scripts/run_local_gov_secure_flow.js --api-only --dry-run
 */
import 'dotenv/config';

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
} from '../making_operations/local_government/official_appointment_api.js';
import {
  getBookingCredentialsMeta,
  inspectBookingSiteNetwork,
  runTelAvivFullyAutomatedBooking,
} from '../making_operations/local_government/browser_appointment_agent.js';

// ─── CLI flags ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const fast        = args.includes('--fast');
const skipProbe   = args.includes('--skip-probe');
const skipBooking = args.includes('--skip-booking');
const skipScrape  = fast || args.includes('--skip-scrape');
const skipNetwork = fast || args.includes('--skip-network');
const apiOnly     = args.includes('--api-only');
const browserOnly = args.includes('--browser-only');
const dryRun      = args.includes('--dry-run');

const TEL_AVIV_URLS = [
  'https://www.tel-aviv.gov.il/Contact/Pages/Appointments.aspx',
  'https://www.tel-aviv.gov.il/Residents/Arnona/Pages/ArnonaSwitching.aspx',
];

// ─── Stage 1: Probe ───────────────────────────────────────────────────────────
async function runProbeStage() {
  console.log('\n════════════════════════════════════════════════');
  console.log(' STAGE 1 — Probe & Readiness Check');
  console.log(`════════════════════════════════════════════════`);
  console.log(`  fast=${fast}  skipScrape=${skipScrape}  skipNetwork=${skipNetwork}\n`);

  const report = {};

  // 1a — Official API config
  console.log('[1a] Checking official appointment API configuration...');
  const apiConfig = getTelAvivOfficialAppointmentApiConfig();
  report.officialApi = {
    configured: apiConfig.configured,
    provider: apiConfig.provider,
    publicBookingUrl: apiConfig.publicBookingUrl,
  };
  if (!apiConfig.configured) {
    console.log('     ⚠  Not configured – set TEL_AVIV_APPOINTMENT_API_BASE_URL in .env to enable direct API booking.');
  } else {
    console.log(`     ✓  Configured. Base URL: ${apiConfig.baseUrl}`);
  }

  // 1b — Cached RAG data
  console.log('\n[1b] Checking cached RAG data...');
  const stats = await getLocalGovernmentRagStats();
  report.cachedData = {
    totalDocs: stats.totalDocs,
    distinctSources: stats.distinctSources,
    sources: stats.sources,
  };
  if (stats.totalDocs > 0) {
    console.log(`     ✓  ${stats.totalDocs} chunks from ${stats.distinctSources} source(s) found.`);
    stats.sources.slice(0, 5).forEach((s) => console.log(`        - ${s.source} (${s.chunks} chunks)`));
  } else {
    console.log('     ⚠  No cached RAG data – browser scraper will run now.');
  }

  // 1c — Browser scrape + ingest
  if (!skipScrape) {
    console.log('\n[1c] Running browser scraper + RAG ingest...');
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
      console.log(`     ✓  Inserted ${scrapeResult.inserted} chunks.`);
      (scrapeResult.pages || []).forEach((p) => {
        if (p.ok) console.log(`        - ${p.url}: ${p.chunks} chunks, ${p.extractedChars} chars`);
        else      console.log(`        - ${p.url}: FAILED – ${p.error}`);
      });
    } catch (err) {
      report.scrape = { ok: false, error: err.message };
      console.error(`     ✗  Scrape failed: ${err.message}`);
    }
  } else {
    console.log('\n[1c] Skipping browser scrape (--fast / --skip-scrape).');
    report.scrape = { skipped: true };
  }

  // 1d — Network inspection
  if (!skipNetwork) {
    console.log('\n[1d] Running headless network inspection...');
    try {
      const networkResult = await inspectBookingSiteNetwork({
        bookingUrl: TEL_AVIV_URLS[0],
        intentText: 'arnona property tax appointment',
        autonomousBrowse: true,
        maxAutonomousSteps: 4,
      });
      report.networkInspection = networkResult;
      console.log(`     ✓  Captured ${networkResult.networkCount} network entries, ${networkResult.networkRequests?.length ?? 0} XHR/API calls.`);
      if (networkResult.networkRequests?.length) {
        console.log('     API endpoints detected:');
        networkResult.networkRequests.slice(0, 8).forEach((e) =>
          console.log(`        [${e.status}] ${e.method} ${e.url}`)
        );
      }
    } catch (err) {
      report.networkInspection = { ok: false, error: err.message };
      console.error(`     ✗  Network inspection failed: ${err.message}`);
    }
  } else {
    console.log('\n[1d] Skipping network inspection (--fast / --skip-network).');
    report.networkInspection = { skipped: true };
  }

  // 1e — Saved credentials
  console.log('\n[1e] Checking saved booking credentials...');
  const credsMeta = await getBookingCredentialsMeta();
  report.credentials = credsMeta;
  if (credsMeta.saved) {
    console.log(`     ✓  Credentials saved (username=${credsMeta.hasUsername ? 'yes' : 'no'}, savedAt=${credsMeta.savedAt}).`);
  } else {
    console.log('     ⚠  No saved credentials. Use the UI "Save Credentials" panel or set APPT_LOGIN_USER / APPT_LOGIN_PASS.');
  }

  // 1f — Store probe report
  console.log('\n[1f] Storing probe report to DB...');
  const created = await createGovernmentRequest({
    userId: 'local-gov-secure-flow',
    description: 'Local gov secure flow – Stage 1 probe: API check + RAG data + scrape + network + creds',
    status: 'new',
    notes: JSON.stringify({
      officialApiConfigured: report.officialApi.configured,
      cachedDocs: stats.totalDocs,
      scrapedInserted: report.scrape?.inserted ?? 'skipped',
      networkEntries: report.networkInspection?.networkCount ?? 'skipped',
      credsSaved: credsMeta.saved,
    }),
  });
  report.savedRequest = { id: created.id };
  console.log(`     ✓  Stored as government request #${created.id}`);

  return report;
}

// ─── Stage 2: Booking ─────────────────────────────────────────────────────────
async function runBookingStage(probeReport = {}) {
  console.log('\n════════════════════════════════════════════════');
  console.log(' STAGE 2 — Booking Appointment');
  console.log(`════════════════════════════════════════════════`);
  console.log(`  apiOnly=${apiOnly}  browserOnly=${browserOnly}  dryRun=${dryRun}\n`);

  const notes  = process.env.APPT_NOTES || 'Arnona appointment – property tax section';
  const userId = process.env.APPT_USER_ID || 'local-gov-secure-flow';
  let bookingResult = null;
  let mode = null;

  const apiConfig = getTelAvivOfficialAppointmentApiConfig();

  // 2a — Try official REST API
  if (!browserOnly && apiConfig.configured) {
    console.log('[2a] Attempting official REST API booking...');
    try {
      const apiResult = await scheduleTelAvivAppointmentOfficial({
        userId,
        description: notes,
        notes: `Initiated via local-gov:secure:all flow. dryRun=${dryRun}`,
        category: process.env.APPT_CATEGORY || 'arnona',
      });
      bookingResult = apiResult;
      mode = 'official-api';
      console.log(`     ✓  Official API booking succeeded!`);
      console.log(`        externalRequestId: ${apiResult.appointment?.externalRequestId ?? '(none)'}`);
      console.log(`        status: ${apiResult.appointment?.upstreamStatus}`);
      console.log(`        confirmed: ${apiResult.appointment?.confirmed}`);
    } catch (err) {
      if (err instanceof MunicipalityApiUnavailableError) {
        console.log(`     ⚠  Official API unavailable – ${err.message}`);
      } else {
        console.error(`     ✗  Official API call failed: ${err.message}`);
      }
      if (!apiOnly) {
        console.log('     → Falling back to Playwright browser automation...');
      } else {
        console.log('     → --api-only set; not using browser fallback.');
        bookingResult = { ok: false, mode: 'official-api', error: err.message };
      }
    }
  } else if (!browserOnly && !apiConfig.configured) {
    console.log('[2a] Official API not configured – skipping REST API attempt.');
    if (!apiOnly) {
      console.log('     → Proceeding directly to Playwright browser automation.');
    }
  } else if (browserOnly) {
    console.log('[2a] --browser-only set – skipping official API attempt.');
  }

  // 2b — Playwright browser automation fallback (or primary if API not configured)
  if (!bookingResult?.ok && !apiOnly) {
    console.log('\n[2b] Running Playwright browser automation booking...');

    const applicant = {
      fullName: process.env.APPT_FULL_NAME || '',
      idNumber:  process.env.APPT_ID        || '',
      phone:     process.env.APPT_PHONE      || '',
      email:     process.env.APPT_EMAIL      || '',
      notes,
      ...(process.env.APPT_LOGIN_USER ? { loginUsername: process.env.APPT_LOGIN_USER } : {}),
      ...(process.env.APPT_LOGIN_PASS ? { loginPassword: process.env.APPT_LOGIN_PASS } : {}),
      ...(process.env.APPT_OTP       ? { otpCode: process.env.APPT_OTP }               : {}),
    };

    const trackedRequest = await createGovernmentRequest({
      userId,
      description: notes,
      status: 'new',
      notes: 'Playwright booking attempt from local-gov:secure:all flow',
    });

    const browserResult = await runTelAvivFullyAutomatedBooking({
      requestId: trackedRequest.id,
      applicant,
      intentText: notes,
      dryRun,
      confirmedSubmit: !dryRun,
      headless: String(process.env.APPT_HEADLESS || 'true').toLowerCase() !== 'false',
      maxRuntimeMs: Math.max(30000, Number(process.env.APPT_MAX_RUNTIME_MS || 300000)),
      pollIntervalMs: 2500,
      keepSessionOnFailure: true,
    });

    bookingResult = browserResult;
    mode = 'playwright-browser';

    if (browserResult?.submitted) {
      console.log('     ✓  Playwright booking successfully submitted!');
    } else if (browserResult?.session?.state === 'awaiting_login') {
      console.log('     ⚠  Stopped at login gate.');
      console.log('        → Set APPT_LOGIN_USER / APPT_LOGIN_PASS or use the UI "Save Credentials" panel.');
    } else if (browserResult?.session?.state === 'awaiting_otp') {
      console.log('     ⚠  OTP required.');
      console.log(`        → Re-run with: APPT_OTP=<code> npm run local-gov:secure:all`);
      console.log(`        → Resume token: ${browserResult?.session?.resumeToken || '(see output above)'}`);
    } else if (browserResult?.session?.state === 'awaiting_captcha') {
      console.log('     ⚠  CAPTCHA encountered – manual intervention required.');
      console.log(`        → Resume token: ${browserResult?.session?.resumeToken || '(see output above)'}`);
    } else {
      console.log(`     ⚠  Booking incomplete. State: ${browserResult?.session?.state || 'unknown'}. Reason: ${browserResult?.reason || browserResult?.error || 'unknown'}`);
    }
  }

  // 2c — Store booking result
  if (bookingResult) {
    console.log('\n[2c] Storing booking result to DB...');
    await createGovernmentRequest({
      userId,
      description: `Booking result (mode=${mode})`,
      status: bookingResult?.ok || bookingResult?.submitted ? 'completed' : 'pending',
      notes: JSON.stringify({ mode, ok: bookingResult?.ok ?? bookingResult?.submitted ?? false }),
    });
    console.log('     ✓  Stored booking result.');
  }

  return { mode, bookingResult };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  local-gov:secure:all — Integrated Flow          ║');
  console.log('║  (security:init ran as npm pre-hook)              ║');
  console.log('╚══════════════════════════════════════════════════╝');

  await ensureGovernmentRequestsTable();

  let probeReport = {};

  if (!skipProbe) {
    probeReport = await runProbeStage();
  } else {
    console.log('\n[STAGE 1] Skipped (--skip-probe).');
  }

  let bookingOutcome = {};

  if (!skipBooking) {
    bookingOutcome = await runBookingStage(probeReport);
  } else {
    console.log('\n[STAGE 2] Skipped (--skip-booking).');
  }

  console.log('\n════════════════════════════════════════════════');
  console.log(' SUMMARY');
  console.log('════════════════════════════════════════════════');
  if (!skipProbe) {
    console.log(`  Probe:   request #${probeReport.savedRequest?.id ?? '?'} stored, ` +
      `cachedDocs=${probeReport.cachedData?.totalDocs ?? '?'}, ` +
      `apiConfigured=${probeReport.officialApi?.configured ?? '?'}, ` +
      `credsSaved=${probeReport.credentials?.saved ?? '?'}`);
  }
  if (!skipBooking) {
    const ok = bookingOutcome?.bookingResult?.ok ?? bookingOutcome?.bookingResult?.submitted ?? false;
    console.log(`  Booking: mode=${bookingOutcome.mode ?? 'none'}, success=${ok}`);
  }
  console.log('\n  ✓ local-gov:secure:all flow complete.\n');
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
