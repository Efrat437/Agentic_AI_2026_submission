-- 06_secure_query_logs.sql
-- Audit log for every secure-agent SQL execution:
-- guard decision, pool used, params, row count.

CREATE TABLE IF NOT EXISTS secure_query_logs (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT,
  role_name     TEXT,
  agent_name    TEXT,
  pool_name     TEXT,
  query_type    TEXT,
  sql_text      TEXT,
  sql_params    JSONB,
  guard_allowed BOOLEAN,
  guard_reason  TEXT,
  row_count     INT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_secure_query_logs_created_at
  ON secure_query_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_secure_query_logs_user_id
  ON secure_query_logs (user_id);

CREATE INDEX IF NOT EXISTS idx_secure_query_logs_agent
  ON secure_query_logs (agent_name);

CREATE INDEX IF NOT EXISTS idx_secure_query_logs_guard
  ON secure_query_logs (guard_allowed, created_at DESC);
