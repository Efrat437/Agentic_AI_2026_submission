-- 10_allowed_tables.sql
-- Per-permission, per-table DML whitelist (SELECT / INSERT / UPDATE / DELETE).
-- Depends on: 08_permissions.sql

CREATE TABLE IF NOT EXISTS allowed_tables (
  id            BIGSERIAL   PRIMARY KEY,
  permission_id BIGINT      NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,
  table_name    TEXT        NOT NULL,
  can_select    BOOLEAN     NOT NULL DEFAULT TRUE,
  can_insert    BOOLEAN     NOT NULL DEFAULT FALSE,
  can_update    BOOLEAN     NOT NULL DEFAULT FALSE,
  can_delete    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (permission_id, table_name)
);

CREATE INDEX IF NOT EXISTS idx_allowed_tables_permission_id
  ON allowed_tables (permission_id);

CREATE INDEX IF NOT EXISTS idx_allowed_tables_table_name
  ON allowed_tables (table_name);

-- Seed the DML whitelist matrix
INSERT INTO allowed_tables (permission_id, table_name, can_select, can_insert, can_update, can_delete)
SELECT p.id,
       x.table_name,
       x.can_select,
       x.can_insert,
       x.can_update,
       x.can_delete
FROM permissions p
JOIN (
  VALUES
    ('AGENT_READ_SELECT',  'users',             TRUE,  FALSE, FALSE, FALSE),
    ('AGENT_READ_SELECT',  'permissions',       TRUE,  FALSE, FALSE, FALSE),
    ('AGENT_READ_SELECT',  'user_permissions',  TRUE,  FALSE, FALSE, FALSE),
    ('AGENT_READ_SELECT',  'allowed_tables',    TRUE,  FALSE, FALSE, FALSE),
    ('AGENT_READ_SELECT',  'resources_booking', TRUE,  FALSE, FALSE, FALSE),

    ('AGENT_STATS',        'audit_login',       TRUE,  FALSE, FALSE, FALSE),
    ('AGENT_STATS',        'query_log',         TRUE,  FALSE, FALSE, FALSE),

    ('AGENT_WRITE_DELETE', 'users',             TRUE,  TRUE,  TRUE,  TRUE),
    ('AGENT_WRITE_DELETE', 'user_permissions',  TRUE,  TRUE,  TRUE,  TRUE),
    ('AGENT_WRITE_DELETE', 'resources_booking', TRUE,  TRUE,  TRUE,  TRUE),

    ('AGENT_MANAGER',      'users',             TRUE,  TRUE,  TRUE,  TRUE),
    ('AGENT_MANAGER',      'permissions',       TRUE,  TRUE,  TRUE,  TRUE),
    ('AGENT_MANAGER',      'user_permissions',  TRUE,  TRUE,  TRUE,  TRUE),
    ('AGENT_MANAGER',      'allowed_tables',    TRUE,  TRUE,  TRUE,  TRUE),
    ('AGENT_MANAGER',      'query_log',         TRUE,  TRUE,  TRUE,  TRUE),
    ('AGENT_MANAGER',      'audit_login',       TRUE,  TRUE,  TRUE,  TRUE),
    ('AGENT_MANAGER',      'resources_booking', TRUE,  TRUE,  TRUE,  TRUE)
) AS x (permission_code, table_name, can_select, can_insert, can_update, can_delete)
  ON p.code = x.permission_code
ON CONFLICT (permission_id, table_name)
DO UPDATE SET
  can_select = EXCLUDED.can_select,
  can_insert = EXCLUDED.can_insert,
  can_update = EXCLUDED.can_update,
  can_delete = EXCLUDED.can_delete;
