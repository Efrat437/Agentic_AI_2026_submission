# Insurance Rules

1. Index the example rules in RAG process.
2. Write UI that can fits the rules to create new rules
3. before creating the rule - check if the rule already exist.
4. show the related rules, Exact_Match, High_Sevirity_Match, Low_Sevirity_Match,
   Duplicated_Add_to_list
5. Server - node.js / Python - langchain/langgraph
6. React client - or any other client ( HTML , JS)
7. DB - pgvector
8. Wrap it in docker
9. Save in Github, docker-compose.yml to run it.
10. Share with me galamouyal88@gmail.com
11. the output should be suggested similar rules with the relevant tag from item 4
12. index each rule seperatedly 
13. if creating new rule - index it

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
