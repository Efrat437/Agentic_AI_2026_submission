-- defense_in_depth_security.sql
-- Defense-in-depth PostgreSQL role/users setup for secure AI agent routing.
-- Run with a privileged DB user (owner/superuser).

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

-- READ pool: graph-like entities + read-safe visibility
-- READ pool: graph-like entities + read-safe visibility
GRANT SELECT ON TABLE nodes, relationships, attributes, memories TO ai_read_user;
-- App-level user/permission lookup (access_control_repository.js)
GRANT SELECT ON TABLE users, permissions, user_permissions, allowed_tables, resources_booking TO ai_read_user;
-- Secure-agent role lookup (secure_sql_orchestrator.js)
GRANT SELECT ON TABLE secure_roles, secure_users, secure_role_permissions, secure_agent_permissions TO ai_read_user;

-- WRITE pool: operational actions and booking lifecycle
GRANT SELECT, INSERT, UPDATE ON TABLE actions, government_requests, memories TO ai_write_user;
GRANT SELECT ON TABLE nodes, relationships, attributes TO ai_write_user;
-- App-level CRUD (access_control_repository.js)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  users, user_permissions, query_log, audit_login, resources_booking TO ai_write_user;
GRANT SELECT ON TABLE permissions, allowed_tables TO ai_write_user;
-- Secure-agent audit and bootstrap (secure_sql_orchestrator.js)
GRANT SELECT, INSERT, UPDATE ON TABLE
  secure_query_logs, secure_agent_permissions, secure_users,
  secure_roles, secure_role_permissions TO ai_write_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ai_write_user;

-- STATISTICS pool: aggregations on core + security audit tables
GRANT SELECT ON TABLE memories, government_requests, actions, nodes, relationships, attributes TO ai_stats_user;
GRANT SELECT ON TABLE
  query_log, audit_login, resources_booking,
  secure_query_logs, secure_roles, secure_users,
  secure_role_permissions, secure_agent_permissions TO ai_stats_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO ai_read_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO ai_stats_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO ai_write_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ai_write_user;

-- App-level authorization tables
CREATE TABLE IF NOT EXISTS secure_roles (
  role_name TEXT PRIMARY KEY,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS secure_users (
  user_id TEXT PRIMARY KEY,
  role_name TEXT NOT NULL REFERENCES secure_roles(role_name) ON UPDATE CASCADE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS secure_role_permissions (
  role_name TEXT NOT NULL REFERENCES secure_roles(role_name) ON DELETE CASCADE,
  permission_key TEXT NOT NULL,
  permission_value JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (role_name, permission_key)
);

CREATE TABLE IF NOT EXISTS secure_agent_permissions (
  agent_name TEXT PRIMARY KEY,
  access_scope TEXT NOT NULL,
  allowed_commands TEXT[] NOT NULL,
  allowed_tables TEXT[] NOT NULL,
  max_select_limit INT NOT NULL DEFAULT 100,
  forbidden_commands TEXT[] NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS secure_query_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  role_name TEXT,
  agent_name TEXT,
  pool_name TEXT,
  query_type TEXT,
  sql_text TEXT,
  sql_params JSONB,
  guard_allowed BOOLEAN,
  guard_reason TEXT,
  row_count INT,
  created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO secure_roles(role_name, description)
VALUES
  ('viewer', 'Read-only role for data discovery'),
  ('operator', 'Read + constrained write role for operational actions'),
  ('analyst', 'Statistics and aggregation role'),
  ('admin', 'Full supervision role')
ON CONFLICT (role_name) DO NOTHING;

INSERT INTO secure_role_permissions(role_name, permission_key, permission_value)
VALUES
  ('viewer', 'can_read', '{"enabled":true}'::jsonb),
  ('viewer', 'can_write', '{"enabled":false}'::jsonb),
  ('viewer', 'can_statistics', '{"enabled":true}'::jsonb),
  ('operator', 'can_read', '{"enabled":true}'::jsonb),
  ('operator', 'can_write', '{"enabled":true}'::jsonb),
  ('operator', 'can_statistics', '{"enabled":true}'::jsonb),
  ('analyst', 'can_read', '{"enabled":true}'::jsonb),
  ('analyst', 'can_write', '{"enabled":false}'::jsonb),
  ('analyst', 'can_statistics', '{"enabled":true}'::jsonb),
  ('admin', 'can_read', '{"enabled":true}'::jsonb),
  ('admin', 'can_write', '{"enabled":true}'::jsonb),
  ('admin', 'can_statistics', '{"enabled":true}'::jsonb)
ON CONFLICT (role_name, permission_key) DO UPDATE SET permission_value = EXCLUDED.permission_value;

-- Example user bootstrap
INSERT INTO secure_users(user_id, role_name, active)
VALUES
  ('ui-user', 'operator', TRUE),
  ('analytics-user', 'analyst', TRUE),
  ('viewer-user', 'viewer', TRUE)
ON CONFLICT (user_id) DO UPDATE SET role_name = EXCLUDED.role_name, active = EXCLUDED.active, updated_at = now();
