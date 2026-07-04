// scripts/run_create_tables.js
import { execSync } from 'child_process';

const user = process.env.DB_USER || 'sso_user';
const db = process.env.DB_NAME || 'sso_db';
const host = process.env.DB_HOST || 'localhost';
const port = process.env.DB_PORT || '5433';
const file = 'sql/_00_create_tables.sql';

try {
  execSync(`psql -h ${host} -U ${user} -d ${db} -p ${port} -f ${file}`, { stdio: 'inherit' });
  console.log('Tables created or already exist.');
} catch (e) {
  console.error('Failed to create tables:', e.message);
  process.exit(1);
}
