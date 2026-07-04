-- 11_query_log.sql
-- Full SQL execution audit per request: user, agent, pool, SQL text, success/failure.
-- Uses gen_random_uuid() from pgcrypto (created in 07_users.sql).
-- Depends on: 07_users.sql

CREATE TABLE IF NOT EXISTS query_log (
  id            BIGSERIAL   PRIMARY KEY,
  request_id    UUID        NOT NULL DEFAULT gen_random_uuid(),
  actor_user_id BIGINT      REFERENCES users (id) ON DELETE SET NULL,
  actor_username TEXT,
  agent_name    TEXT,
  route_name    TEXT,
  sql_text      TEXT        NOT NULL,
  sql_command   TEXT        NOT NULL,
  pool_name     TEXT        NOT NULL
                            CHECK (pool_name IN ('read', 'write', 'statistics')),
  success       BOOLEAN     NOT NULL,
  row_count     INTEGER,
  duration_ms   INTEGER,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_query_log_created_at    ON query_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_log_actor_user_id ON query_log (actor_user_id);
CREATE INDEX IF NOT EXISTS idx_query_log_route_name    ON query_log (route_name);
CREATE INDEX IF NOT EXISTS idx_query_log_pool_name     ON query_log (pool_name);
