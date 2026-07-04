import 'dotenv/config';

import fs from 'fs/promises';
import path from 'path';

import {
  ensureMemoriesTable,
  ensureActionsTable,
  ensureGovernmentRequestsTable,
  saveMemory,
  getRecentMemories,
  saveProposedAction,
  getActionById,
  updateActionStatus,
  createGovernmentRequest,
  getGovernmentRequestById,
  updateGovernmentRequestStatus,
  cleanupEvaluationArtifacts,
} from '../agents/dbTools.js';
import { waitForDatabaseReady } from '../config/db.js';
import { startMockBookingServer } from '../making_operations/local_government/mock_booking_server.js';
import {
  startAttendedBookingSession,
  resumeAttendedBookingSession,
  approveAttendedBookingSubmit,
  submitAttendedBookingSession,
  stopAttendedBookingSession,
} from '../making_operations/local_government/browser_appointment_agent.js';
import { runSelfExtendingAgent } from '../making_operations/local_government/self_extending_agent.js';

const evalRoot = path.resolve(process.cwd(), '02_backend', 'eval', 'local_government');
const outputPath = path.join(evalRoot, 'local-booking-db-validation.json');

async function writeOutput(output) {
  await fs.mkdir(evalRoot, { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function mapCheckpointToRequestStatus(checkpointState = '') {
  return String(checkpointState || '').toLowerCase() === 'submitted' ? 'approved' : 'in_progress';
}

function normalizeTimestamp(value) {
  if (!value) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  const raw = String(value);
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime()) && raw.includes('T')) {
    return parsed.toISOString();
  }

  return raw;
}

async function main() {
  const marker = `local-gov-db-validation-${Date.now()}`;
  const userId = `eval-${marker}`;
  const memoryQuery = `Validate memories table for ${marker}`;
  let cleanup = null;

  try {
    const readiness = {
      read: await waitForDatabaseReady({ access: 'read' }),
      write: await waitForDatabaseReady({ access: 'write' }),
    };
    if (!readiness.read.ok || !readiness.write.ok) {
      throw new Error(`Database not ready (read=${readiness.read.ok}, write=${readiness.write.ok})`);
    }

    await ensureMemoriesTable();
    await ensureActionsTable();
    await ensureGovernmentRequestsTable();

    await saveMemory({
      userId,
      agent: 'local-gov-db-validation',
      query: memoryQuery,
      response: { ok: true, marker },
    });
    const memories = await getRecentMemories({ userId, agent: 'local-gov-db-validation', limit: 5 });

    const actionId = await saveProposedAction({
      agent: 'local-gov-db-validation',
      user_query: `Validate actions table for ${marker}`,
      proposed_sql: 'SELECT 1 AS ok',
      params: [marker],
    });
    await updateActionStatus(actionId, 'validated', { ok: true, marker });
    const action = await getActionById(actionId);

    const createdRequest = await createGovernmentRequest({
      userId,
      description: `Validate government_requests for ${marker}`,
      status: 'new',
      notes: { marker, phase: 'created', source: 'local-gov-db-validation' },
    });
    const updatedRequest = await updateGovernmentRequestStatus({
      id: createdRequest.id,
      status: 'in_progress',
      notes: { phase: 'updated', loggingVerified: true },
    });
    const fetchedRequest = await getGovernmentRequestById(createdRequest.id);

    const mockServer = await startMockBookingServer();
    let persistedSelfExtRequest = null;
    let observedSelfExtTransitions = [];
    let attendedValidation = null;
    try {
      await mockServer.reset({
        slotProbability: 1,
        minSlots: 1,
        maxSlots: 1,
        failureProbability: 0,
        disappearProbability: 0,
        latencyMs: 850,
      });
      const trackedSelfExtRequest = await createGovernmentRequest({
        userId,
        description: `Validate self-extending incremental persistence for ${marker}`,
        status: 'new',
        notes: { marker, source: 'local-gov-db-validation', bookingState: { booking_status: 'discovering_api' } },
      });
      let agentFinished = false;
      const selfExtPromise = runSelfExtendingAgent({
        websiteUrl: mockServer.baseUrl,
        requestText: 'Check slots and auto-book the first available appointment',
        requestId: trackedSelfExtRequest.id,
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
          circuitBreaker: { enabled: true, failureThreshold: 2, cooldownMs: 300 },
          apiDiscoveryDeadlineMs: 12000,
        },
      }).finally(() => {
        agentFinished = true;
      });

      const seenUpdatedAt = new Set();
      const seenTransitionKeys = new Set();
      const pollDeadlineAt = Date.now() + 45000;
      while (Date.now() < pollDeadlineAt) {
        const current = await getGovernmentRequestById(trackedSelfExtRequest.id);
        const updatedAt = normalizeTimestamp(current?.updated_at);
        const transitionKey = [
          updatedAt,
          String(current?.status || ''),
          String(current?.notes?.currentNode || ''),
          String(current?.notes?.bookingState?.booking_status || ''),
        ].join('|');
        if (updatedAt) seenUpdatedAt.add(updatedAt);
        if (updatedAt && transitionKey && !seenTransitionKeys.has(transitionKey)) {
          seenTransitionKeys.add(transitionKey);
          observedSelfExtTransitions.push({
            updatedAt,
            status: current?.status || null,
            currentNode: current?.notes?.currentNode || null,
            bookingStatus: current?.notes?.bookingState?.booking_status || null,
          });
        }
        if (agentFinished) {
          await sleep(150);
          const settled = await getGovernmentRequestById(trackedSelfExtRequest.id);
          const settledUpdatedAt = normalizeTimestamp(settled?.updated_at);
          const settledKey = [
            settledUpdatedAt,
            String(settled?.status || ''),
            String(settled?.notes?.currentNode || ''),
            String(settled?.notes?.bookingState?.booking_status || ''),
          ].join('|');
          if (settledUpdatedAt) seenUpdatedAt.add(settledUpdatedAt);
          if (settledUpdatedAt && settledKey && !seenTransitionKeys.has(settledKey)) {
            seenTransitionKeys.add(settledKey);
            observedSelfExtTransitions.push({
              updatedAt: settledUpdatedAt,
              status: settled?.status || null,
              currentNode: settled?.notes?.currentNode || null,
              bookingStatus: settled?.notes?.bookingState?.booking_status || null,
            });
          }
          break;
        }
        await sleep(60);
      }

      const selfExtResult = await selfExtPromise;
      persistedSelfExtRequest = await getGovernmentRequestById(trackedSelfExtRequest.id);
      fetchedRequest.selfExtResult = selfExtResult;

      const attendedRequest = await createGovernmentRequest({
        userId,
        description: `Validate attended session persistence for ${marker}`,
        status: 'new',
        notes: { marker, source: 'local-gov-db-validation', attendedFlow: { phase: 'created' } },
      });

      const attendedTransitions = [];
      const captureAttended = async (label) => {
        const current = await getGovernmentRequestById(attendedRequest.id);
        attendedTransitions.push({
          label,
          updatedAt: normalizeTimestamp(current?.updated_at) || null,
          status: current?.status || null,
          attendedEvent: current?.notes?.attendedEvent || null,
          bookingCheckpoint: current?.notes?.bookingCheckpoint || null,
          approvalApproved: Boolean(current?.notes?.attendedApproval?.approved),
        });
        return current;
      };

      const attendedSession = await startAttendedBookingSession({
        requestId: attendedRequest.id,
        bookingUrl: mockServer.baseUrl,
        applicant: {
          fullName: 'Eval User',
          email: 'eval@example.com',
          phone: '0500000000',
          notes: 'Attended validation run',
          extraFields: {
            selectedslot: 'slot-1',
            kind: 'slots',
          },
        },
        intentText: 'Check availability and prepare booking for submit',
        headless: true,
        timeoutMs: 45000,
      });
      await updateGovernmentRequestStatus({
        id: attendedRequest.id,
        status: mapCheckpointToRequestStatus(attendedSession?.state),
        notes: {
          attendedEvent: 'session-started',
          bookingCheckpoint: attendedSession?.state || null,
          attendedSessionToken: attendedSession?.token || null,
          attendedCurrentUrl: attendedSession?.currentUrl || null,
        },
      });
      await sleep(50);
      await captureAttended('started');

      const resumedSession = await resumeAttendedBookingSession(attendedSession.token, {
        applicant: {
          notes: 'Operator resumed the flow once and saved site-specific fields',
          extraFields: {
            selectedslot: 'slot-1',
            kind: 'slots',
          },
        },
      });
      await updateGovernmentRequestStatus({
        id: attendedRequest.id,
        status: mapCheckpointToRequestStatus(resumedSession?.state),
        notes: {
          attendedEvent: 'session-resumed',
          bookingCheckpoint: resumedSession?.state || null,
          attendedSessionToken: resumedSession?.token || null,
        },
      });
      await sleep(50);
      await captureAttended('resumed');

      await approveAttendedBookingSubmit(attendedSession.token, { approvedBy: 'eval-human', reason: 'db validation approval' });
      await sleep(50);
      await captureAttended('approved');

      await submitAttendedBookingSession(attendedSession.token);
      await sleep(50);
      const finalAttendedRequest = await captureAttended('submitted');

      attendedValidation = {
        requestId: attendedRequest.id,
        finalStatus: finalAttendedRequest?.status || null,
        finalNotes: finalAttendedRequest?.notes || null,
        observedTransitions: attendedTransitions,
        observedEventSequence: attendedTransitions.map((entry) => entry.attendedEvent).filter(Boolean),
        approvalPersisted: Boolean(finalAttendedRequest?.notes?.attendedApproval?.approved),
        submitPersisted: String(finalAttendedRequest?.notes?.attendedEvent || '') === 'submit-completed',
        incrementalUpdatesVerified: Array.from(new Set(attendedTransitions.map((entry) => normalizeTimestamp(entry.updatedAt)).filter(Boolean))).length >= 4,
      };

      await stopAttendedBookingSession(attendedSession.token, { reason: 'attended validation cleanup' }).catch(() => {});
    } finally {
      await mockServer.stop();
    }

    const uniqueTransitionNodes = Array.from(new Set(observedSelfExtTransitions.map((entry) => String(entry?.currentNode || '')).filter(Boolean)));
    const uniqueTransitionStatuses = Array.from(new Set(observedSelfExtTransitions.map((entry) => String(entry?.status || '')).filter(Boolean)));
    const uniqueUpdatedAtCount = Array.from(new Set(observedSelfExtTransitions.map((entry) => normalizeTimestamp(entry?.updatedAt)).filter(Boolean))).length;

    cleanup = await cleanupEvaluationArtifacts({ userIds: [userId], markers: [marker] });

    const output = {
      ok: true,
      mode: 'local-gov-db-assignment-validation',
      generatedAt: new Date().toISOString(),
      readiness,
      validations: {
        memories: {
          inserted: memories.some((entry) => String(entry?.query || '') === memoryQuery),
          recentCount: memories.length,
        },
        actions: {
          actionId,
          status: action?.status || null,
          executedAt: action?.executed_at || null,
        },
        governmentRequests: {
          createdId: createdRequest.id,
          updatedStatus: updatedRequest?.status || null,
          fetchedStatus: fetchedRequest?.status || null,
          mergedNotes: fetchedRequest?.notes || null,
        },
        selfExtendingPersistence: {
          persisted: Boolean(persistedSelfExtRequest?.notes?.bookingState),
          fetchedStatus: persistedSelfExtRequest?.status || null,
          currentNode: persistedSelfExtRequest?.notes?.currentNode || null,
          flowTailCount: Array.isArray(persistedSelfExtRequest?.notes?.flowTail) ? persistedSelfExtRequest.notes.flowTail.length : 0,
          bookingState: persistedSelfExtRequest?.notes?.bookingState || null,
          resilience: persistedSelfExtRequest?.notes?.resilience || null,
          observedTransitionCount: observedSelfExtTransitions.length,
          observedUpdatedAtCount: uniqueUpdatedAtCount,
          observedTransitionNodes: uniqueTransitionNodes,
          observedTransitionStatuses: uniqueTransitionStatuses,
          observedTransitions: observedSelfExtTransitions,
          incrementalUpdatesVerified: uniqueUpdatedAtCount >= 3 && uniqueTransitionNodes.length >= 2,
        },
        attendedPersistence: attendedValidation,
      },
      cleanup,
    };

    await writeOutput(output);
    console.log(JSON.stringify(output, null, 2));
  } catch (error) {
    const output = {
      ok: false,
      mode: 'local-gov-db-assignment-validation',
      generatedAt: new Date().toISOString(),
      error: error?.message || String(error),
      cleanup,
    };
    await writeOutput(output);
    console.error(output.error);
    process.exit(1);
  }
}

main();