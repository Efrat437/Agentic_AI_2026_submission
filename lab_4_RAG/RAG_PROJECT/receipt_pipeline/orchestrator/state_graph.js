// LangGraph-style orchestrator for receipt pipeline
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { visionAgentXenova } from '../agents/vision_llm_xenova_agent.js';
import { visionAgentNanoLLaVA } from '../agents/vision_llm_nanollava_agent.js';
import { visionAgentGLM46V } from '../agents/vision_llm_glm46v_agent.js';
import { visionAgentQwen3VL } from '../agents/vision_llm_qwen3vl_agent.js';
import { ocrFallbackAgent } from '../agents/ocr_fallback_agent.js';
import { validatorAgent } from '../agents/validator_agent.js';
import { dbWriterAgent } from '../agents/db_writer_agent.js';
import { analyticsAgent } from '../agents/analytics_agent.js';

// 1. State definition
const StateAnnotation = Annotation.Root({
  imagePath: Annotation(),
  userId: Annotation(),
  extracted: Annotation(),
  validated: Annotation(),
  dbResult: Annotation(),
  analytics: Annotation(),
  error: Annotation(),
});

// 2. Node functions
const nodes = {
  xenova: async (state) => visionAgentXenova.run(state),
  nanollava: async (state) => visionAgentNanoLLaVA.run(state),
  glm46v: async (state) => visionAgentGLM46V.run(state),
  qwen3vl: async (state) => visionAgentQwen3VL.run(state),
  ocr: async (state) => ocrFallbackAgent.run(state),
  validate: async (state) => validatorAgent.run(state),
  db: async (state) => dbWriterAgent.run(state),
  analytics: async (state) => analyticsAgent.run(state),
};

// 3. Graph construction
export function createReceiptGraph() {
  return new StateGraph(StateAnnotation)
    .addNode('xenova', nodes.xenova)
    .addNode('nanollava', nodes.nanollava)
    .addNode('glm46v', nodes.glm46v)
    .addNode('qwen3vl', nodes.qwen3vl)
    .addNode('ocr', nodes.ocr)
    .addNode('validate', nodes.validate)
    .addNode('db', nodes.db)
    .addNode('analytics', nodes.analytics)
    .addEdge(START, 'xenova')
    .addEdge(START, 'nanollava')
    .addEdge(START, 'glm46v')
    .addEdge(START, 'qwen3vl')
    .addEdge('xenova', 'validate')
    .addEdge('nanollava', 'validate')
    .addEdge('glm46v', 'validate')
    .addEdge('qwen3vl', 'validate')
    .addEdge('validate', 'ocr') // fallback if needed
    .addEdge('validate', 'db')
    .addEdge('db', 'analytics')
    .addEdge('analytics', END)
    .compile();
}
