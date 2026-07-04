// setup_schema.js
// Runs all schema SQL files in order using the project's connection pool
import { writePool } from './db.js';
import fs from 'fs/promises';
import path from 'path';

async function runSqlFile(filename) {
  const sql = await fs.readFile(path.join('./db', filename), 'utf8');
  // Split on semicolons to avoid issues with multiple statements
  for (const stmt of sql.split(';')) {
    const trimmed = stmt.trim();
    if (trimmed) {
      await writePool.query(trimmed);
    }
  }
}

async function main() {
  await runSqlFile('07_users.sql');
  await runSqlFile('08_permissions.sql');
  await runSqlFile('09_user_permissions.sql');
  console.log('Schema setup complete.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
