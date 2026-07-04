import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWorkflowScheduler,
  deriveBookingDecision,
  mapBookingStateToJobStatus,
  mapBookingStatusToRequestStatus,
  normalizeBookingState,
  normalizeBookingSlotEntry,
  scoreBookingSlot,
  selectPreferredBookingSlot,
} from '../../making_operations/local_government/booking_workflow.js';

test('deriveBookingDecision returns wait_and_recheck when no slots exist', () => {
  const decision = deriveBookingDecision({
    availableSlots: [],
    autoBook: false,
    confirmationGranted: false,
    slotCheckFailed: false,
  });

  assert.equal(decision.decision, 'wait_and_recheck');
  assert.equal(decision.bookingStatus, 'waiting_for_slots');
  assert.equal(decision.shouldWait, true);
});

test('deriveBookingDecision returns notify_and_wait_for_confirmation when slots exist but confirmation is needed', () => {
  const decision = deriveBookingDecision({
    availableSlots: [{ id: 'slot-1', label: 'Slot 1' }],
    autoBook: false,
    confirmationGranted: false,
  });

  assert.equal(decision.decision, 'notify_and_wait_for_confirmation');
  assert.equal(decision.bookingStatus, 'awaiting_user_confirmation');
  assert.equal(decision.requiresHumanGate, true);
});

test('deriveBookingDecision returns auto_book when slots exist and autoBook is enabled', () => {
  const decision = deriveBookingDecision({
    availableSlots: [{ id: 'slot-1', label: 'Slot 1' }],
    autoBook: true,
  });

  assert.equal(decision.decision, 'auto_book');
  assert.equal(decision.bookingStatus, 'auto_book_ready');
  assert.equal(decision.shouldBook, true);
});

test('normalizeBookingState preserves key workflow fields', () => {
  const slot = normalizeBookingSlotEntry({ id: 'slot-1', label: 'Slot 1' });
  const state = normalizeBookingState({
    availableSlots: [slot],
    selectedSlot: slot,
    bookingStatus: 'booking_ready',
    lastChecked: '2026-04-25T10:00:00.000Z',
    userConfirmation: true,
    autoBook: false,
    decision: 'book_confirmed_slot',
    nextCheckAt: '2026-04-25T10:05:00.000Z',
    confirmationGranted: true,
    requiresHumanGate: false,
  });

  assert.equal(state.booking_status, 'booking_ready');
  assert.equal(state.job_status, 'Found');
  assert.equal(state.user_confirmation, true);
  assert.equal(state.confirmation_granted, true);
  assert.equal(state.selected_slot.value, 'slot-1');
  assert.equal(state.decision, 'book_confirmed_slot');
});

test('mapBookingStateToJobStatus exposes Found and Done aliases for external consumers', () => {
  assert.equal(mapBookingStateToJobStatus({ bookingStatus: 'slots_found', currentStep: 'decide' }), 'Found');
  assert.equal(mapBookingStateToJobStatus({ bookingStatus: 'booked', currentStep: 'done', completed: true }), 'Done');
  assert.equal(mapBookingStateToJobStatus({ bookingStatus: 'waiting_for_slots', currentStep: 'wait_before_retry' }), 'Waiting');
});

test('mapBookingStatusToRequestStatus maps booked workflow state to approved request status', () => {
  assert.equal(mapBookingStatusToRequestStatus('booked'), 'approved');
  assert.equal(mapBookingStatusToRequestStatus('waiting_for_slots'), 'in_progress');
  assert.equal(mapBookingStatusToRequestStatus('booking_failed'), 'rejected');
});

test('normalizeBookingSlotEntry preserves datetime using nullish-style fallback and timezone metadata', () => {
  const slot = normalizeBookingSlotEntry({
    id: 0,
    label: '',
    datetime: '2026-05-01T09:30:00+03:00',
    timezone: 'Asia/Jerusalem',
  });

  assert.equal(slot.value, '0');
  assert.equal(slot.datetime_utc, '2026-05-01T06:30:00.000Z');
  assert.equal(slot.timezone, 'Asia/Jerusalem');
  assert.equal(slot.valid, true);
});

test('selectPreferredBookingSlot supports close textual matching and prefers the closest slot', () => {
  const selected = selectPreferredBookingSlot({
    availableSlots: [
      { id: 'slot-1', label: '2026-05-01 08:30' },
      { id: 'slot-2', label: '2026-05-01 09:00 municipal arnona' },
      { id: 'slot-3', label: '2026-05-01 15:00' },
    ],
    preferredSlot: 'arnona 9:00',
  });

  assert.equal(selected?.value, 'slot-2');
});

test('scoreBookingSlot prioritizes preferred time windows and near matches', () => {
  const strong = scoreBookingSlot(
    { id: 'slot-a', label: '2026-05-01 09:15', datetime: '2026-05-01T09:15:00+03:00' },
    { preferredTimeRanges: [{ start: '09:00', end: '10:00' }], preferredSlot: '09:15' }
  );
  const weak = scoreBookingSlot(
    { id: 'slot-b', label: '2026-05-01 16:45', datetime: '2026-05-01T16:45:00+03:00' },
    { preferredTimeRanges: [{ start: '09:00', end: '10:00' }], preferredSlot: '09:15' }
  );

  assert.ok(strong.score > weak.score);
  assert.ok(strong.reasons.includes('preferred-time-window'));
});

test('deriveBookingDecision returns scored slots and automation mode consistently', () => {
  const decision = deriveBookingDecision({
    availableSlots: [
      { id: 'slot-1', label: '2026-05-01 12:00' },
      { id: 'slot-2', label: '2026-05-01 09:00 arnona' },
    ],
    preferredSlot: 'arnona 09:00',
    confirmationGranted: true,
  });

  assert.equal(decision.decision, 'book_confirmed_slot');
  assert.equal(decision.automationMode, 'confirmed');
  assert.equal(decision.selectedSlot?.value, 'slot-2');
  assert.equal(Array.isArray(decision.scoredSlots), true);
});

test('normalizeBookingState exposes unified hierarchy and retry metadata', () => {
  const state = normalizeBookingState({
    availableSlots: [],
    slotCheckFailed: true,
    bookingStatus: 'slot_check_failed',
    decision: 'wait_and_recheck',
    currentStep: 'wait_before_retry',
  });

  assert.equal(state.unified_state, 'waiting');
  assert.equal(state.state_hierarchy.booking, 'slot_check_failed');
  assert.equal(state.state_hierarchy.job, 'Failed');
  assert.ok(state.retry || state.next_check_at);
});

test('buildWorkflowScheduler validates cron expressions and preserves timezone', () => {
  const validScheduler = buildWorkflowScheduler({
    cronExpression: '*/5 * * * *',
    timeZone: 'Asia/Jerusalem',
  });
  const invalidScheduler = buildWorkflowScheduler({
    cronExpression: '90 * * * *',
    timeZone: 'Invalid/Timezone',
  });

  assert.equal(validScheduler.cron_valid, true);
  assert.equal(validScheduler.timezone, 'Asia/Jerusalem');
  assert.equal(invalidScheduler.cron_valid, false);
  assert.equal(invalidScheduler.timezone, 'Asia/Jerusalem');
});