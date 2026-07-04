-- Step 1: Create required tables
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  id SERIAL PRIMARY KEY,
  code VARCHAR(64) UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS user_permissions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  permission_id INTEGER REFERENCES permissions(id)
);

-- Step 2: Insert test user and permission
INSERT INTO users (user_id) VALUES ('test-user') ON CONFLICT (user_id) DO NOTHING;
INSERT INTO permissions (code) VALUES ('AGENT_WRITE_DELETE') ON CONFLICT (code) DO NOTHING;
INSERT INTO user_permissions (user_id, permission_id)
SELECT u.id, p.id FROM users u, permissions p
WHERE u.user_id = 'test-user' AND p.code = 'AGENT_WRITE_DELETE'
ON CONFLICT DO NOTHING;
