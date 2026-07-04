-- 04_secure_role_permissions.sql
-- Permission matrix per role: can_read, can_write, can_statistics, can_manage_users.
-- Depends on: 02_secure_roles.sql

CREATE TABLE IF NOT EXISTS secure_role_permissions (
  role_name        TEXT    NOT NULL REFERENCES secure_roles (role_name) ON DELETE CASCADE,
  permission_key   TEXT    NOT NULL,
  permission_value JSONB   NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (role_name, permission_key)
);

INSERT INTO secure_role_permissions (role_name, permission_key, permission_value)
VALUES
  ('viewer',   'can_read',        '{"enabled":true}'::jsonb),
  ('viewer',   'can_write',       '{"enabled":false}'::jsonb),
  ('viewer',   'can_statistics',  '{"enabled":true}'::jsonb),
  ('viewer',   'can_manage_users','{"enabled":false}'::jsonb),

  ('operator', 'can_read',        '{"enabled":true}'::jsonb),
  ('operator', 'can_write',       '{"enabled":true}'::jsonb),
  ('operator', 'can_statistics',  '{"enabled":true}'::jsonb),
  ('operator', 'can_manage_users','{"enabled":true}'::jsonb),

  ('analyst',  'can_read',        '{"enabled":true}'::jsonb),
  ('analyst',  'can_write',       '{"enabled":false}'::jsonb),
  ('analyst',  'can_statistics',  '{"enabled":true}'::jsonb),
  ('analyst',  'can_manage_users','{"enabled":false}'::jsonb),

  ('admin',    'can_read',        '{"enabled":true}'::jsonb),
  ('admin',    'can_write',       '{"enabled":true}'::jsonb),
  ('admin',    'can_statistics',  '{"enabled":true}'::jsonb),
  ('admin',    'can_manage_users','{"enabled":true}'::jsonb)
ON CONFLICT (role_name, permission_key)
DO UPDATE SET permission_value = EXCLUDED.permission_value;
