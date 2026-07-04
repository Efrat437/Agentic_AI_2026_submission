import fs from 'fs/promises';
import path from 'path';
import { writePool } from '../config/db.js';
import { ensureDefenseInDepthSecurity } from '../security/secure_sql_orchestrator.js';

// ─── Individual per-entity SQL files (preferred) ──────────────────────────────
// Located in sql/security/ — each file owns one entity (role, table, seed data).
// Applied in numeric order so FK dependencies are always satisfied.
const SECURITY_SQL_DIR = path.resolve(process.cwd(), 'sql', 'security');
const SECURITY_FILES = [
  '01_pg_roles.sql',           // PostgreSQL DB roles + GRANT statements
  '02_secure_roles.sql',       // secure_roles table + seed (viewer/operator/analyst/admin)
  '03_secure_users.sql',       // secure_users table + example bootstrap users
  '04_secure_role_permissions.sql', // secure_role_permissions + permission matrix seed
  '05_secure_agent_permissions.sql', // secure_agent_permissions (seeded at runtime by JS)
  '06_secure_query_logs.sql',  // secure_query_logs audit table + indexes
  '07_users.sql',              // users table + pgcrypto extension + indexes
  '08_permissions.sql',        // permissions table + AGENT_* seed codes
  '09_user_permissions.sql',   // user_permissions join table + indexes
  '10_allowed_tables.sql',     // allowed_tables + DML whitelist seed matrix
  '11_query_log.sql',          // query_log table + indexes
  '12_audit_login.sql',        // audit_login table + indexes + vw_logged_in_users_current_month
  '13_resources_booking.sql',  // resources_booking table + indexes
  '14_government_requests_jsonb_notes.sql', // government_requests.notes jsonb alignment + indexes
  '15_query_log_compat.sql',   // compatibility view for minimal query_log shape
  '16_legacy_table_compat.sql', // table-level legacy compatibility columns + triggers
];

// ─── Monolithic fallback files (legacy / backward compat) ────────────────────
const MONOLITHIC_FILES = [
  path.resolve(process.cwd(), 'sql', 'defense_in_depth_security.sql'),
  path.resolve(process.cwd(), 'sql', 'hw_11_3_security_schema.sql'),
];

async function fileExists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function applySqlFile(filePath) {
  const sql = await fs.readFile(filePath, 'utf8');
  await writePool.query(sql);
  return path.basename(filePath);
}

async function run() {
  const applied = [];
  const firstSplitFile = path.join(SECURITY_SQL_DIR, SECURITY_FILES[0]);
  const useSplit = await fileExists(firstSplitFile);

  if (useSplit) {
    console.log('[security:init] Loading individual security SQL files from sql/security/ ...');
    for (const file of SECURITY_FILES) {
      const filePath = path.join(SECURITY_SQL_DIR, file);
      try {
        const name = await applySqlFile(filePath);
        applied.push(name);
        console.log(`  ✓  ${name}`);
      } catch (err) {
        // IF NOT EXISTS guards make most conflicts safe; warn but continue
        console.warn(`  ⚠  ${file}: ${String(err?.message || err).split('\n')[0]}`);
      }
    }
  } else {
    console.log('[security:init] sql/security/ not found – loading monolithic fallback files...');
    for (const filePath of MONOLITHIC_FILES) {
      try {
        const name = await applySqlFile(filePath);
        applied.push(name);
        console.log(`  ✓  ${path.basename(filePath)}`);
      } catch (err) {
        console.warn(`  ⚠  ${path.basename(filePath)}: ${String(err?.message || err).split('\n')[0]}`);
      }
    }
  }

  // Seed agent permissions and run JS-level integrity checks
  await ensureDefenseInDepthSecurity();
  console.log(JSON.stringify({ ok: true, applied }, null, 2));
}

run()
  .catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2));
    process.exit(1);
  })
  .finally(async () => {
    await writePool.end().catch(() => {});
  });
