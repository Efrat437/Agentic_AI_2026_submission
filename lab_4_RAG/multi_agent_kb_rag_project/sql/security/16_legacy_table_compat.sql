-- 16_legacy_table_compat.sql
-- True table-level compatibility for legacy simplified schema usage.
-- Keeps existing rich schema and adds backward-compatible columns/behavior.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- users(email, role, created_at) compatibility
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS role TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
  ON users (email)
  WHERE email IS NOT NULL;

CREATE OR REPLACE FUNCTION fn_users_legacy_compat_fill()
RETURNS trigger AS $$
BEGIN
  IF NEW.email IS NULL AND NEW.username IS NOT NULL AND position('@' IN NEW.username) > 0 THEN
    NEW.email := NEW.username;
  END IF;

  IF NEW.username IS NULL OR btrim(NEW.username) = '' THEN
    IF NEW.email IS NOT NULL AND btrim(NEW.email) <> '' THEN
      NEW.username := split_part(NEW.email, '@', 1) || '_' || substr(md5(random()::text), 1, 6);
    ELSE
      NEW.username := 'user_' || substr(md5(random()::text), 1, 10);
    END IF;
  END IF;

  IF NEW.user_id IS NULL OR btrim(NEW.user_id) = '' THEN
    NEW.user_id := COALESCE(NULLIF(NEW.email, ''), NEW.username, 'user_' || substr(md5(random()::text), 1, 12));
  END IF;

  IF NEW.first_name IS NULL OR btrim(NEW.first_name) = '' THEN NEW.first_name := 'Legacy'; END IF;
  IF NEW.last_name IS NULL OR btrim(NEW.last_name) = '' THEN NEW.last_name := 'User'; END IF;
  IF NEW.password_hash IS NULL OR btrim(NEW.password_hash) = '' THEN
    NEW.password_hash := crypt('change_me', gen_salt('bf'));
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_legacy_compat_fill ON users;
CREATE TRIGGER trg_users_legacy_compat_fill
BEFORE INSERT OR UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION fn_users_legacy_compat_fill();

-- permissions(code) compatibility (access_scope default)
ALTER TABLE permissions
  ALTER COLUMN access_scope SET DEFAULT 'read';

-- allowed_tables agent_type compatibility is deprecated.
-- Canonical writes should use permission_id + table_name + can_* flags.
-- The compatibility column remains only to avoid breaking old inserts.
ALTER TABLE allowed_tables
  ADD COLUMN IF NOT EXISTS agent_type TEXT;

CREATE OR REPLACE FUNCTION fn_allowed_tables_legacy_compat_sync()
RETURNS trigger AS $$
DECLARE
  resolved_permission_id BIGINT;
  resolved_code TEXT;
BEGIN
  IF NEW.permission_id IS NULL AND NEW.agent_type IS NOT NULL THEN
    resolved_code := CASE lower(NEW.agent_type)
      WHEN 'read' THEN 'AGENT_READ_SELECT'
      WHEN 'write' THEN 'AGENT_WRITE_DELETE'
      WHEN 'stats' THEN 'AGENT_STATS'
      WHEN 'statistics' THEN 'AGENT_STATS'
      WHEN 'manager' THEN 'AGENT_MANAGER'
      WHEN 'admin' THEN 'AGENT_MANAGER'
      ELSE NULL
    END;

    IF resolved_code IS NOT NULL THEN
      SELECT id INTO resolved_permission_id FROM permissions WHERE code = resolved_code LIMIT 1;
      IF resolved_permission_id IS NOT NULL THEN
        NEW.permission_id := resolved_permission_id;
      END IF;
    END IF;
  END IF;

  IF NEW.agent_type IS NULL AND NEW.permission_id IS NOT NULL THEN
    SELECT code INTO resolved_code FROM permissions WHERE id = NEW.permission_id LIMIT 1;
    NEW.agent_type := CASE resolved_code
      WHEN 'AGENT_READ_SELECT' THEN 'read'
      WHEN 'AGENT_WRITE_DELETE' THEN 'write'
      WHEN 'AGENT_STATS' THEN 'stats'
      WHEN 'AGENT_MANAGER' THEN 'manager'
      ELSE NEW.agent_type
    END;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_allowed_tables_legacy_compat_sync ON allowed_tables;
CREATE TRIGGER trg_allowed_tables_legacy_compat_sync
BEFORE INSERT OR UPDATE ON allowed_tables
FOR EACH ROW EXECUTE FUNCTION fn_allowed_tables_legacy_compat_sync();

-- query_log(user_id, agent_type, query, created_at) compatibility
ALTER TABLE query_log
  ADD COLUMN IF NOT EXISTS user_id BIGINT,
  ADD COLUMN IF NOT EXISTS agent_type TEXT,
  ADD COLUMN IF NOT EXISTS query TEXT;

ALTER TABLE query_log
  ALTER COLUMN sql_command SET DEFAULT 'SELECT',
  ALTER COLUMN pool_name SET DEFAULT 'read',
  ALTER COLUMN success SET DEFAULT TRUE;

CREATE OR REPLACE FUNCTION fn_query_log_legacy_compat_sync()
RETURNS trigger AS $$
BEGIN
  IF NEW.actor_user_id IS NULL AND NEW.user_id IS NOT NULL THEN NEW.actor_user_id := NEW.user_id; END IF;
  IF NEW.user_id IS NULL AND NEW.actor_user_id IS NOT NULL THEN NEW.user_id := NEW.actor_user_id; END IF;

  IF NEW.agent_name IS NULL AND NEW.agent_type IS NOT NULL THEN NEW.agent_name := NEW.agent_type; END IF;
  IF NEW.agent_type IS NULL AND NEW.agent_name IS NOT NULL THEN NEW.agent_type := NEW.agent_name; END IF;

  IF NEW.sql_text IS NULL AND NEW.query IS NOT NULL THEN NEW.sql_text := NEW.query; END IF;
  IF NEW.query IS NULL AND NEW.sql_text IS NOT NULL THEN NEW.query := NEW.sql_text; END IF;

  IF NEW.sql_command IS NULL OR btrim(NEW.sql_command) = '' THEN NEW.sql_command := 'SELECT'; END IF;
  IF NEW.pool_name IS NULL OR btrim(NEW.pool_name) = '' THEN
    IF lower(COALESCE(NEW.agent_type, NEW.agent_name, '')) LIKE 'stats%' THEN
      NEW.pool_name := 'statistics';
    ELSIF lower(COALESCE(NEW.agent_type, NEW.agent_name, '')) LIKE 'write%' THEN
      NEW.pool_name := 'write';
    ELSE
      NEW.pool_name := 'read';
    END IF;
  END IF;
  IF NEW.success IS NULL THEN NEW.success := TRUE; END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_query_log_legacy_compat_sync ON query_log;
CREATE TRIGGER trg_query_log_legacy_compat_sync
BEFORE INSERT OR UPDATE ON query_log
FOR EACH ROW EXECUTE FUNCTION fn_query_log_legacy_compat_sync();

-- audit_login(success, ip_address, created_at) compatibility
ALTER TABLE audit_login
  ADD COLUMN IF NOT EXISTS success BOOLEAN;

CREATE OR REPLACE FUNCTION fn_audit_login_legacy_compat_sync()
RETURNS trigger AS $$
BEGIN
  IF NEW.login_success IS NULL AND NEW.success IS NOT NULL THEN NEW.login_success := NEW.success; END IF;
  IF NEW.success IS NULL AND NEW.login_success IS NOT NULL THEN NEW.success := NEW.login_success; END IF;
  IF NEW.login_success IS NULL THEN NEW.login_success := FALSE; END IF;
  IF NEW.success IS NULL THEN NEW.success := NEW.login_success; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_login_legacy_compat_sync ON audit_login;
CREATE TRIGGER trg_audit_login_legacy_compat_sync
BEFORE INSERT OR UPDATE ON audit_login
FOR EACH ROW EXECUTE FUNCTION fn_audit_login_legacy_compat_sync();

-- One-time backfill for compatibility columns
UPDATE query_log
SET
  user_id = COALESCE(user_id, actor_user_id),
  agent_type = COALESCE(agent_type, agent_name),
  query = COALESCE(query, sql_text)
WHERE user_id IS NULL OR agent_type IS NULL OR query IS NULL;

UPDATE audit_login
SET success = COALESCE(success, login_success)
WHERE success IS NULL;

UPDATE users
SET
  email = COALESCE(email, CASE WHEN position('@' IN username) > 0 THEN username ELSE NULL END),
  role = COALESCE(role, 'viewer')
WHERE email IS NULL OR role IS NULL;
