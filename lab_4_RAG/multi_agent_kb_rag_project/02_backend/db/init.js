import { readPool, writePool } from './pools.js';

export async function initDB() {
  await writePool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE,
    role TEXT,
    created_at TIMESTAMP DEFAULT now()
  )`);

  await writePool.query(`CREATE TABLE IF NOT EXISTS permissions (
    id SERIAL PRIMARY KEY,
    code TEXT UNIQUE,
    access_scope TEXT DEFAULT 'read'
  )`);

  await writePool.query(`CREATE TABLE IF NOT EXISTS user_permissions (
    user_id INT REFERENCES users(id),
    permission_id INT REFERENCES permissions(id)
  )`);

  await writePool.query(`CREATE TABLE IF NOT EXISTS query_log (
    id SERIAL PRIMARY KEY,
    user_id INT,
    agent_type TEXT,
    query TEXT,
    created_at TIMESTAMP DEFAULT now()
  )`);

  await writePool.query(`CREATE TABLE IF NOT EXISTS audit_login (
    id SERIAL PRIMARY KEY,
    user_id INT,
    success BOOLEAN,
    ip_address TEXT,
    created_at TIMESTAMP DEFAULT now()
  )`);

  await writePool.query(`CREATE TABLE IF NOT EXISTS allowed_tables (
    id SERIAL PRIMARY KEY,
    permission_id INT REFERENCES permissions(id),
    table_name TEXT NOT NULL,
    can_select BOOLEAN DEFAULT TRUE,
    can_insert BOOLEAN DEFAULT FALSE,
    can_update BOOLEAN DEFAULT FALSE,
    can_delete BOOLEAN DEFAULT FALSE,
    UNIQUE (permission_id, table_name)
  )`);
}

export async function seedData() {
  await writePool.query(`
    INSERT INTO permissions (code, access_scope)
    VALUES
      ('AGENT_READ_SELECT', 'read'),
      ('AGENT_WRITE_DELETE', 'write'),
      ('AGENT_STATS', 'stats')
    ON CONFLICT (code) DO NOTHING
  `);

  await writePool.query(`
    INSERT INTO users (email, role)
    VALUES ('admin@mail.com', 'admin')
    ON CONFLICT (email) DO NOTHING
  `);

  await writePool.query(`
    INSERT INTO allowed_tables (permission_id, table_name, can_select, can_insert, can_update, can_delete)
    SELECT p.id, x.table_name, x.can_select, x.can_insert, x.can_update, x.can_delete
    FROM permissions p
    JOIN (
      VALUES
        ('AGENT_READ_SELECT', 'nodes', TRUE, FALSE, FALSE, FALSE),
        ('AGENT_READ_SELECT', 'attributes', TRUE, FALSE, FALSE, FALSE),
        ('AGENT_STATS', 'government_requests', TRUE, FALSE, FALSE, FALSE),
        ('AGENT_WRITE_DELETE', 'actions', TRUE, TRUE, TRUE, TRUE)
    ) AS x(code, table_name, can_select, can_insert, can_update, can_delete)
      ON p.code = x.code
    ON CONFLICT (permission_id, table_name) DO NOTHING
  `);
}

export async function validateTables(sql, agentType) {
  const permissionCode = ({
    read: 'AGENT_READ_SELECT',
    write: 'AGENT_WRITE_DELETE',
    stats: 'AGENT_STATS',
    statistics: 'AGENT_STATS',
    manager: 'AGENT_MANAGER',
  })[String(agentType || '').trim().toLowerCase()] || 'AGENT_READ_SELECT';

  const result = await readPool.query(
    `SELECT at.table_name
       FROM allowed_tables at
       JOIN permissions p ON p.id = at.permission_id
      WHERE p.code = $1
        AND at.can_select = TRUE`,
    [permissionCode],
  );

  const allowed = result.rows.map((r) => String(r.table_name || '').toLowerCase());
  const queryText = String(sql || '').toLowerCase();
  const used = allowed.find((tableName) => tableName && queryText.includes(tableName));

  if (!used) {
    throw new Error('Table not allowed');
  }
}
