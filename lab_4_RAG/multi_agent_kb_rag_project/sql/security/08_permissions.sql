-- 08_permissions.sql
-- Application permission codes and their access scope.
-- Seed: AGENT_READ_SELECT, AGENT_WRITE_DELETE, AGENT_STATS, AGENT_MANAGER

CREATE TABLE IF NOT EXISTS permissions (
  id           BIGSERIAL   PRIMARY KEY,
  code         TEXT        UNIQUE NOT NULL,
  description  TEXT,
  access_scope TEXT        NOT NULL
                           CHECK (access_scope IN ('read', 'write', 'delete', 'stats', 'manager')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO permissions (code, description, access_scope)
VALUES
  ('AGENT_READ_SELECT',  'Read-only SELECT operations',               'read'),
  ('AGENT_WRITE_DELETE', 'Write and delete operations (manager flow)', 'write'),
  ('AGENT_STATS',        'Statistics and aggregation access',          'stats'),
  ('AGENT_MANAGER',      'Privileged manager permission set',          'manager')
ON CONFLICT (code) DO NOTHING;
