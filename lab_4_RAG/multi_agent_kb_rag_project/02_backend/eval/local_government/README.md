# Local Government Validation Index

This folder centralizes booking-validation outputs.

## Why this was not visible before

`02_backend/eval/` previously held RAG evaluation assets only. The booking validations were split across:

- scripts under `02_backend/scripts/`
- regression tests under `02_backend/tests/local_government/`
- ad hoc runtime artifacts under `tmp/`

The files below make the booking validations visible in one place.

## Validation entry points

- Mock validation: `npm run local-gov:validate:mock`
  - Script: `02_backend/scripts/run_local_gov_mock_booking_validation.js`
  - Output: `02_backend/eval/local_government/mock-booking-validation-report.json`
  - Event log: `02_backend/eval/local_government/mock-booking-validation-log.jsonl`

- Local DB-backed assignment validation: `npm run local-gov:validate:db-assignment`
  - Script: `02_backend/scripts/run_local_gov_db_assignment_validation.js`
  - Output: `02_backend/eval/local_government/local-booking-db-validation.json`

- Circuit breaker threshold/cooldown validation: `npm run local-gov:validate:circuit-breaker`
  - Script: `02_backend/scripts/run_local_gov_circuit_breaker_validation.js`
  - Output: `02_backend/eval/local_government/circuit-breaker-validation.json`

- Open public API validation: `npm run local-gov:validate:public-api`
  - Script: `02_backend/scripts/run_public_booking_api_validation.js`
  - Output: `02_backend/eval/local_government/public-booking-api-validation.json`

- Real public site evaluation, dry-run only: `npm run local-gov:validate:ganey-tikva`
  - Script: `02_backend/scripts/run_ganey_tikva_eval.js`
  - Output: `02_backend/eval/local_government/ganey-tikva-browser-eval.json`

- Tel Aviv booking page evaluation, dry-run only: `npm run local-gov:validate:tel-aviv-booking`
  - Script: `02_backend/scripts/run_tel_aviv_booking_eval.js`
  - Output: `02_backend/eval/local_government/tel-aviv-booking-browser-eval.json`

- Tel Aviv booking progression with autonomous steps plus human fallback: `npm run local-gov:validate:tel-aviv-booking-hitl`
  - Script: `02_backend/scripts/run_tel_aviv_booking_hitl.js`
  - Output: `02_backend/eval/local_government/tel-aviv-booking-hitl-eval.json`

- Tel Aviv payments page discovery evaluation: `npm run local-gov:validate:tel-aviv-payments`
  - Script: `02_backend/scripts/run_tel_aviv_payments_eval.js`
  - Output: `02_backend/eval/local_government/tel-aviv-payments-discovery-eval.json`

- Tel Aviv payments boundary preparation, stopping before credentials or irreversible payment: `npm run local-gov:validate:tel-aviv-payments-boundary`
  - Script: `02_backend/scripts/run_tel_aviv_payments_boundary.js`
  - Output: `02_backend/eval/local_government/tel-aviv-payments-boundary-eval.json`

## Regression coverage

- `02_backend/tests/local_government/booking_workflow.test.js`
- `02_backend/tests/local_government/discovery_and_browser_scoring.test.js`
- `02_backend/tests/local_government/mock_booking_e2e.test.js`

## Legacy ad hoc artifacts

- `tmp/ganey_browser_eval.json`
- `tmp/ganey_hitl_eval.json`
- `tmp/mock-booking-validation-report.after-retry-tuning.json`

## Notes

- The mock validator now logs per-run events in addition to the summary JSON.
- The mock validator now records self-learning and circuit-breaker metrics per run.
- The DB-backed validation explicitly exercises table creation and writes for `memories`, `actions`, and `government_requests`, and verifies self-extending-agent incremental persistence into `government_requests`.
- The DB-backed validation now also records multiple intermediate `government_requests.updated_at` transitions during one self-extending run and asserts that incremental step-by-step updates occurred.
- The remaining mock false-positive issue was addressed at the protocol level by adding reservation tokens for atomic slot claims in the mock server.
- The real-site Ganey Tikva script remains evaluation-only and does not submit the form.
- The Tel Aviv booking browser agent now adds page-specific wizard advancement before generic form detection, which improves progression from the public appointments landing page toward the actual booking flow.
- Human-provided booking credentials and applicant profile fields are now persisted together locally so later autonomous or attended runs can reuse them without repeatedly asking for the same details.
- The payments boundary helper is intentionally non-destructive: it can advance toward the relevant payment branch, but it stops before payer identifiers, card details, or final confirmation.

## Project-wide Architecture Note

This project uses a dual-graph architecture that couples LangGraph-based multi-agent orchestration with a graph-native RAG knowledge layer built from real governmental sources. The knowledge model is represented as Nodes, Relationships, and Attributes, which supports multi-hop reasoning across structured SQL data, PDFs, cleaned municipal HTML content, and semantic retrieval outputs. Agents do not stop at answer generation: they select tools through policy-aware orchestration, execute permission-scoped actions through MCP boundaries, and can move from retrieval to operational workflows such as service discovery, dynamic booking-site navigation, and appointment flow execution. By integrating a standalone RAG platform with an autonomous Government Booking platform through the RAG-Booking Booster layer, the system improves robustness, observability, and maintainability while extending RAG from passive retrieval into executable, real-world decision and task workflows.

## Shared Run Scripts

### 1) RAG Process with LangGraph Retrieval (SQL/XLSX Data)

Source package: `lab_4_RAG/multi_agent_kb_rag_project/package.json`

1. `pipeline:bootstrap`
  - `node ./scripts/check_env_and_ports.js && node wait-for-db.js && node ./scripts/run_create_tables_docker.js && npm run security:init && npm run db:create-tables && npm run db:ensure-sql-tables && npm run db:load-data && npm run db:embed`
2. `pipeline:ingest-sql-to-rag`
  - `node ./scripts/check_env_and_ports.js && node ./02_backend/scripts/ingest_sql_to_rag.js && npm run sql:index-04-data-embeddings`
3. `backend:start:with-timeouts`
  - `set PORTS_TO_CHECK=3100,4100&& node ./scripts/check_env_and_ports.js && set PORT=3100&& set APP_HOST=127.0.0.1&& set MCP_PORT=4100&& node ./02_backend/scripts/start_backend_with_timeouts.js`
4. `frontend:start:for-local-backend`
  - `set PORTS_TO_CHECK=5173&& node ./scripts/check_env_and_ports.js && set BACKEND_BASE_URL=http://127.0.0.1:3100&& node ./02_backend/scripts/start_ui_for_local_backend.js`

### 2) RAG Process (PDF Files)

Source package: `lab_4_RAG/RAG_PROJECT/package.json`

1. `server:start:local-hybrid`
  - `set SKIP_SEMANTIC_HANDOFF=true&& node ./04_server/server.js`
2. `ui:open`
  - `powershell -NoProfile -Command "Start-Process http://127.0.0.1:3000"`

### 3) Making Operations (Government Booking)

Fresh machine / first run recommendation:

1. `npm run pipeline:bootstrap`
2. `npm run pipeline:ingest-sql-to-rag`

Then run either:

1. `npm run local-gov:autonomous:polling:ganey:visible:trace:hitl`

Or this quick path:

1. `npm run pipeline:ingest-html-booking-rag:fast`
2. `npm run backend:start:with-timeouts`
3. `npm run frontend:start:for-local-backend`

### 4) RAG-Booking Booster Platform

Fresh machine / first run recommendation: run `pipeline:bootstrap`, then `pipeline:ingest-sql-to-rag`.

HTML-only quick booster: run `pipeline:ingest-html-booking-rag:fast` directly.

Main run order:

1. `npm run pipeline:ingest-html-booking-rag:multi` or `npm run pipeline:ingest-html-booking-rag:fast`
2. `npm run backend:start:with-timeouts`
3. `npm run frontend:start:for-local-backend`

## Project Goal

Enable each platform (RAG and Booking) to operate independently while also allowing the Booking platform to leverage the RAG platform to improve and optimize appointment-booking workflows.
