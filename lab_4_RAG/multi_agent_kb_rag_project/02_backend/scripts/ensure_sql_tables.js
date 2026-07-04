import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { loadSqlFilesToDb } from '../agents/dbTools.js';

(async function main() {
  try {
    const candidateRoots = [
      path.resolve(process.cwd(), '04_data'),
      path.resolve(process.cwd(), '..', '04_data'),
      path.resolve(process.cwd(), 'sql'),
      path.resolve(process.cwd(), '..', 'sql'),
    ];
    const base = candidateRoots.find((p) => fs.existsSync(path.join(p, 'attributes.sql'))) || path.resolve(process.cwd(), '..', 'sql');
    const files = [
      path.join(base, 'attributes.sql'),
      path.join(base, 'nodes.sql'),
      path.join(base, 'relationships.sql')
    ];

    console.log('Ensuring SQL files are loaded into DB:', files);
    await loadSqlFilesToDb(files);
    console.log('Done. If tables already existed, statements that failed were skipped.');
    process.exit(0);
  } catch (err) {
    console.error('Failed to ensure SQL tables:', err && err.message ? err.message : err);
    process.exit(2);
  }
})();
