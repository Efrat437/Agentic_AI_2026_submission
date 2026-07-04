-- 03_secure_users.sql
-- App-level user → role mapping (bootstrapped example users).
-- Depends on: 02_secure_roles.sql

CREATE TABLE IF NOT EXISTS secure_users (
  user_id    TEXT PRIMARY KEY,
  role_name  TEXT NOT NULL REFERENCES secure_roles (role_name) ON UPDATE CASCADE,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO secure_users (user_id, role_name, active)
VALUES
  ('ui-user',        'operator', TRUE),
  ('analytics-user', 'analyst',  TRUE),
  ('viewer-user',    'viewer',   TRUE)
ON CONFLICT (user_id)
DO UPDATE SET
  role_name  = EXCLUDED.role_name,
  active     = EXCLUDED.active,
  updated_at = now();
