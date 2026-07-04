// scripts/run_create_tables_docker.js
import { execSync } from 'child_process';

const container = 'multi_agent_kb_rag_project-postgres-1';
const file = 'sql/_00_create_tables.sql';
try {
  execSync(`docker exec -i ${container} psql -U sso_user -d sso_db < ${file}`, { stdio: 'inherit' });
  console.log('Tables created or already exist (via Docker).');
} catch (e) {
  console.error('Failed to create tables in Docker:', e.message);
  process.exit(1);
}
