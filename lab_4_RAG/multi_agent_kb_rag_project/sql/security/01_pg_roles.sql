-- 01_pg_roles.sql
-- PostgreSQL DB-level roles for defense-in-depth pool routing.
-- Run with a privileged user (owner / superuser).
--
--  ai_read_user    → SELECT on graph entities + memories (readPool)
--  ai_write_user   → SELECT + INSERT + UPDATE on operational tables (writePool)
--  ai_stats_user   → SELECT on all tables for aggregations (statisticsPool)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_read_user') THEN
    CREATE ROLE ai_read_user LOGIN PASSWORD 'ai_read_change_me';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_write_user') THEN
    CREATE ROLE ai_write_user LOGIN PASSWORD 'ai_write_change_me';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_stats_user') THEN
    CREATE ROLE ai_stats_user LOGIN PASSWORD 'ai_stats_change_me';
  END IF;
END $$;

GRANT CONNECT ON DATABASE sso_db TO ai_read_user, ai_write_user, ai_stats_user;
GRANT USAGE ON SCHEMA public TO ai_read_user, ai_write_user, ai_stats_user;

-- ─── READ pool (ai_read_user) ────────────────────────────────────────────────
-- Core graph entities
GRANT SELECT ON TABLE nodes, relationships, attributes, memories TO ai_read_user;
-- App-level user/permission lookup (getUserPermissions in access_control_repository.js)
GRANT SELECT ON TABLE users, permissions, user_permissions, allowed_tables, resources_booking TO ai_read_user;
-- Secure-agent role and permission lookup (getUserPermissions in secure_sql_orchestrator.js)
GRANT SELECT ON TABLE secure_roles, secure_users, secure_role_permissions, secure_agent_permissions TO ai_read_user;

-- ─── WRITE pool (ai_write_user) ──────────────────────────────────────────────
-- Core operational tables
GRANT SELECT, INSERT, UPDATE ON TABLE actions, government_requests, memories TO ai_write_user;
GRANT SELECT ON TABLE nodes, relationships, attributes TO ai_write_user;
-- App-level CRUD: user management, audit, booking (access_control_repository.js)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  users, user_permissions, query_log, audit_login, resources_booking TO ai_write_user;
GRANT SELECT ON TABLE permissions, allowed_tables TO ai_write_user;
-- Secure-agent audit + bootstrap (secure_sql_orchestrator.js)
GRANT SELECT, INSERT, UPDATE ON TABLE
  secure_query_logs, secure_agent_permissions, secure_users,
  secure_roles, secure_role_permissions TO ai_write_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ai_write_user;

-- ─── STATISTICS pool (ai_stats_user) ─────────────────────────────────────────
-- Core graph + operational aggregation
GRANT SELECT ON TABLE memories, government_requests, actions, nodes, relationships, attributes TO ai_stats_user;
-- Security analytics and audit views
GRANT SELECT ON TABLE
  query_log, audit_login, resources_booking,
  secure_query_logs, secure_roles, secure_users,
  secure_role_permissions, secure_agent_permissions TO ai_stats_user;

-- ─── Default privileges for tables/sequences created in the future ────────────
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO ai_read_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO ai_stats_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO ai_write_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ai_write_user;
