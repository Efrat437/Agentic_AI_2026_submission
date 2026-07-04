-- 15_query_log_compat.sql
-- Compatibility layer for consumers expecting a minimal query_log shape.
-- Keeps the rich audit table intact and exposes a stable, simple projection.

CREATE OR REPLACE VIEW vw_query_log_simple AS
SELECT
  id,
  actor_user_id AS user_id,
  agent_name AS agent_type,
  sql_text AS query,
  created_at
FROM query_log;
