import embeddingSkill from './embedding_skill.js';
import semanticSimilaritySkill from './semantic_similarity_skill.js';
import sqlWriterSkill from './sql_writer_skill.js';
import graphTraversalSkill from './graph_traversal_skill.js';
import proxyIndexSkill from './proxy_index_skill.js';
import multiAnchorSqlSkill from './multi_anchor_sql_skill.js';
import ingestSqlToRagSkill from './ingest_sql_to_rag_skill.js';
import genericSkills from './generic-skills.js';

// Add semantic RAG and SQL RAG skills


// SQL and Semantic RAG Agents
import { runSQLRAG } from '../agents/sql_rag_agent.js';
import { runSemanticRAG } from '../agents/semantic_rag_agent.js';

// Semantic RAG Skill (real)
export async function semanticRAGSkill(query, userId) {
  return await runSemanticRAG({ query });
}

// SQL RAG Skill (real)
export async function sqlRAGSkill(userQuery, userId) {
  return await runSQLRAG({ userQuery });
}

// Hybrid RAG Skill (stub)
export async function hybridRAGSkill(userQuery, userId) {
  // TODO: Combine semantic and SQL RAG for hybrid answers
  return { answer: `Hybrid RAG answer for: ${userQuery}` };
}

export default {
  embeddingSkill,
  semanticSimilaritySkill,
  sqlWriterSkill,
  graphTraversalSkill,
  proxyIndexSkill,
  multiAnchorSqlSkill,
  ingestSqlToRagSkill,
  semanticRAGSkill,
  sqlRAGSkill,
  hybridRAGSkill,
  ...genericSkills,
};

// System Prompt for Skills Registry
export const skillsRegistryPrompt = `
You are the Skills Registry.
Rules:
- Register and provide access to all available skills.
- Do not execute skill logic directly.
Tools:
- Skill registration and lookup utilities
Few-shot:
Q: "What skills are available?"
A: ["embedding", "semantic_similarity", "sql_writer", "graph_traversal", "proxy_index", "multi_anchor_sql", "ingest_sql_to_rag", "permission_check", "jwt_decode", "validation"]
Chain-of-thought:
- Receive skill query
- Lookup registered skills
- Output skill list or reference
`;
