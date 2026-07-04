// Generates DB schema and orchestrator flow Mermaid diagrams
import fs from 'fs';
import path from 'path';
import { getSchemaMermaid } from '../tools/schema_explorer.js';

const docsDir = path.resolve('docs');
if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir);

// 1. Generate DB schema diagram
globalThis.readPool = (await import('../config/db.js')).readPool; // for ESM import
const mermaid = await getSchemaMermaid();
fs.writeFileSync(path.join(docsDir, 'db-schema.mmd'), mermaid);
console.log('DB schema diagram written to docs/db-schema.mmd');

// 2. Copy orchestrator flow diagram (if not already present)
const flowSrc = path.resolve('docs', 'orchestrator-flow.mmd');
const flowDest = path.join(docsDir, 'orchestrator-flow.mmd');
if (fs.existsSync(flowSrc)) {
  fs.copyFileSync(flowSrc, flowDest);
  console.log('Orchestrator flow diagram copied to docs/orchestrator-flow.mmd');
} else {
  console.log('Orchestrator flow diagram not found at docs/orchestrator-flow.mmd');
}
