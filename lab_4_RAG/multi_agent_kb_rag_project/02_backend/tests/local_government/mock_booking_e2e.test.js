import test from 'node:test';
import assert from 'node:assert/strict';

import { startMockBookingServer } from '../../making_operations/local_government/mock_booking_server.js';
import { runSelfExtendingAgent } from '../../making_operations/local_government/self_extending_agent.js';

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function runAgainstMockServer(server, scenario, options = {}) {
  await server.reset(scenario);
  return runSelfExtendingAgent({
    websiteUrl: server.baseUrl,
    requestText: 'Check slots and auto-book the first available appointment',
    applicantPayload: {
      autoBook: true,
      userConfirmation: false,
      pollIntervalMs: 100,
      fullName: 'Test Runner',
      email: 'test@example.com',
    },
    headless: true,
    maxRetries: Number(options.maxRetries || 2),
    endpointHarvesting: {
      level: 'turbo20',
      strategy: 'high-level-efficient',
      includeJsInspection: true,
      includeWorkerScan: true,
      selfHealingSelectors: false,
      selfLearningSelectors: false,
      selfLearning: false,
      circuitBreaker: {
        enabled: true,
        failureThreshold: 2,
        cooldownMs: 300,
      },
      apiDiscoveryDeadlineMs: 12000,
      ...(options.endpointHarvesting || {}),
    },
  });
}

test('self-extending agent books successfully against stable mock server', async () => {
  const server = await startMockBookingServer();
  try {
    const result = await runAgainstMockServer(server, {
      slotProbability: 1,
      failureProbability: 0,
      disappearProbability: 0,
      latencyMs: 20,
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.steps.slots?.slots));
    assert.ok(result.steps.slots.slots.length >= 1);
    assert.equal(result.bookingState.booking_status, 'booked');
    assert.equal(result.bookingState.job_status, 'Done');
    assert.equal(result.outcome.bookingOk, true);
    assert.equal(result.outcome.finalStep, 'done');
    assert.ok(Number(result.metrics.slotIdentificationMs) >= 0);
    assert.ok(Number(result.metrics.dynamicToolsCreated) <= 8);
  } finally {
    await server.stop();
  }
});

test('self-extending agent waits and exits cleanly when no slots appear', async () => {
  const server = await startMockBookingServer();
  try {
    const result = await runAgainstMockServer(server, {
      slotProbability: 0,
      failureProbability: 0,
      disappearProbability: 0,
      latencyMs: 20,
    });

    assert.equal(result.outcome.bookingOk, false);
    assert.equal(result.bookingState.booking_status, 'no_slots_available');
    assert.equal(result.outcome.finalStep, 'done');
    assert.ok(result.metrics.retries >= 1);
    assert.ok(result.flow.some((entry) => String(entry).includes('wait_before_retry')));
    assert.equal(Array.isArray(result.steps.slots?.slots) ? result.steps.slots.slots.length : 0, 0);
  } finally {
    await server.stop();
  }
});

test('self-extending agent reports a failed booking when slots disappear', async () => {
  const server = await startMockBookingServer();
  try {
    const result = await runAgainstMockServer(server, {
      slotProbability: 1,
      failureProbability: 0,
      disappearProbability: 1,
      reservationMode: 'none',
      latencyMs: 20,
    });

    const stats = await server.getStats();
    assert.equal(result.outcome.bookingOk, false);
    assert.ok(['booking_failed', 'error', 'booking_retry_pending', 'no_slots_available'].includes(result.bookingState.booking_status));
    assert.ok(Number(stats.stats.bookCalls) >= 1 || Number(result.metrics.retries) >= 1);
  } finally {
    await server.stop();
  }
});

test('self-extending agent retries through slow transient failures when latency is high', async () => {
  const server = await startMockBookingServer();
  try {
    const result = await runAgainstMockServer(server, {
      slotProbability: 1,
      failureProbability: 1,
      healAfterFailures: 2,
      disappearProbability: 0,
      latencyMs: 800,
      latencyJitterMs: 0,
    }, {
      maxRetries: 1,
    });

    assert.equal(result.outcome.bookingOk, true);
    assert.equal(result.bookingState.booking_status, 'booked');
    assert.ok(Number(result.metrics.effectiveRetryBudget) > 1);
    assert.ok(Number(result.metrics.maxObservedToolLatencyMs) >= 800);
  } finally {
    await server.stop();
  }
});

test('self-extending agent opens the circuit breaker and recovers after transient failures heal', async () => {
  const server = await startMockBookingServer();
  try {
    const result = await runAgainstMockServer(server, {
      slotProbability: 1,
      failureProbability: 1,
      healAfterFailures: 2,
      disappearProbability: 0,
      latencyMs: 40,
      latencyJitterMs: 0,
    }, {
      maxRetries: 2,
      endpointHarvesting: {
        circuitBreaker: {
          enabled: true,
          failureThreshold: 1,
          cooldownMs: 250,
        },
      },
    });

    assert.equal(result.outcome.bookingOk, true);
    assert.equal(result.bookingState.booking_status, 'booked');
    assert.ok(Number(result.metrics.circuitBreakerOpenedCount) >= 1);
    assert.ok(Number(result.metrics.transientRecoveryCount) >= 1);
  } finally {
    await server.stop();
  }
});

test('self-extending agent falls back to another slot after a one-time booking conflict', async () => {
  const server = await startMockBookingServer();
  try {
    const result = await runAgainstMockServer(server, {
      slotProbability: 1,
      minSlots: 2,
      maxSlots: 2,
      failureProbability: 0,
      disappearProbability: 0,
      disappearFirstBookingOnly: true,
      reservationMode: 'none',
      latencyMs: 20,
    }, {
      maxRetries: 2,
    });

    const stats = await server.getStats();
    assert.equal(result.outcome.bookingOk, true);
    assert.equal(result.bookingState.booking_status, 'booked');
    assert.equal(Number(stats.stats.falsePositives), 1);
    assert.ok(Number(stats.stats.bookCalls) >= 2);
  } finally {
    await server.stop();
  }
});

test('self-extending agent uses reservation tokens to avoid booking-race false positives', async () => {
  const server = await startMockBookingServer();
  try {
    const result = await runAgainstMockServer(server, {
      slotProbability: 1,
      minSlots: 1,
      maxSlots: 1,
      failureProbability: 0,
      disappearProbability: 1,
      reservationMode: 'atomic',
      latencyMs: 20,
    }, {
      maxRetries: 1,
    });

    const stats = await server.getStats();
    assert.equal(result.outcome.bookingOk, true);
    assert.equal(result.bookingState.booking_status, 'booked');
    assert.equal(Number(stats.stats.falsePositives), 0);
    assert.ok(Number(stats.stats.reservationBookings) >= 1);
  } finally {
    await server.stop();
  }
});

test('mock booking server rejects invalid reservation modes', async () => {
  await assert.rejects(
    () => startMockBookingServer({ scenario: { reservationMode: 'best-effort' } }),
    /Invalid reservationMode/,
  );
});

test('mock booking server cleans expired reservations in the background and rotates atomic tokens', async () => {
  const server = await startMockBookingServer({
    scenario: {
      slotProbability: 1,
      minSlots: 1,
      maxSlots: 1,
      reservationMode: 'atomic',
      reservationTtlMs: 60,
      failureProbability: 0,
      disappearProbability: 0,
    },
  });
  try {
    const appointmentsResponse = await fetch(`${server.baseUrl}/appointments`);
    const appointmentsBody = await appointmentsResponse.json();
    const firstToken = appointmentsBody.slots[0]?.reservationToken;

    assert.ok(firstToken);

    await new Promise((resolve) => setTimeout(resolve, 220));

    const stats = await server.getStats();
    const rotatedSlot = stats.currentSlots[0] || null;

    assert.equal(Boolean(stats.reservations[firstToken]), false);
    assert.ok(rotatedSlot?.reservationToken);
    assert.notEqual(rotatedSlot?.reservationToken, firstToken);
  } finally {
    await server.stop();
  }
});

test('mock booking server derives healed failure probability without mutating scenario config', async () => {
  const server = await startMockBookingServer({
    scenario: {
      slotProbability: 1,
      minSlots: 1,
      maxSlots: 1,
      failureProbability: 1,
      healAfterFailures: 1,
      disappearProbability: 0,
    },
  });
  try {
    const first = await fetch(`${server.baseUrl}/appointments`);
    assert.equal(first.status, 503);

    const afterFailureStats = await server.getStats();
    assert.equal(afterFailureStats.scenario.failureProbability, 1);
    assert.equal(afterFailureStats.effectiveFailureProbability, 0);

    const second = await fetch(`${server.baseUrl}/appointments`);
    assert.equal(second.status, 200);
  } finally {
    await server.stop();
  }
});

test('mock booking server serializes booking mutations so only one concurrent atomic booking succeeds', async () => {
  const server = await startMockBookingServer({
    scenario: {
      slotProbability: 1,
      minSlots: 1,
      maxSlots: 1,
      reservationMode: 'atomic',
      failureProbability: 0,
      disappearProbability: 0,
      latencyMs: 0,
      latencyJitterMs: 0,
    },
  });
  try {
    const appointmentsResponse = await fetch(`${server.baseUrl}/appointments`);
    const appointmentsBody = await appointmentsResponse.json();
    const slot = appointmentsBody.slots[0];

    const [left, right] = await Promise.all([
      postJson(`${server.baseUrl}/book`, { selectedSlot: slot }),
      postJson(`${server.baseUrl}/book`, { selectedSlot: slot }),
    ]);

    const statuses = [left.status, right.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);

    const stats = await server.getStats();
    assert.equal(Number(stats.stats.successfulBookings), 1);
    assert.equal(Number(stats.stats.failedBookings), 1);
    assert.equal(stats.currentSlots.length, 0);
  } finally {
    await server.stop();
  }
});

test('mock booking server bounds booked slot history growth', async () => {
  const server = await startMockBookingServer({
    scenario: {
      slotProbability: 1,
      minSlots: 1,
      maxSlots: 1,
      reservationMode: 'none',
      failureProbability: 0,
      disappearProbability: 0,
    },
  });
  try {
    for (let index = 0; index < 130; index += 1) {
      const appointmentsResponse = await fetch(`${server.baseUrl}/appointments`);
      const appointmentsBody = await appointmentsResponse.json();
      const slot = appointmentsBody.slots[0];
      const booking = await postJson(`${server.baseUrl}/book`, { selectedSlot: slot });
      assert.equal(booking.status, 200);
    }

    const stats = await server.getStats();
    assert.equal(stats.stats.bookedSlotIds.length, 100);
  } finally {
    await server.stop();
  }
});