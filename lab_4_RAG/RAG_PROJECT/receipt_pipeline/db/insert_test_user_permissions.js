// insert_test_user_permissions.js
// Script to create a test user and permission using the project's connection pool
import { writePool } from './db.js';

async function main() {
  // 1. Create test user (if not exists)
  const userRes = await writePool.query(
    `INSERT INTO users (user_id, first_name, last_name, username, password_hash)
     VALUES ($1, $2, $3, $4, crypt($5, gen_salt('bf')))
     ON CONFLICT (user_id) DO UPDATE SET user_id=EXCLUDED.user_id
     RETURNING id`,
    ['test-user', 'Test', 'User', 'testuser', 'testpass']
  );
  const userId = userRes.rows[0].id;

  // 2. Create permission (if not exists)
  const permRes = await writePool.query(
    `INSERT INTO permissions (code, description, access_scope)
     VALUES ($1, $2, $3)
     ON CONFLICT (code) DO UPDATE SET code=EXCLUDED.code
     RETURNING id`,
    ['AGENT_WRITE_DELETE', 'Write and delete operations (manager flow)', 'write']
  );
  const permId = permRes.rows[0].id;

  // 3. Grant permission to user (if not exists)
  await writePool.query(
    `INSERT INTO user_permissions (user_id, permission_id, granted_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, permission_id) DO NOTHING`,
    [userId, permId, 'system']
  );

  console.log('Test user and permission inserted successfully.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
