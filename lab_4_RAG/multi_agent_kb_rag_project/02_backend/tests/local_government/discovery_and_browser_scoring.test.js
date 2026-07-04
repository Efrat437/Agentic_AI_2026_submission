import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import https from 'node:https';

import { extractSlots } from '../../making_operations/local_government/self_extending_agent.js';
import {
  buildAgentDebugView,
  buildSelectorExecutionPlan,
  buildReplayExplanationView,
  explainDecision,
  inferBookingFlowPhase,
  inferInteractionStage,
  scoreActionCandidateByEmbeddings,
  scoreBookingFormCandidate,
  scoreTelAvivFlowActionCandidate,
  scoreTelAvivPaymentTableCandidate,
} from '../../making_operations/local_government/browser_appointment_agent.js';
import {
  summarizePaymentProvider,
  analyzePaymentProviderBoundary,
  buildPaymentBoundaryUiSummary,
  extractToken,
  normalizeManualPaymentBoundaryEvidence,
} from '../../making_operations/local_government/payment_provider_adapters.js';
import {
  buildRequestBody,
  getTelAvivOfficialAppointmentApiConfig,
  MunicipalityApiUnavailableError,
  normalizeCreateUrl,
  scheduleTelAvivAppointmentOfficial,
} from '../../making_operations/local_government/official_appointment_api.js';
import {
  buildAttendedActionRecord,
  buildDomVersion,
  inferApplicantBinding,
  listLearnedActionsForHost,
  markReplayResult,
  mergeAttendedSessionLearning,
  resolveApplicantBindingValue,
  scoreReplayRecordForPage,
  scoreFieldForRecordedInput,
} from '../../making_operations/local_government/attended_dom_learning.js';

async function withEnv(overrides, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides || {})) {
    previous.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withFetchMock(implementation, callback) {
  const previous = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    return await callback();
  } finally {
    if (previous) globalThis.fetch = previous;
    else delete globalThis.fetch;
  }
}

test('extractSlots parses structured availability maps returned by live-style APIs', () => {
  const slots = extractSlots({
    possibleAppointments: {
      '2026-04-27': ['08:30:00', '09:00:00'],
      '2026-04-28': ['17:00:00'],
      '2026-04-29': [],
    },
  });

  assert.equal(slots.length, 3);
  assert.equal(slots[0].date, '2026-04-27');
  assert.equal(slots[0].time, '08:30:00');
  assert.equal(slots[0].slotId, '2026-04-27T08:30:00');
});

test('scoreBookingFormCandidate prefers booking forms over feedback forms', () => {
  const feedbackScore = scoreBookingFormCandidate({
    action: '/appointments/?id=67&select-date=1',
    fields: [
      { id: 'feedback_yes', name: 'feedback', label: 'כן', type: 'radio' },
      { id: 'feedback_description', name: 'description', label: 'נשמח אם תפרט/י:', type: 'textarea' },
      { id: 'feedback_name', name: 'name', label: 'שם:', type: 'input' },
      { id: 'feedback_email', name: 'email', label: 'דוא"ל:', type: 'input' },
      { id: 'feedback_phone', name: 'phone', label: 'טלפון:', type: 'input' },
    ],
    submitButtons: [{ text: 'שלח', type: '' }],
  }, 'האם דף זה עזר לך? שתף את העמוד');

  const bookingScore = scoreBookingFormCandidate({
    action: '/appointments/?schedule=1&departmentId=67&date=2026-04-27&time=08:30:00',
    fields: [
      { id: 'full_name', name: 'full_name', label: 'שם מלא *', type: 'input' },
      { id: 'phone', name: 'phone', label: 'מספר טלפון סלולרי *', type: 'input' },
      { id: 'email', name: 'email', label: 'כתובת דוא"ל *', type: 'input' },
      { id: 'notes', name: 'notes', label: 'הערות לנציג', type: 'textarea' },
    ],
    submitButtons: [{ text: 'שלח', type: '' }],
  }, 'זימון תור בחרו את השעה הרצויה תיאום תור');

  assert.ok(bookingScore > feedbackScore);
  assert.ok(bookingScore >= 20);
  assert.ok(feedbackScore < 12);
});

test('scoreTelAvivFlowActionCandidate prefers Tel Aviv booking wizard actions over site chrome', () => {
  const appointmentButtonScore = scoreTelAvivFlowActionCandidate({
    text: 'לקוח פרטי',
    href: 'javascript:void(0);',
    onclick: 'getCustomerType(24);',
    id: 'client_24',
    name: 'client_type',
  }, { intentText: 'arnona appointment booking', mode: 'booking' });

  const footerLinkScore = scoreTelAvivFlowActionCandidate({
    text: 'מדיניות הפרטיות',
    href: '/About/Pages/PrivacyStatement.aspx',
    onclick: '',
    id: '',
    name: '',
  }, { intentText: 'arnona appointment booking', mode: 'booking' });

  assert.ok(appointmentButtonScore > footerLinkScore);
  assert.ok(appointmentButtonScore >= 25);
  assert.ok(footerLinkScore < 10);
});

test('scoreTelAvivFlowActionCandidate prefers payment targets in payment mode', () => {
  const paymentScore = scoreTelAvivFlowActionCandidate({
    text: 'תשלומי ארנונה',
    href: 'https://payments.example.invalid/arnona',
    onclick: '',
    id: 'pay-arnona',
    name: 'payment_link',
  }, { intentText: 'arnona payment', mode: 'payment' });

  const bookingScore = scoreTelAvivFlowActionCandidate({
    text: 'זימון תורים',
    href: '/Contact/Pages/Appointments.aspx',
    onclick: '',
    id: 'appt-link',
    name: '',
  }, { intentText: 'arnona payment', mode: 'payment' });

  assert.ok(paymentScore > bookingScore);
});

test('buildSelectorExecutionPlan orders api, role, text, and heuristic stages distinctly', () => {
  const plan = buildSelectorExecutionPlan({
    intent: 'book arnona appointment',
    record: {
      text: 'לקוח פרטי',
      label: 'לקוח פרטי',
      href: '/Contact/Pages/Appointments.aspx?service=arnona',
      onclick: 'getCustomerType(24);',
      role: 'button',
      tag: 'button',
    },
    providedSelectors: ['#primary-booking-cta'],
    learnedSelectors: ['.learned-booking-link'],
  });

  assert.ok(plan.apiSelectors.some((selector) => selector.includes('Appointments.aspx')));
  assert.ok(plan.apiSelectors.some((selector) => selector.includes('onclick')));
  assert.deepEqual(plan.roleHints[0], { role: 'button', name: 'לקוח פרטי' });
  assert.ok(plan.textSelectors.some((selector) => selector.includes('לקוח פרטי')));
  assert.equal(plan.heuristicSelectors[0], '#primary-booking-cta');
  assert.equal(plan.heuristicSelectors[1], '.learned-booking-link');
});

test('scoreActionCandidateByEmbeddings prefers semantically aligned booking actions', () => {
  const bookingScore = scoreActionCandidateByEmbeddings({
    text: 'Book Arnona appointment now',
    href: '/Contact/Pages/Appointments.aspx?service=arnona',
    ariaLabel: 'Book Arnona appointment',
  }, {
    intent: 'book arnona appointment',
    record: { text: 'Arnona appointment' },
  });

  const unrelatedScore = scoreActionCandidateByEmbeddings({
    text: 'Privacy policy',
    href: '/About/Pages/PrivacyStatement.aspx',
    ariaLabel: 'Privacy policy',
  }, {
    intent: 'book arnona appointment',
    record: { text: 'Arnona appointment' },
  });

  assert.ok(bookingScore > unrelatedScore);
  assert.ok(bookingScore >= 40);
});

test('scoreTelAvivPaymentTableCandidate prefers Arnona payment rows over unrelated municipal payment rows', () => {
  const arnonaRow = scoreTelAvivPaymentTableCandidate({
    text: 'לתשלום',
    href: 'https://payments.example.invalid/arnona',
    rowText: 'ארנונה | תשלום מקוון | לתשלום',
    sectionText: 'תשלומים עירוניים',
    cellCount: 3,
  }, { intentText: 'arnona payment' });

  const parkingRow = scoreTelAvivPaymentTableCandidate({
    text: 'לתשלום',
    href: 'https://payments.example.invalid/parking',
    rowText: 'דוחות חניה | תשלום מקוון | לתשלום',
    sectionText: 'תשלומים עירוניים',
    cellCount: 3,
  }, { intentText: 'arnona payment' });

  assert.ok(arnonaRow > parkingRow);
});

test('inferBookingFlowPhase recognizes Tel Aviv queue identification, diary, and approval steps', () => {
  const identification = inferBookingFlowPhase({
    href: 'https://www5.tel-aviv.gov.il/TlvForms/TlvQueueReservation/default.aspx',
    title: 'Queue reservation - identification',
    pageText: 'לקוח פרטי שם מלא תעודת זהות טלפון דוא"ל',
    forms: [{
      fields: [
        { name: 'idNumber', label: 'תעודת זהות' },
        { name: 'phone', label: 'טלפון' },
      ],
    }],
  });
  const diary = inferBookingFlowPhase({
    href: 'https://www5.tel-aviv.gov.il/TlvForms/TlvQueueReservation/default.aspx?step=2',
    title: 'Appointment diary',
    pageText: 'Appointment diary choose date choose time calendar available appointments',
    forms: [{
      fields: [{ name: 'date', label: 'Select date' }, { name: 'time', label: 'Select time' }],
    }],
  });
  const approval = inferBookingFlowPhase({
    href: 'https://www5.tel-aviv.gov.il/TlvForms/TlvQueueReservation/default.aspx?step=3',
    title: 'Approval summary',
    pageText: 'אישור הזמנה סיכום פרטי התור',
    forms: [{ submitButtons: [{ text: 'אישור' }] }],
  });

  assert.equal(identification.phaseKey, 'identification');
  assert.equal(identification.stepNumber, 1);
  assert.equal(diary.phaseKey, 'appointment_diary');
  assert.equal(diary.stepNumber, 2);
  assert.equal(approval.phaseKey, 'approval');
  assert.equal(approval.stepNumber, 3);
});

test('inferInteractionStage maps login, otp, form, review, and submit states clearly', () => {
  const loginStage = inferInteractionStage({
    text: 'Please sign in with your email and password to continue',
    submitted: false,
    flowPhase: { phaseKey: 'unknown' },
  });
  const otpStage = inferInteractionStage({
    text: 'Enter the verification code we sent by SMS',
    submitted: false,
    flowPhase: { phaseKey: 'unknown' },
  });
  const formStage = inferInteractionStage({
    text: 'בחרו את השעה הרצויה מלאו את פרטי הפונה',
    submitted: false,
    flowPhase: { phaseKey: 'appointment_diary' },
  });
  const reviewStage = inferInteractionStage({
    text: 'Approval summary review your booking before confirmation',
    submitted: false,
    flowPhase: { phaseKey: 'approval' },
  });
  const submittedStage = inferInteractionStage({
    text: 'Booking confirmed',
    submitted: true,
    flowPhase: { phaseKey: 'approval' },
  });

  assert.equal(loginStage, 'login');
  assert.equal(otpStage, 'otp');
  assert.equal(formStage, 'form');
  assert.equal(reviewStage, 'review');
  assert.equal(submittedStage, 'submit');
});

test('explainDecision summarizes the active ranking signals', () => {
  const explanation = explainDecision({
    textMatch: true,
    hrefMatch: true,
    intentBoost: true,
    replayScore: 31,
    successRate: 0.88,
    domFingerprint: 'abc123',
  });

  assert.deepEqual(explanation.signals, [
    'text match',
    'href match',
    'intent match',
    'learned behavior',
    'high success rate',
    'dom fingerprint',
  ]);
});

test('buildReplayExplanationView returns candidate explanations and recent replay activity', () => {
  const view = buildReplayExplanationView({
    interactionStage: 'form',
    replay: {
      candidateCount: 4,
      appliedCount: 2,
      failureCount: 1,
      actions: [
        { at: '2026-04-26T10:00:00.000Z', action: 'Continue', mode: 'provided-selector', selector: '#continue', ok: true },
        { at: '2026-04-26T10:00:01.000Z', action: 'Submit', mode: 'replay-failed', selector: '.submit', ok: false, reason: 'hidden' },
      ],
    },
    domFailures: [
      { at: '2026-04-26T10:00:02.000Z', reason: 'learned-dom-replay-exhausted', bucket: 'replay', url: 'https://example.invalid' },
    ],
    debug: {
      replaySimulator: {
        lastRun: {
          candidates: [
            {
              text: 'Continue',
              selector: '#continue',
              replayScore: 42,
              replayConfidence: 0.84,
              successRate: 0.9,
              explanation: { signals: ['text match', 'high success rate'] },
            },
          ],
        },
      },
      timeline: [
        { type: 'replay-action', action: 'Continue', status: 'applied' },
      ],
    },
    actionLog: [],
  });

  assert.equal(view.currentStage, 'form');
  assert.equal(view.topCandidates[0].text, 'Continue');
  assert.equal(view.recentActions.length, 2);
  assert.equal(view.recentFailures[0].bucket, 'replay');
});

test('buildAgentDebugView exposes a compact debuggable agent summary', () => {
  const agentDebug = buildAgentDebugView({
    state: 'awaiting_otp',
    interactionStage: 'otp',
    flowPhase: { phaseKey: 'appointment_diary' },
    hitlRequired: true,
    hitlReason: 'dom-replay-mismatch',
    debugOptions: { timelineDebugMode: true },
    debug: {
      timeline: [{ id: '1', action: 'auto-otp' }],
      snapshots: [{ domFingerprint: 'abc123' }],
      errorBuckets: { replay: 2 },
      replaySimulator: { lastRun: { candidates: [] } },
    },
    replay: { candidateCount: 0, appliedCount: 0, failureCount: 0, actions: [] },
    actionLog: [],
    domFailures: [],
  }, { elapsedMs: 3210, mode: 'autonomous-browser-agent' });

  assert.equal(agentDebug.mode, 'autonomous-browser-agent');
  assert.equal(agentDebug.interactionStage, 'otp');
  assert.equal(agentDebug.errorBuckets.replay, 2);
  assert.equal(agentDebug.lastDomFingerprint, 'abc123');
  assert.equal(agentDebug.replayExplanationView.currentStage, 'otp');
});

test('summarizePaymentProvider detects known external provider hosts', () => {
  const summary = summarizePaymentProvider('https://secure.meshulam.co.il/checkout/arnona', 'Payment checkout for arnona');

  assert.equal(summary.provider, 'meshulam');
  assert.equal(summary.host, 'secure.meshulam.co.il');
  assert.equal(summary.handoffDetected, true);
});

test('analyzePaymentProviderBoundary chooses the Tel Aviv internal adapter until a real external handoff occurs', () => {
  const providerSummary = summarizePaymentProvider(
    'https://www.tel-aviv.gov.il/Residents/Arnona/Pages/ArnonaSwitching.aspx',
    'הזדהות תעודת זהות מספר משלם ארנונה'
  );
  const analysis = analyzePaymentProviderBoundary({
    providerSummary,
    intentText: 'arnona payment',
    evidence: {
      requests: [{ url: 'https://www.tel-aviv.gov.il/Residents/Arnona/Pages/ArnonaSwitching.aspx', method: 'GET', headers: { accept: 'text/html' } }],
      responses: [{ url: 'https://www.tel-aviv.gov.il/Residents/Arnona/Pages/ArnonaSwitching.aspx', status: 200, headers: { 'content-type': 'text/html' }, bodyPreview: '<html>arnona</html>' }],
      cookies: [{ name: 'ASP.NET_SessionId' }],
      domSnapshotPreview: 'Arnona switching page',
    },
  });

  assert.equal(analysis.adapter.id, 'tel-aviv-internal-boundary');
  assert.equal(analysis.evidenceSummary.requestCount, 1);
  assert.equal(analysis.evidenceSummary.responseCount, 1);
  assert.equal(analysis.evidenceSummary.cookies.count, 1);
});

test('extractToken and handoff normalization preserve Tel Aviv redirect evidence', () => {
  const token = extractToken('https://provider.example/checkout?paymentToken=abc123xyz');
  const normalized = normalizeManualPaymentBoundaryEvidence({
    paymentUrl: 'https://www.tel-aviv.gov.il/About/Pages/Payments.aspx',
    handoff: {
      url: 'https://provider.example/checkout?paymentToken=abc123xyz',
      sourceUrl: 'https://www5.tel-aviv.gov.il/TlvForms/TlvQueueReservation/default.aspx',
      headers: { referer: 'https://www5.tel-aviv.gov.il/TlvForms/TlvQueueReservation/default.aspx' },
      redirectChain: [
        'https://www5.tel-aviv.gov.il/TlvForms/TlvQueueReservation/default.aspx',
        'https://provider.example/checkout?paymentToken=abc123xyz',
      ],
      selectorFingerprints: ['#ctl00_MainContent_btnPay'],
      version: 'handoff-v1',
    },
  });

  assert.equal(token, 'abc123xyz');
  assert.equal(normalized.handoff.token, 'abc123xyz');
  assert.equal(normalized.handoff.version, 'handoff-v1');
});

test('analyzePaymentProviderBoundary builds the Tel Aviv redirect adapter from real handoff evidence', () => {
  const normalized = normalizeManualPaymentBoundaryEvidence({
    paymentUrl: 'https://www.tel-aviv.gov.il/About/Pages/Payments.aspx',
    intentText: 'arnona payment',
    handoff: {
      url: 'https://provider.example/checkout?paymentToken=abc123xyz',
      sourceUrl: 'https://www5.tel-aviv.gov.il/TlvForms/TlvQueueReservation/default.aspx',
      headers: { referer: 'https://www5.tel-aviv.gov.il/TlvForms/TlvQueueReservation/default.aspx' },
      redirectChain: [
        'https://www5.tel-aviv.gov.il/TlvForms/TlvQueueReservation/default.aspx',
        'https://provider.example/checkout?paymentToken=abc123xyz',
      ],
      selectorFingerprints: ['#ctl00_MainContent_btnPay'],
      version: 'handoff-v1',
    },
    evidence: {
      requests: [{ url: 'https://provider.example/checkout?paymentToken=abc123xyz', method: 'GET', headers: { referer: 'https://www5.tel-aviv.gov.il/TlvForms/TlvQueueReservation/default.aspx' } }],
      responses: [{ url: 'https://provider.example/checkout?paymentToken=abc123xyz', status: 200, headers: { 'content-type': 'text/html' } }],
      cookies: [{ name: 'checkout-session' }],
    },
  });
  const analysis = analyzePaymentProviderBoundary({
    providerSummary: normalized.paymentProvider,
    evidence: normalized.evidence,
    intentText: normalized.intentText,
    handoff: normalized.handoff,
  });
  const summary = buildPaymentBoundaryUiSummary({
    ...normalized,
    adapter: analysis.adapter,
    adapterAnalysis: analysis,
  });

  assert.equal(analysis.adapter.id, 'tel-aviv-redirect-handoff');
  assert.equal(analysis.handoff.paymentUrl, 'https://provider.example/checkout?paymentToken=abc123xyz');
  assert.equal(analysis.handoff.token, 'abc123xyz');
  assert.equal(analysis.validation.isValid, true);
  assert.equal(summary.handoffToken, 'abc123xyz');
  assert.equal(summary.adapterVersion, 'tel-aviv-redirect-v1');
});

test('buildPaymentBoundaryUiSummary exposes compact counts for the frontend payment panel', () => {
  const summary = buildPaymentBoundaryUiSummary({
    paymentProvider: {
      provider: 'meshulam',
      host: 'secure.meshulam.co.il',
      handoffDetected: true,
      irreversibleBoundaryDetected: true,
      loginRequired: false,
    },
    adapter: {
      id: 'meshulam-payment-provider',
      label: 'Meshulam Provider',
    },
    evidence: {
      requests: [{}, {}],
      responses: [{}],
      cookies: [{}, {}, {}],
    },
  });

  assert.equal(summary.provider, 'meshulam');
  assert.equal(summary.adapterId, 'meshulam-payment-provider');
  assert.equal(summary.requestCount, 2);
  assert.equal(summary.responseCount, 1);
  assert.equal(summary.cookieCount, 3);
  assert.equal(summary.handoffDetected, true);
});

test('inferApplicantBinding resolves stored values to applicant and extra-field bindings', () => {
  const applicant = {
    fullName: 'Dana Levi',
    phone: '0501234567',
    extraFields: {
      propertyId: 'ARN-4455',
    },
  };

  assert.equal(inferApplicantBinding('Dana Levi', applicant), 'fullName');
  assert.equal(inferApplicantBinding('ARN-4455', applicant), 'extraFields.propertyId');
  assert.equal(resolveApplicantBindingValue('extraFields.propertyId', applicant), 'ARN-4455');
});

test('buildAttendedActionRecord stores binding metadata without keeping sensitive values in clear text', () => {
  const applicant = {
    fullName: 'Dana Levi',
    loginPassword: 'super-secret',
  };
  const safeRecord = buildAttendedActionRecord({
    eventType: 'change',
    pageUrl: 'https://www.tel-aviv.gov.il/Contact/Pages/Appointments.aspx',
    label: 'שם מלא',
    value: 'Dana Levi',
    selectorCandidates: ['#full_name'],
  }, applicant);
  const sensitiveRecord = buildAttendedActionRecord({
    eventType: 'change',
    pageUrl: 'https://login.example.invalid/',
    label: 'Password',
    inputType: 'password',
    value: 'super-secret',
    selectorCandidates: ['#password'],
  }, applicant);

  assert.equal(safeRecord.valueBinding, 'fullName');
  assert.equal(safeRecord.valuePreview, 'Dana Levi');
  assert.equal(sensitiveRecord.sensitive, true);
  assert.notEqual(sensitiveRecord.valuePreview, 'super-secret');
});

test('scoreReplayRecordForPage prefers learned actions from structurally similar pages', () => {
  const strongScore = scoreReplayRecordForPage({
    pagePath: '/Residents/Arnona/Pages/ArnonaSwitching.aspx',
    pageTitle: 'חילופי מחזיקים בארנונה',
    structuralTerms: ['arnona', 'holders', 'payment'],
    observedCount: 3,
    replaySuccessCount: 2,
    replayFailureCount: 0,
  }, {
    pagePath: '/Residents/Arnona/Pages/ArnonaSwitching.aspx',
    pageTitle: 'חילופי מחזיקים בארנונה',
    pageTerms: ['arnona', 'holders', 'municipal'],
  });
  const weakScore = scoreReplayRecordForPage({
    pagePath: '/Residents/Parking/Pages/Fines.aspx',
    pageTitle: 'Parking fines',
    structuralTerms: ['parking', 'fine'],
    observedCount: 1,
    replaySuccessCount: 0,
    replayFailureCount: 2,
  }, {
    pagePath: '/Residents/Arnona/Pages/ArnonaSwitching.aspx',
    pageTitle: 'חילופי מחזיקים בארנונה',
    pageTerms: ['arnona', 'holders', 'municipal'],
  });

  assert.ok(strongScore > weakScore);
});

test('scoreFieldForRecordedInput prefers analogous fields over unrelated fields', () => {
  const record = {
    name: 'property_id',
    label: 'Property ID',
    placeholder: 'Enter property id',
    inputType: 'text',
  };
  const matchingField = scoreFieldForRecordedInput({
    id: 'property_identifier',
    name: 'property_id',
    placeholder: 'Enter property id',
    ariaLabel: 'Property ID',
    label: 'Property ID',
    type: 'text',
  }, record);
  const unrelatedField = scoreFieldForRecordedInput({
    id: 'email',
    name: 'email',
    placeholder: 'Email',
    ariaLabel: 'Email',
    label: 'Email',
    type: 'email',
  }, record);

  assert.ok(matchingField > unrelatedField);
});

test('buildDomVersion stays stable for equivalent form structure despite selector churn', () => {
  const baseVersion = buildDomVersion({
    pageUrl: 'https://www5.tel-aviv.gov.il/TlvForms/TlvQueueReservation/default.aspx',
    pageTitle: 'Queue reservation - identification',
    tag: 'input',
    inputType: 'text',
    role: 'textbox',
    formAction: '/TlvForms/TlvQueueReservation/default.aspx',
    structuralTerms: ['customer', 'identity', 'phone'],
  });
  const changedDomVersion = buildDomVersion({
    pageUrl: 'https://www5.tel-aviv.gov.il/TlvForms/TlvQueueReservation/default.aspx?step=1',
    pageTitle: 'Queue reservation - identification',
    tag: 'input',
    inputType: 'text',
    role: 'textbox',
    formAction: '/TlvForms/TlvQueueReservation/default.aspx',
    structuralTerms: ['customer', 'identity', 'phone'],
    domPath: 'form > div:nth-child(3) > input',
  });

  assert.equal(baseVersion, changedDomVersion);
});

test('mergeAttendedSessionLearning merges structurally similar actions under one learned entry', () => {
  const host = 'www5.tel-aviv.gov.il';
  const firstRecord = buildAttendedActionRecord({
    eventType: 'click',
    pageUrl: 'https://www5.tel-aviv.gov.il/TlvForms/TlvQueueReservation/default.aspx',
    pageTitle: 'Queue reservation - identification',
    tag: 'button',
    text: 'Continue',
    label: 'Continue',
    role: 'button',
    structuralTerms: ['queue', 'reservation', 'continue'],
    selectorCandidates: ['#continue-btn'],
  });
  const shiftedRecord = buildAttendedActionRecord({
    eventType: 'click',
    pageUrl: 'https://www5.tel-aviv.gov.il/TlvForms/TlvQueueReservation/default.aspx?from=resume',
    pageTitle: 'Queue reservation - identification',
    tag: 'button',
    text: 'Continue now',
    label: 'Continue',
    role: 'button',
    structuralTerms: ['queue', 'reservation', 'continue'],
    selectorCandidates: ['.wizard-continue'],
  });

  const merged = mergeAttendedSessionLearning({}, { host, actionRecords: [firstRecord, shiftedRecord] });
  const learned = listLearnedActionsForHost(merged, host, { eventType: 'click' });

  assert.equal(learned.length, 1);
  assert.equal(learned[0].observedCount, 2);
  assert.ok(learned[0].selectorCandidates.includes('#continue-btn'));
  assert.ok(learned[0].selectorCandidates.includes('.wizard-continue'));
});

test('markReplayResult promotes selectors that succeed and records replay confidence', () => {
  const host = 'www5.tel-aviv.gov.il';
  const record = buildAttendedActionRecord({
    eventType: 'click',
    pageUrl: 'https://www5.tel-aviv.gov.il/TlvForms/TlvQueueReservation/default.aspx?step=2',
    pageTitle: 'Appointment diary',
    tag: 'button',
    text: 'Approve appointment',
    label: 'Approve appointment',
    role: 'button',
    selectorCandidates: ['.approve-btn', '#approve-btn'],
  });

  let store = mergeAttendedSessionLearning({}, { host, actionRecords: [record] });
  store = markReplayResult(store, { host, record, ok: false, selector: '.approve-btn', mode: 'provided-selector', failureReason: 'missing-element' });
  store = markReplayResult(store, { host, record, ok: true, selector: '#approve-btn', mode: 'provided-selector' });
  const learned = listLearnedActionsForHost(store, host, { eventType: 'click' });

  assert.equal(learned.length, 1);
  assert.equal(learned[0].prioritizedSelectorCandidates[0], '#approve-btn');
  assert.ok(learned[0].replayConfidence > 0.2);
  assert.equal(learned[0].recentFailures.length, 1);
});

test('listLearnedActionsForHost favors stronger success rate in learned action ranking', () => {
  const host = 'www5.tel-aviv.gov.il';
  const highPrecision = buildAttendedActionRecord({
    eventType: 'click',
    pageUrl: 'https://www5.tel-aviv.gov.il/TlvForms/TlvQueueReservation/default.aspx?step=2',
    pageTitle: 'Appointment diary',
    tag: 'button',
    text: 'Continue to review',
    label: 'Continue to review',
    role: 'button',
    selectorCandidates: ['#continue-review'],
  });
  const noisyCandidate = buildAttendedActionRecord({
    eventType: 'click',
    pageUrl: 'https://www5.tel-aviv.gov.il/TlvForms/TlvQueueReservation/default.aspx?step=2',
    pageTitle: 'Appointment diary',
    tag: 'button',
    text: 'Open help',
    label: 'Open help',
    role: 'button',
    selectorCandidates: ['#open-help'],
  });

  let store = mergeAttendedSessionLearning({}, { host, actionRecords: [highPrecision, noisyCandidate] });
  store = markReplayResult(store, { host, record: highPrecision, ok: true, selector: '#continue-review', mode: 'provided-selector' });
  store = markReplayResult(store, { host, record: highPrecision, ok: true, selector: '#continue-review', mode: 'provided-selector' });
  store = markReplayResult(store, { host, record: highPrecision, ok: true, selector: '#continue-review', mode: 'provided-selector' });
  store = markReplayResult(store, { host, record: noisyCandidate, ok: true, selector: '#open-help', mode: 'provided-selector' });
  store = markReplayResult(store, { host, record: noisyCandidate, ok: false, selector: '#open-help', mode: 'provided-selector', failureReason: 'not-clickable' });
  store = markReplayResult(store, { host, record: noisyCandidate, ok: false, selector: '#open-help', mode: 'provided-selector', failureReason: 'hidden' });
  store = markReplayResult(store, { host, record: noisyCandidate, ok: false, selector: '#open-help', mode: 'provided-selector', failureReason: 'covered' });

  const learned = listLearnedActionsForHost(store, host, { eventType: 'click' });

  assert.equal(learned[0].label, 'Continue to review');
  assert.ok(learned[0].successRate > learned[1].successRate);
});

test('official appointment API config requires auth and normalizes legacy public booking URL typo', async () => {
  await withEnv({
    TEL_AVIV_APPOINTMENT_API_BASE_URL: 'https://api.example.invalid/',
    TEL_AVIV_APPOINTMENT_API_KEY: null,
    TEL_AVIV_APPOINTMENT_API_BEARER_TOKEN: null,
    TEL_AVIV_APPOINTMENT_API_ALLOW_INSECURE_TLS: 'yes',
    TEL_AVIV_APPOINTMENT_PUBLIC_URL: 'https://www.tel-aviv.gov.il/Contact/Pages/Apointments.aspx',
  }, async () => {
    const config = getTelAvivOfficialAppointmentApiConfig();

    assert.equal(config.configured, false);
    assert.equal(config.allowInsecureTls, true);
    assert.equal(config.publicBookingUrl, 'https://www.tel-aviv.gov.il/Contact/Pages/Appointments.aspx');
  });

  await withEnv({
    TEL_AVIV_APPOINTMENT_API_BASE_URL: 'https://api.example.invalid/',
    TEL_AVIV_APPOINTMENT_API_BEARER_TOKEN: 'token-123',
  }, async () => {
    const config = getTelAvivOfficialAppointmentApiConfig();
    assert.equal(config.configured, true);
  });

  const requestScopedConfig = getTelAvivOfficialAppointmentApiConfig({
    baseUrl: 'https://request.example.invalid',
    bearerToken: 'request-token',
    publicBookingUrl: 'https://www.tel-aviv.gov.il/Contact/Pages/Apointments.aspx',
  });
  assert.equal(requestScopedConfig.configured, true);
  assert.equal(requestScopedConfig.configScope, 'request');
  assert.equal(requestScopedConfig.publicBookingUrl, 'https://www.tel-aviv.gov.il/Contact/Pages/Appointments.aspx');
});

test('normalizeCreateUrl rejects non-http base URLs and buildRequestBody emits validated ISO payloads', () => {
  assert.equal(normalizeCreateUrl('ftp://api.example.invalid', '/appointments'), '');

  const body = buildRequestBody({
    userId: 0,
    description: '  Arnona appointment  ',
    notes: false,
    category: 'arnona',
  });

  assert.equal(body.userId, '0');
  assert.equal(body.requester.userId, '0');
  assert.equal(body.description, 'Arnona appointment');
  assert.equal(body.notes, 'false');
  assert.match(body.createdAtIso, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(body.createdAt, body.createdAtIso);
  assert.equal(body.requestedAtIso, body.createdAtIso);
});

test('scheduleTelAvivAppointmentOfficial preserves 0 ids, honors explicit confirmed=false, and never mutates global TLS env', async () => {
  await withEnv({
    TEL_AVIV_APPOINTMENT_API_BASE_URL: 'https://api.example.invalid',
    TEL_AVIV_APPOINTMENT_API_BEARER_TOKEN: 'token-123',
    TEL_AVIV_APPOINTMENT_API_ALLOW_INSECURE_TLS: null,
  }, async () => {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    await withFetchMock(async (_url, options) => {
      const parsedBody = JSON.parse(options.body);
      assert.equal(parsedBody.userId, '0');
      assert.equal(parsedBody.requester.userId, '0');
      assert.equal(parsedBody.description, 'Arnona booking');
      assert.match(parsedBody.createdAtIso, /^\d{4}-\d{2}-\d{2}T/);

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            bookingId: 0,
            confirmed: false,
            status: 'booked',
          });
        },
      };
    }, async () => {
      const result = await scheduleTelAvivAppointmentOfficial({
        userId: 0,
        description: 'Arnona booking',
        notes: false,
        category: 'arnona',
      });

      assert.equal(result.appointment.externalRequestId, 0);
      assert.equal(result.appointment.confirmed, false);
      assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
    });
  });
});

test('scheduleTelAvivAppointmentOfficial supports request-scoped config and isolated insecure TLS without touching process globals', async () => {
  const originalRequest = https.request;
  let capturedRejectUnauthorized = null;

  https.request = (url, options, callback) => {
    capturedRejectUnauthorized = options.rejectUnauthorized;
    const response = new PassThrough();
    response.statusCode = 200;
    response.statusMessage = 'OK';

    const listeners = new Map();
    const request = {
      on(eventName, handler) {
        listeners.set(eventName, handler);
        return request;
      },
      write() {
      },
      end() {
        process.nextTick(() => {
          callback(response);
          response.end(JSON.stringify({ appointmentId: 'req-123', confirmed: 'yes', status: 'confirmed' }));
        });
      },
      destroy(error) {
        const handler = listeners.get('error');
        if (handler && error) handler(error);
      },
    };
    return request;
  };

  try {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const result = await scheduleTelAvivAppointmentOfficial({
      description: 'Arnona booking',
      officialApiConfig: {
        baseUrl: 'https://api.example.invalid',
        apiKey: 'key-123',
        allowInsecureTls: true,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.transport, 'isolated-insecure-tls-agent');
    assert.equal(result.configScope, 'request');
    assert.equal(result.appointment.confirmed, true);
    assert.equal(capturedRejectUnauthorized, false);
    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  } finally {
    https.request = originalRequest;
  }
});