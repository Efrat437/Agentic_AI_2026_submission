# AI Rule Intelligence Platform

Production-ready assignment solution for insurance rule intelligence with:

- Dedicated frontend (fields/operators/values)
- FastAPI backend
- LangGraph orchestrator
- MCP-style embedding service using Xenova open-source model
- pgvector/PostgreSQL vector store
- Offline indexing + online retrieval/rerank/reasoning
- Docker Compose end-to-end runtime

## Architecture

Frontend -> FastAPI -> LangGraph

LangGraph pipeline:
1. Parse + normalize rule text
2. Extract metadata fields and canonical hash
3. Embed query using Xenova embedding server
4. Vector retrieval (`k=30` by default)
5. Metadata filtering (`country`, `insurance_type`, `active`) + threshold
6. Cross-encoder rerank
7. Hierarchical rule resolution (priority + specificity scoring)
8. Rule relationship analyzer (`exact_duplicate`, `high_similarity`, `contained_by`, `contains_existing`, `contradiction`, `complements`, `different_context`, `new_rule`)
9. LLM/logic recommendation (approve/reject/revise) over top-N
10. Structured JSON response
11. HITL routing when `0.65 < similarity < 0.8`

Four retrieval layers explicitly tracked in response (`retrieval_layers`):

- vector_retrieval
- metadata_filtered
- hierarchical_resolution
- conflict_engine

## Relationship tags

- `exact_duplicate`
- `high_similarity`
- `contained_by`
- `contains_existing`
- `contradiction`
- `complements`
- `different_context`
- `new_rule`

## Production characteristics

- Canonical hashing to avoid duplicate indexing
- Offline indexing job API
- Realtime ingestion on approved/revised new rules
- Metadata filtering (`fields && query_fields`) before vector ranking
- Thresholded retrieval to avoid noisy LLM calls
- Optional LLM fallback to deterministic engine if API key missing
- Smart rule identity fields: `rule_id`, `parent_rule`, `priority`, `version`
- Smart structured rule id format: `INS.AUTO.ISR.AGE.UNDER_24.001` style
- Validation for malformed/contradictory in-rule conditions
- Retry policy for embedding calls and orchestration invoke
- HITL review task creation for mid-similarity cases
- Controlled merge endpoint for human-approved auto-union

## Run

```bash
cd _Task_/ai_rule_intelligence_platform
docker compose up -d --build
```

### 1) Offline index the assignment corpus

```bash
curl -X POST http://localhost:8000/api/index/offline
```

### 2) Open UI

- http://localhost:8080

### 3) Analyze a rule directly

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

```bash
curl -X POST http://localhost:8000/api/rules/analyze \
  -H "content-type: application/json" \
  -d '{"rule_text":"if driver_country is israel then increase_premium","should_create":false}'
```

### 4) Human-approved merge endpoint

```bash
curl -X POST http://localhost:8000/api/rules/merge/approved \
  -H "content-type: application/json" \
  -d '{"source_rule_id":"INS.AUTO.ISR.AGE.UNDER_24.001","merged_rule_text":"if driver_country is israel and driver_age in_range [18,24] then increase_premium","reviewer":"underwriter_01"}'
```

## Data source

Seed data copied from assignment folder:

- `seed/insurance_rules_dummy_100.jsonl`
- `seed/lists/*.json`

## Notes

- Retrieval uses pgvector cosine similarity.
- Cross-encoder reranker defaults to `cross-encoder/ms-marco-MiniLM-L-6-v2`.
- You can add OpenAI-compatible key in backend env for LLM decisioning.
