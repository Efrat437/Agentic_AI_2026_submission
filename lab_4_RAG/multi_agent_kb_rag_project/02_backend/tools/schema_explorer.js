// DB Schema Explorer Tool: returns Mermaid ER diagram of tables and relationships
import { readPool } from '../config/db.js';

export async function getSchemaMermaid() {
  // Query tables and FKs
  const tablesQ = `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  const fksQ = `
    SELECT
      tc.table_name AS from_table,
      kcu.column_name AS from_column,
      ccu.table_name AS to_table,
      ccu.column_name AS to_column
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  `;
  const [tablesRes, fksRes] = await Promise.all([
    readPool.query(tablesQ),
    readPool.query(fksQ),
  ]);
  const tables = tablesRes.rows.map(r => r.table_name);
  const fks = fksRes.rows;

  // Build Mermaid ER diagram
  let mermaid = 'erDiagram\n';
  for (const t of tables) {
    mermaid += `  ${t} {\n    ...\n  }\n`;
  }
  for (const fk of fks) {
    mermaid += `  ${fk.from_table} }o--|| ${fk.to_table} : FK\n`;
  }
  return mermaid;
}

// Example usage: await getSchemaMermaid();
