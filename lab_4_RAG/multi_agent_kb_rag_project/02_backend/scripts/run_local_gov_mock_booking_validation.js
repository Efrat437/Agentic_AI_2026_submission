import 'dotenv/config';

import fs from 'fs/promises';
import path from 'path';
import { runSelfExtendingAgent } from '../making_operations/local_government/self_extending_agent.js';
import { startMockBookingServer } from '../making_operations/local_government/mock_booking_server.js';

const args = process.argv.slice(2);

function hasFlag(name) {
  return args.includes(name);
}

function getArgValue(name, fallback = '') {
  const index = args.indexOf(name);
  if (index >= 0 && index + 1 < args.length) return String(args[index + 1] || '').trim();
  return fallback;
}

function toInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function average(values = []) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (!filtered.length) return null;
  return Math.round(filtered.reduce((sum, value) => sum + value, 0) / filtered.length);
}

function percent(value, total) {
  if (!total) return 0;
  return Number(((value / total) * 100).toFixed(2));
}

function buildScenarioMatrix(iterations) {
  return [
    {
      name: 'stable',
      runs: iterations,
      config: {
        name: 'stable',
        slotProbability: 1,
        minSlots: 1,
        maxSlots: 2,
        failureProbability: 0,
        disappearProbability: 0,
        latencyMs: 40,
        latencyJitterMs: 20,
      },
    },
    {
      name: 'disappearing-slots',
      runs: iterations,
      config: {
        name: 'disappearing-slots',
        slotProbability: 1,
        minSlots: 1,
        maxSlots: 2,
        failureProbability: 0,
        disappearProbability: 0.55,
        latencyMs: 50,
        latencyJitterMs: 35,
      },
    },
    {
      name: 'flaky-api',
      runs: iterations,
      config: {
        name: 'flaky-api',
        slotProbability: 0.8,
        minSlots: 1,
        maxSlots: 3,
        failureProbability: 0.35,
        disappearProbability: 0.2,
        latencyMs: 60,
        latencyJitterMs: 60,
      },
    },
    {
      name: 'high-latency',
      runs: iterations,
      config: {
        name: 'high-latency',
        slotProbability: 0.9,
        minSlots: 1,
        maxSlots: 2,
        failureProbability: 0.15,
        disappearProbability: 0.1,
        latencyMs: 750,
        latencyJitterMs: 350,
      },
    },
  ];
}

function summarizeScenario(name, runs = []) {
  const successes = runs.filter((run) => run.success).length;
  const falsePositives = runs.reduce((sum, run) => sum + Number(run.falsePositives || 0), 0);
  const retries = runs.map((run) => Number(run.retries || 0));
  const slotIdentificationLatencies = runs.map((run) => run.slotIdentificationMs).filter((value) => Number.isFinite(value));

  return {
    scenario: name,
    totalRuns: runs.length,
    bookingSuccessPercent: percent(successes, runs.length),
    bookingSuccessCount: successes,
    falsePositiveCount: falsePositives,
    falsePositivePercent: percent(falsePositives, runs.length),
    averageSlotIdentificationMs: average(slotIdentificationLatencies),
    averageRetries: average(retries),
    maxRetries: retries.length ? Math.max(...retries) : 0,
    reservationBookingCount: runs.reduce((sum, run) => sum + Number(run.reservationBookings || 0), 0),
    circuitBreakerOpenedCount: runs.reduce((sum, run) => sum + Number(run.circuitBreakerOpenedCount || 0), 0),
    circuitBreakerSkippedCount: runs.reduce((sum, run) => sum + Number(run.circuitBreakerSkippedCount || 0), 0),
    transientRecoveryCount: runs.reduce((sum, run) => sum + Number(run.transientRecoveryCount || 0), 0),
    learnedEndpointsUpdated: runs.reduce((sum, run) => sum + Number(run.learnedEndpointsUpdated || 0), 0),
    learningBoostedCandidates: runs.reduce((sum, run) => sum + Number(run.learningBoostedCandidates || 0), 0),
    runs,
  };
}

async function main() {
  const iterations = Math.max(1, toInt(getArgValue('--iterations', process.env.MOCK_BOOKING_VALIDATION_ITERATIONS || '4'), 4));
  const evalRoot = path.resolve(process.cwd(), '02_backend', 'eval', 'local_government');
  const outputPath = getArgValue('--output', path.join(evalRoot, 'mock-booking-validation-report.json'));
  const logPath = getArgValue('--log-output', path.join(evalRoot, 'mock-booking-validation-log.jsonl'));
  const selectedScenario = getArgValue('--scenario', '').trim().toLowerCase();
  const keepOnlyDelta = hasFlag('--delta-only');

  const scenarioMatrix = buildScenarioMatrix(iterations).filter((scenario) => !selectedScenario || scenario.name === selectedScenario);
  const mockServer = await startMockBookingServer();
  const validationEvents = [];

  try {
    const scenarioReports = [];
    for (const scenario of scenarioMatrix) {
      const runs = [];
      for (let index = 0; index < scenario.runs; index += 1) {
        await mockServer.reset(scenario.config);
        const result = await runSelfExtendingAgent({
          websiteUrl: mockServer.baseUrl,
          requestText: 'Check slots and auto-book the first available appointment',
          applicantPayload: {
            autoBook: true,
            userConfirmation: false,
            pollIntervalMs: 150,
            fullName: 'Mock Runner',
            email: 'mock@example.com',
          },
          headless: true,
          maxRetries: 3,
          endpointHarvesting: {
            level: 'turbo20',
            strategy: 'high-level-efficient',
            browserAutomationHarvesting: true,
            includeJsInspection: true,
            includeWorkerScan: true,
            selfHealingSelectors: true,
            selfLearningSelectors: true,
            selfLearning: true,
            circuitBreaker: {
              enabled: true,
              failureThreshold: 2,
              cooldownMs: 350,
            },
            apiDiscoveryDeadlineMs: 12000,
          },
        });

        const stats = await mockServer.getStats();
        runs.push({
          run: index + 1,
          success: Boolean(result?.outcome?.bookingStatus === 'booked' || result?.outcome?.bookingOk),
          bookingStatus: result?.bookingState?.booking_status || result?.outcome?.bookingStatus || 'unknown',
          slotIdentificationMs: result?.metrics?.slotIdentificationMs ?? null,
          retries: Number(result?.metrics?.retries || 0),
          totalElapsedMs: Number(result?.metrics?.totalElapsedMs || result?.elapsedMs || 0),
          falsePositives: Number(stats?.stats?.falsePositives || 0),
          reservationBookings: Number(stats?.stats?.reservationBookings || 0),
          reservationsIssued: Number(stats?.stats?.reservationsIssued || 0),
          discoveredApis: Number(result?.metrics?.discoveredApis || 0),
          dynamicToolsCreated: Number(result?.metrics?.dynamicToolsCreated || 0),
          circuitBreakerOpenedCount: Number(result?.metrics?.circuitBreakerOpenedCount || 0),
          circuitBreakerSkippedCount: Number(result?.metrics?.circuitBreakerSkippedCount || 0),
          transientRecoveryCount: Number(result?.metrics?.transientRecoveryCount || 0),
          learnedEndpointsUpdated: Number(result?.metrics?.learnedEndpointsUpdated || 0),
          learningBoostedCandidates: Number(result?.metrics?.learningBoostedCandidates || 0),
        });
        validationEvents.push({
          loggedAt: new Date().toISOString(),
          scenario: scenario.name,
          run: index + 1,
          config: scenario.config,
          success: Boolean(result?.outcome?.bookingStatus === 'booked' || result?.outcome?.bookingOk),
          bookingStatus: result?.bookingState?.booking_status || result?.outcome?.bookingStatus || 'unknown',
          slotIdentificationMs: result?.metrics?.slotIdentificationMs ?? null,
          retries: Number(result?.metrics?.retries || 0),
          totalElapsedMs: Number(result?.metrics?.totalElapsedMs || result?.elapsedMs || 0),
          falsePositives: Number(stats?.stats?.falsePositives || 0),
          reservationBookings: Number(stats?.stats?.reservationBookings || 0),
          reservationsIssued: Number(stats?.stats?.reservationsIssued || 0),
          discoveredApis: Number(result?.metrics?.discoveredApis || 0),
          dynamicToolsCreated: Number(result?.metrics?.dynamicToolsCreated || 0),
          circuitBreakerOpenedCount: Number(result?.metrics?.circuitBreakerOpenedCount || 0),
          circuitBreakerSkippedCount: Number(result?.metrics?.circuitBreakerSkippedCount || 0),
          transientRecoveryCount: Number(result?.metrics?.transientRecoveryCount || 0),
          learnedEndpointsUpdated: Number(result?.metrics?.learnedEndpointsUpdated || 0),
          learningBoostedCandidates: Number(result?.metrics?.learningBoostedCandidates || 0),
        });
      }
      scenarioReports.push(summarizeScenario(scenario.name, runs));
    }

    const output = {
      ok: true,
      mode: 'mock-booking-validation',
      baseUrl: mockServer.baseUrl,
      iterations,
      generatedAt: new Date().toISOString(),
      logs: {
        summaryPath: outputPath,
        eventLogPath: logPath,
        eventCount: validationEvents.length,
      },
      scenarios: keepOnlyDelta
        ? scenarioReports.map((scenario) => ({
          scenario: scenario.scenario,
          bookingSuccessPercent: scenario.bookingSuccessPercent,
          falsePositivePercent: scenario.falsePositivePercent,
          averageSlotIdentificationMs: scenario.averageSlotIdentificationMs,
          averageRetries: scenario.averageRetries,
          maxRetries: scenario.maxRetries,
          reservationBookingCount: scenario.reservationBookingCount,
          circuitBreakerOpenedCount: scenario.circuitBreakerOpenedCount,
          circuitBreakerSkippedCount: scenario.circuitBreakerSkippedCount,
          transientRecoveryCount: scenario.transientRecoveryCount,
          learnedEndpointsUpdated: scenario.learnedEndpointsUpdated,
          learningBoostedCandidates: scenario.learningBoostedCandidates,
        }))
        : scenarioReports,
    };

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
    await fs.writeFile(logPath, `${validationEvents.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

    console.log(JSON.stringify(output, null, 2));
  } finally {
    await mockServer.stop();
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});