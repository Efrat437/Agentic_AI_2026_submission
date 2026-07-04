import 'dotenv/config';

import fs from 'fs/promises';
import path from 'path';

import { runSelfExtendingAgent } from '../making_operations/local_government/self_extending_agent.js';
import { startMockBookingServer } from '../making_operations/local_government/mock_booking_server.js';

const outputPath = path.resolve(process.cwd(), '02_backend', 'eval', 'local_government', 'circuit-breaker-validation.json');

const profiles = [
  { name: 'aggressive', failureThreshold: 1, cooldownMs: 250 },
  { name: 'balanced', failureThreshold: 2, cooldownMs: 350 },
  { name: 'conservative', failureThreshold: 3, cooldownMs: 900 },
];

async function runProfile(server, profile) {
  const runs = [];
  for (let index = 0; index < 3; index += 1) {
    await server.reset({
      slotProbability: 1,
      minSlots: 1,
      maxSlots: 2,
      failureProbability: 1,
      healAfterFailures: 2,
      disappearProbability: 0,
      latencyMs: 40,
      latencyJitterMs: 0,
    });
    const result = await runSelfExtendingAgent({
      websiteUrl: server.baseUrl,
      requestText: 'Check slots and auto-book the first available appointment',
      applicantPayload: {
        autoBook: true,
        userConfirmation: false,
        pollIntervalMs: 100,
        fullName: 'Eval User',
        email: 'eval@example.com',
      },
      headless: true,
      maxRetries: 2,
      endpointHarvesting: {
        level: 'turbo20',
        strategy: 'high-level-efficient',
        selfLearning: false,
        circuitBreaker: {
          enabled: true,
          failureThreshold: profile.failureThreshold,
          cooldownMs: profile.cooldownMs,
        },
        apiDiscoveryDeadlineMs: 12000,
      },
    });
    runs.push({
      run: index + 1,
      success: Boolean(result?.outcome?.bookingOk),
      bookingStatus: result?.outcome?.bookingStatus || null,
      retries: Number(result?.metrics?.retries || 0),
      totalElapsedMs: Number(result?.metrics?.totalElapsedMs || result?.elapsedMs || 0),
      circuitBreakerOpenedCount: Number(result?.metrics?.circuitBreakerOpenedCount || 0),
      circuitBreakerSkippedCount: Number(result?.metrics?.circuitBreakerSkippedCount || 0),
      transientRecoveryCount: Number(result?.metrics?.transientRecoveryCount || 0),
    });
  }
  return {
    profile,
    runs,
    successCount: runs.filter((run) => run.success).length,
    averageRetries: Math.round(runs.reduce((sum, run) => sum + run.retries, 0) / runs.length),
    averageElapsedMs: Math.round(runs.reduce((sum, run) => sum + run.totalElapsedMs, 0) / runs.length),
    circuitBreakerOpenedCount: runs.reduce((sum, run) => sum + run.circuitBreakerOpenedCount, 0),
    circuitBreakerSkippedCount: runs.reduce((sum, run) => sum + run.circuitBreakerSkippedCount, 0),
    transientRecoveryCount: runs.reduce((sum, run) => sum + run.transientRecoveryCount, 0),
  };
}

async function main() {
  const server = await startMockBookingServer();
  try {
    const profileReports = [];
    for (const profile of profiles) {
      profileReports.push(await runProfile(server, profile));
    }
    const output = {
      ok: true,
      mode: 'circuit-breaker-threshold-cooldown-validation',
      generatedAt: new Date().toISOString(),
      baseUrl: server.baseUrl,
      explanation: {
        threshold: 'Lower threshold opens the circuit breaker after fewer consecutive transient failures.',
        cooldown: 'Longer cooldown keeps a failing endpoint skipped for longer before half-open retry is allowed.',
        impact: 'These settings trade off recovery speed, retry pressure on unstable upstreams, and total booking latency.',
      },
      profiles: profileReports,
    };
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await server.stop();
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
