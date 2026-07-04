-- 05_secure_agent_permissions.sql
-- Per-agent access scope, allowed/forbidden SQL commands, table whitelist, row limits.
-- Runtime-upserted by ensureDefenseInDepthSecurity() in secure_sql_orchestrator.js.
-- Keep explicit SQL seed rows here so security:init remains self-contained.

CREATE TABLE IF NOT EXISTS secure_agent_permissions (
  agent_name         TEXT     PRIMARY KEY,
  access_scope       TEXT     NOT NULL,
  allowed_commands   TEXT[]   NOT NULL,
  allowed_tables     TEXT[]   NOT NULL,
  max_select_limit   INT      NOT NULL DEFAULT 100,
  forbidden_commands TEXT[]   NOT NULL,
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);

INSERT INTO secure_agent_permissions (
  agent_name,
  access_scope,
  allowed_commands,
  allowed_tables,
  max_select_limit,
  forbidden_commands
)
VALUES
  (
    'manager_agent',
    'manager',
    ARRAY['SELECT','INSERT','UPDATE','DELETE'],
    ARRAY['users','permissions','user_permissions','allowed_tables','query_log','audit_login','secure_users','secure_roles','secure_role_permissions','secure_agent_permissions'],
    100,
    ARRAY['ALTER','DROP','TRUNCATE','GRANT','REVOKE','CREATE ROLE','DROP ROLE']
  )
ON CONFLICT (agent_name)
DO UPDATE SET
  access_scope = EXCLUDED.access_scope,
  allowed_commands = EXCLUDED.allowed_commands,
  allowed_tables = EXCLUDED.allowed_tables,
  max_select_limit = EXCLUDED.max_select_limit,
  forbidden_commands = EXCLUDED.forbidden_commands,
  updated_at = now();
