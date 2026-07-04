import {
  createGovernmentRequest,
  getGovernmentRequestById,
  updateGovernmentRequestStatus,
} from '../../../agents/dbTools.js';
import {
  extractBookingStateFromNotes,
  normalizeBookingState,
} from '../../../making_operations/local_government/booking_workflow.js';

function normalizeGovernmentRequestNotes(notes = null) {
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) {
    return notes;
  }

  const bookingState = extractBookingStateFromNotes(notes);
  if (!bookingState) {
    return notes;
  }

  return {
    ...notes,
    bookingState: normalizeBookingState({
      priorState: bookingState,
      availableSlots: bookingState.available_slots || [],
      selectedSlot: bookingState.selected_slot || null,
      bookingStatus: bookingState.booking_status || 'initialized',
      lastChecked: bookingState.last_checked || null,
      userConfirmation: bookingState.user_confirmation,
      autoBook: bookingState.auto_book,
      decision: bookingState.decision || null,
      nextCheckAt: bookingState.next_check_at || null,
      notification: bookingState.notification || null,
      queue: bookingState.queue || null,
      scheduler: bookingState.scheduler || null,
      session: bookingState.session || null,
      confirmationGranted: bookingState.confirmation_granted,
      requiresHumanGate: bookingState.requires_human_gate,
    }),
  };
}

function buildGovernmentRequestResponse(row = null) {
  if (!row) return { ok: false, error: 'Request not found' };
  const notes = normalizeGovernmentRequestNotes(row.notes);
  return {
    ok: true,
    request: {
      ...row,
      notes,
    },
    bookingWorkflow: notes?.bookingState || null,
  };
}

export async function newRequestForGovernment({ description, userId = null, notes = null } = {}) {
  const row = await createGovernmentRequest({
    userId,
    description,
    status: 'new',
    notes: normalizeGovernmentRequestNotes(notes),
  });
  return buildGovernmentRequestResponse(row);
}

export async function getRequestStatus({ id } = {}) {
  const row = await getGovernmentRequestById(id);
  if (!row) {
    return { ok: false, error: `Request not found: ${id}` };
  }
  return buildGovernmentRequestResponse(row);
}

export async function updateRequestStatus({ id, status, notes = null } = {}) {
  const row = await updateGovernmentRequestStatus({
    id,
    status,
    notes: normalizeGovernmentRequestNotes(notes),
  });
  if (!row) {
    return { ok: false, error: `Request not found: ${id}` };
  }
  return buildGovernmentRequestResponse(row);
}
