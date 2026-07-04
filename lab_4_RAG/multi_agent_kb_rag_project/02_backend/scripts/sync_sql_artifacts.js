import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

const SQL_DIR = path.join(PROJECT_ROOT, 'sql');
const DATA_DIR = path.join(PROJECT_ROOT, '04_data');

function listTopLevelSqlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.sql'))
    .map((name) => path.join(dir, name));
}

function copyIfChanged(src, dest) {
  if (!fs.existsSync(src)) return false;
  const srcStat = fs.statSync(src);
  if (fs.existsSync(dest)) {
    const destStat = fs.statSync(dest);
    if (destStat.size === srcStat.size && destStat.mtimeMs >= srcStat.mtimeMs) {
      return false;
    }
  }
  fs.copyFileSync(src, dest);
  return true;
}

function pickCanonicalPath(sqlPath, dataPath) {
  const sqlExists = fs.existsSync(sqlPath);
  const dataExists = fs.existsSync(dataPath);
  if (sqlExists && !dataExists) return sqlPath;
  if (!sqlExists && dataExists) return dataPath;
  if (!sqlExists && !dataExists) return null;

  const sqlStat = fs.statSync(sqlPath);
  const dataStat = fs.statSync(dataPath);
  return sqlStat.mtimeMs >= dataStat.mtimeMs ? sqlPath : dataPath;
}

function main() {
  if (!fs.existsSync(SQL_DIR)) fs.mkdirSync(SQL_DIR, { recursive: true });
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const sqlFiles = listTopLevelSqlFiles(SQL_DIR).map((p) => path.basename(p));
  const dataFiles = listTopLevelSqlFiles(DATA_DIR).map((p) => path.basename(p));
  const allNames = Array.from(new Set([...sqlFiles, ...dataFiles])).sort();

  let copied = 0;
  for (const name of allNames) {
    const sqlPath = path.join(SQL_DIR, name);
    const dataPath = path.join(DATA_DIR, name);
    const canonical = pickCanonicalPath(sqlPath, dataPath);
    if (!canonical) continue;

    const target = canonical === sqlPath ? dataPath : sqlPath;
    if (copyIfChanged(canonical, target)) {
      copied += 1;
      console.log(`Synced ${name}: ${path.basename(path.dirname(canonical))} -> ${path.basename(path.dirname(target))}`);
    }
  }

  console.log(`SQL sync complete. Updated ${copied} file(s).`);
}

main();
