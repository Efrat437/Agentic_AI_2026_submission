// LangGraph StateGraph endpoint (static for now, can be made dynamic)
app.get('/mcp/langgraph-stategraph-mermaid', (req, res) => {
  // For now, serve a static Mermaid diagram for the shared state
  const mermaid = `flowchart TD\n  subgraph state[\"Shared State\"]\n    userQuery[\"userQuery\"]\n    researchNotes[\"researchNotes\"]\n    finalAnswer[\"finalAnswer\"]\n  end\n  userQuery --> researchNotes\n  researchNotes --> finalAnswer\n  style userQuery fill:#fffde7\n  style researchNotes fill:#e1f5fe\n  style finalAnswer fill:#f3e5f5`;
  res.type('text/plain').send(mermaid);
});
// Helper to generate a dynamic flowchart for a user question
function generateFlowMermaid({ query }) {
  // This is a simple example. You can extend this logic to reflect real orchestration/KB flow.
  // For demo, we show a flow from user question to schema, query builder, and result.
  const safeQuery = String(query || '').replace(/[`\n]/g, ' ');
  return `flowchart TD\n  A([User Question]) -->|\"${safeQuery}\"| B[Schema Explorer]\n  B --> C[Query Builder]\n  C --> D[SQL/KB Reasoning]\n  D --> E[Result]\n`;
}

// Dynamic flowchart endpoint
app.post('/mcp/flow-mermaid', express.json(), async (req, res) => {
  try {
    const { query } = req.body || {};
    const mermaid = generateFlowMermaid({ query });
    res.type('text/plain').send(mermaid);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Helper to generate Mermaid ER diagram from schema
function generateMermaidERD(schema) {
  let mermaid = 'erDiagram\n';
  const tables = [...new Set((schema.columns || []).map(col => col.table_name))];
  for (const table of tables) {
    mermaid += `  ${table} {\n`;
    for (const col of (schema.columns || []).filter(c => c.table_name === table)) {
      mermaid += `    ${col.data_type} ${col.column_name}\n`;
    }
    mermaid += '  }\n';
  }
  // Add relationships (foreign keys)
  for (const fk of schema.foreignKeys || []) {
    mermaid += `  ${fk.table_name} ||--o{ ${fk.foreign_table_name} : "FK"\n`;
  }
  return mermaid;
}

// Mermaid ERD endpoint
app.get('/mcp/schema-mermaid', async (req, res) => {
  try {
    const schema = await getSchemaGraph({ db });
    const mermaid = generateMermaidERD(schema);
    res.type('text/plain').send(mermaid);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Architecture flowchart endpoint (dynamic, user-driven)
app.post('/mcp/arch-flow-mermaid', express.json(), (req, res) => {
  // Optionally use user question/context from req.body.question
  const question = req.body && req.body.question ? req.body.question : '';

  // Base architecture nodes
  let mermaid = `flowchart TD\n    Orchestrator((Orchestrator))\n    Planner((Planner))\n    Executor((Executor))\n    DB[(DB)]\n    Guard((Guard))\n    Orchestrator --> Planner\n    Planner --> Executor\n    Executor --> DB\n    Executor --> Guard\n    Guard -.-> Orchestrator\n    subgraph Planner\n      Read[\"Read\"]\n      Write[\"Write\"]\n      Stats[\"Stats\"]\n      Manager[\"Manager\"]\n      Planner --> Read\n      Planner --> Write\n      Planner --> Stats\n      Planner --> Manager\n    end`;

  // Optionally, highlight or annotate based on user question
  if (question) {
    // Example: highlight a node or edge if mentioned in the question
    const lower = question.toLowerCase();
    if (lower.includes('read')) mermaid += '\n  class Read highlight;';
    if (lower.includes('write')) mermaid += '\n  class Write highlight;';
    if (lower.includes('stats')) mermaid += '\n  class Stats highlight;';
    if (lower.includes('manager')) mermaid += '\n  class Manager highlight;';
    if (lower.includes('executor')) mermaid += '\n  class Executor highlight;';
    if (lower.includes('db')) mermaid += '\n  class DB highlight;';
    if (lower.includes('guard')) mermaid += '\n  class Guard highlight;';
    if (lower.includes('orchestrator')) mermaid += '\n  class Orchestrator highlight;';
    if (lower.includes('planner')) mermaid += '\n  class Planner highlight;';
    // Add highlight style
    mermaid += '\n  classDef highlight fill:#ffeb3b,stroke:#fbc02d,stroke-width:4px;';
  }

  res.type('text/plain').send(mermaid);
});

// LangGraph flowchart endpoint (static for now, can be made dynamic)
import fs from 'fs';
app.get('/mcp/langgraph-flow-mermaid', (req, res) => {
  // For now, serve the static Mermaid file from lab_11_langgraph/langgraph-flow.mmd
  const mmdPath = 'lab_11_langgraph/langgraph-flow.mmd';
  fs.readFile(mmdPath, 'utf8', (err, data) => {
    if (err) {
      res.status(500).json({ error: 'Could not read LangGraph flow file.' });
    } else {
      res.type('text/plain').send(data);
    }
  });
});

import express from 'express';
import pg from 'pg';
import { getSchemaGraph } from './02_backend/agents/schemaGraph.js';
import { buildQueryBuilderSystemPrompt } from './02_backend/agents/query_builder_agent.js';

const app = express();
const PORT = process.env.DB_SCHEMA_MCP_PORT || 4100;


// Configure your DB connection here
// Optionally, load all .sql files in sql/ and sql/security/ for schema introspection
import path from 'path';
function loadSqlFiles(dir) {
  const fs = require('fs');
  let sql = '';
  fs.readdirSync(dir).forEach(file => {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      sql += loadSqlFiles(fullPath);
    } else if (file.endsWith('.sql')) {
      sql += fs.readFileSync(fullPath, 'utf8') + '\n';
    }
  });
  return sql;
}
const allSql = loadSqlFiles(path.join(__dirname, 'sql'));
// You can use allSql to initialize or introspect the DB, or to enhance getSchemaGraph
const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://user:pass@localhost:5432/yourdb',
});

app.get('/mcp/schema-graph', async (req, res) => {
  try {
    const schema = await getSchemaGraph({ db });
    res.json(schema);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Query Builder Endpoint
app.post('/mcp/query-builder', express.json(), async (req, res) => {
  try {
    const { query, mode, executionMode, sqlOptions } = req.body || {};
    // For demo: just return the system prompt and anchors (extend with real candidate generation as needed)
    const anchors = [];
    const prompt = buildQueryBuilderSystemPrompt({ query, mode, executionMode, sqlOptions, anchors });
    res.json({ prompt, anchors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Schema Docs Endpoint
app.get('/mcp/schema-docs', async (req, res) => {
  try {
    const schema = await getSchemaGraph({ db });
    let md = '# Database Schema Documentation\n\n';
    const tables = [...new Set((schema.columns || []).map(col => col.table_name))];
    for (const table of tables) {
      md += `## Table: ${table}\n`;
      md += '| Column | Type |\n|---|---|\n';
      for (const col of (schema.columns || []).filter(c => c.table_name === table)) {
        md += `| ${col.column_name} | ${col.data_type} |\n`;
      }
      md += '\n';
    }
    res.type('text/markdown').send(md);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`DB Schema MCP server running on port ${PORT}`);
});
