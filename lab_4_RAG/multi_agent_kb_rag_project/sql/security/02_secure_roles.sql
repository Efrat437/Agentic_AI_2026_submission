-- 02_secure_roles.sql
-- App-level role catalog: viewer, operator, analyst, admin.
-- Must run after 01_pg_roles.sql (uses same DB / schema).

CREATE TABLE IF NOT EXISTS secure_roles (
  role_name   TEXT PRIMARY KEY,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

INSERT INTO secure_roles (role_name, description)
VALUES
  ('viewer',   'Read-only role for data discovery'),
  ('operator', 'Read + constrained write role for operational actions'),
  ('analyst',  'Statistics and aggregation role'),
  ('admin',    'Full supervision role')
ON CONFLICT (role_name) DO NOTHING;
