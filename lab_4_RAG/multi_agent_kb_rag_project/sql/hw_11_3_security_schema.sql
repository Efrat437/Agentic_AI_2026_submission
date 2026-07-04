-- hw_11_3_security_schema.sql
-- Homework 11.3: privileged agent_manager + stats-oriented security/audit model.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permissions (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  description TEXT,
  access_scope TEXT NOT NULL CHECK (access_scope IN ('read', 'write', 'delete', 'stats', 'manager')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_permissions (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id BIGINT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_by TEXT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission_id)
);

CREATE TABLE IF NOT EXISTS allowed_tables (
  id BIGSERIAL PRIMARY KEY,
  permission_id BIGINT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  can_select BOOLEAN NOT NULL DEFAULT TRUE,
  can_insert BOOLEAN NOT NULL DEFAULT FALSE,
  can_update BOOLEAN NOT NULL DEFAULT FALSE,
  can_delete BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(permission_id, table_name)
);

CREATE TABLE IF NOT EXISTS query_log (
  id BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL DEFAULT gen_random_uuid(),
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_username TEXT,
  agent_name TEXT,
  route_name TEXT,
  sql_text TEXT NOT NULL,
  sql_command TEXT NOT NULL,
  pool_name TEXT NOT NULL CHECK (pool_name IN ('read', 'write', 'statistics')),
  success BOOLEAN NOT NULL,
  row_count INTEGER,
  duration_ms INTEGER,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_login (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  username TEXT,
  login_success BOOLEAN NOT NULL,
  failure_reason TEXT,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resources_booking (
  id BIGSERIAL PRIMARY KEY,
  resource_key TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  slot_start TIMESTAMPTZ NOT NULL,
  slot_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'booked', 'cancelled')),
  booked_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  booking_reference TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(resource_key, slot_start, slot_end)
);

CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE INDEX IF NOT EXISTS idx_user_permissions_user_id ON user_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_permissions_permission_id ON user_permissions(permission_id);

CREATE INDEX IF NOT EXISTS idx_allowed_tables_permission_id ON allowed_tables(permission_id);
CREATE INDEX IF NOT EXISTS idx_allowed_tables_table_name ON allowed_tables(table_name);

CREATE INDEX IF NOT EXISTS idx_query_log_created_at ON query_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_log_actor_user_id ON query_log(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_query_log_route_name ON query_log(route_name);
CREATE INDEX IF NOT EXISTS idx_query_log_pool_name ON query_log(pool_name);

CREATE INDEX IF NOT EXISTS idx_audit_login_created_at ON audit_login(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_login_user_id ON audit_login(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_login_success_created_at ON audit_login(login_success, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_resources_booking_slot_start ON resources_booking(slot_start);
CREATE INDEX IF NOT EXISTS idx_resources_booking_status_slot ON resources_booking(status, slot_start);

INSERT INTO permissions (code, description, access_scope)
VALUES
  ('AGENT_READ_SELECT', 'Read-only SELECT operations', 'read'),
  ('AGENT_WRITE_DELETE', 'Write and delete operations for manager flows', 'write'),
  ('AGENT_STATS', 'Statistics and aggregation access', 'stats'),
  ('AGENT_MANAGER', 'Privileged manager permission set', 'manager')
ON CONFLICT (code) DO NOTHING;

INSERT INTO allowed_tables (permission_id, table_name, can_select, can_insert, can_update, can_delete)
SELECT p.id, x.table_name, x.can_select, x.can_insert, x.can_update, x.can_delete
FROM permissions p
JOIN (
  VALUES
    ('AGENT_READ_SELECT', 'users', TRUE, FALSE, FALSE, FALSE),
    ('AGENT_READ_SELECT', 'permissions', TRUE, FALSE, FALSE, FALSE),
    ('AGENT_READ_SELECT', 'user_permissions', TRUE, FALSE, FALSE, FALSE),
    ('AGENT_READ_SELECT', 'allowed_tables', TRUE, FALSE, FALSE, FALSE),
    ('AGENT_READ_SELECT', 'resources_booking', TRUE, FALSE, FALSE, FALSE),
    ('AGENT_STATS', 'audit_login', TRUE, FALSE, FALSE, FALSE),
    ('AGENT_STATS', 'query_log', TRUE, FALSE, FALSE, FALSE),
    ('AGENT_WRITE_DELETE', 'users', TRUE, TRUE, TRUE, TRUE),
    ('AGENT_WRITE_DELETE', 'user_permissions', TRUE, TRUE, TRUE, TRUE),
    ('AGENT_WRITE_DELETE', 'resources_booking', TRUE, TRUE, TRUE, TRUE),
    ('AGENT_MANAGER', 'users', TRUE, TRUE, TRUE, TRUE),
    ('AGENT_MANAGER', 'permissions', TRUE, TRUE, TRUE, TRUE),
    ('AGENT_MANAGER', 'user_permissions', TRUE, TRUE, TRUE, TRUE),
    ('AGENT_MANAGER', 'allowed_tables', TRUE, TRUE, TRUE, TRUE),
    ('AGENT_MANAGER', 'query_log', TRUE, TRUE, TRUE, TRUE),
    ('AGENT_MANAGER', 'audit_login', TRUE, TRUE, TRUE, TRUE),
    ('AGENT_MANAGER', 'resources_booking', TRUE, TRUE, TRUE, TRUE)
) AS x(permission_code, table_name, can_select, can_insert, can_update, can_delete)
  ON p.code = x.permission_code
ON CONFLICT (permission_id, table_name)
DO UPDATE SET
  can_select = EXCLUDED.can_select,
  can_insert = EXCLUDED.can_insert,
  can_update = EXCLUDED.can_update,
  can_delete = EXCLUDED.can_delete;

CREATE OR REPLACE VIEW vw_logged_in_users_current_month AS
SELECT COUNT(DISTINCT COALESCE(user_id::TEXT, username))::BIGINT AS logged_in_users_current_month
FROM audit_login
WHERE login_success = TRUE
  AND created_at >= date_trunc('month', now())
  AND created_at < (date_trunc('month', now()) + INTERVAL '1 month');
