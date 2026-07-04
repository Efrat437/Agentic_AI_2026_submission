// LangGraph-style orchestrator pipeline for receipt ingestion
import { extractReceiptData as xenovaAgent } from '../agents/vision_llm_xenova_agent.js';
import { extractReceiptData as nanoLLaVAAgent } from '../agents/vision_llm_nanollava_agent.js';
import { extractReceiptData as glm46vAgent } from '../agents/vision_llm_glm46v_agent.js';
import { extractReceiptData as qwen3vlAgent } from '../agents/vision_llm_qwen3vl_agent.js';
import { ocrAgent } from '../agents/ocr_agent.js';
import { metadataExtractorAgent } from '../agents/metadata_extractor_agent.js';
import { annotationAgent } from '../agents/annotation_agent.js';
import { scoringAgent } from '../agents/scoring_agent.js';
import { validatorAgent } from '../agents/validator_agent.js';
import { dbWriterAgent } from '../agents/db_writer_agent.js';
import crossEncoderRankingSkill from '../skills/cross_encoder_ranking_skill.js';

// System Prompt for LangGraph Orchestrator
export const langgraphOrchestratorPrompt = `
You are the LangGraph Orchestrator.
Rules:
- Orchestrate the receipt ingestion pipeline using modular agents and skills.
- Enforce permission checks at each stage.
Tools:
- All registered agents and skills
Few-shot:
Q: { "userId": 123, "image": "..." }
A: { "status": "success", "recordId": 456 }
Chain-of-thought:
- Receive input
- Route through agents (vision, ocr, metadata, annotation, scoring, validation, db write)
- Enforce permission checks
- Output final result
`;

export async function receiptIngestionPipeline(imagePath, context = {}) {
  // Run all open-source Vision LLM agents in parallel, plus OCR and metadata
  const [xenovaResult, nanoLLaVAResult, glm46vResult, qwen3vlResult, ocrResult, metaResult] = await Promise.all([
    xenovaAgent(imagePath),
    nanoLLaVAAgent(imagePath),
    glm46vAgent(imagePath),
    qwen3vlAgent(imagePath),
    ocrAgent(imagePath),
    metadataExtractorAgent(imagePath)
  ]);

  // Human-in-the-loop: if enabled, allow human to review/modify candidates before scoring
  let humanResult = null;
  if (context.humanInLoop && typeof context.getHumanInput === 'function') {
    humanResult = await context.getHumanInput([
      xenovaResult, nanoLLaVAResult, glm46vResult, qwen3vlResult, ocrResult
    ]);
  }

  // Collect all candidates
  const candidates = [];
  if (xenovaResult && !xenovaResult.error) candidates.push({ ...xenovaResult, source: 'xenova' });
  if (nanoLLaVAResult && !nanoLLaVAResult.error) candidates.push({ ...nanoLLaVAResult, source: 'nanollava' });
  if (glm46vResult && !glm46vResult.error) candidates.push({ ...glm46vResult, source: 'glm46v' });
  if (qwen3vlResult && !qwen3vlResult.error) candidates.push({ ...qwen3vlResult, source: 'qwen3vl' });
  if (ocrResult) candidates.push({ ...ocrResult, source: 'ocr' });
  if (humanResult) candidates.push({ ...humanResult, source: 'human' });

  // Add meta info to each candidate
  for (const c of candidates) {
    c.meta = metaResult;
  }

  // Score each candidate
  for (const c of candidates) {
    const scored = await scoringAgent(c);
    c.score = scored.score;
  }

  // Rank candidates using cross-encoder
  const ranked = await crossEncoderRankingSkill(candidates, context.userQuery || '');

  // Merge: unify fields if top two are confident, else use top-ranked
  let finalResult = ranked[0];
  if (ranked.length > 1 && ranked[0].score > 0.8 && ranked[1].score > 0.7) {
    // Unify fields: merge items, keep unique values, combine sources
    const mergedItems = Array.isArray(ranked[0].items) && Array.isArray(ranked[1].items)
      ? [...ranked[0].items]
      : [];
    if (Array.isArray(ranked[1].items)) {
      for (const item of ranked[1].items) {
        if (!mergedItems.some(i => i.name === item.name && i.price === item.price)) {
          mergedItems.push(item);
        }
      }
    }
    finalResult = {
      ...ranked[0],
      ...ranked[1],
      items: mergedItems.length > 0 ? mergedItems : (ranked[0].items || ranked[1].items),
      sources: [ranked[0].source, ranked[1].source],
      score: Math.max(ranked[0].score, ranked[1].score),
      crossEncoderScore: Math.max(ranked[0].crossEncoderScore, ranked[1].crossEncoderScore)
    };
  }

  // Validation (structure + permissions, with retry)
  let validated = await validatorAgent(finalResult, context);
  let retryCount = 0;
  while (!validated.valid && retryCount < 2) {
    retryCount++;
    // Optionally allow human-in-the-loop correction on validation failure
    if (context.humanInLoop && typeof context.getHumanInput === 'function') {
      const correction = await context.getHumanInput([finalResult]);
      if (correction) finalResult = correction;
    }
    validated = await validatorAgent(finalResult, context);
  }

  // DB Write
  const dbResult = await dbWriterAgent(validated);

  // State structure: keep all candidates for analytics/statistics
  const state = {
    userQuery: context.userQuery || null,
    candidates: ranked,
    final: finalResult,
    meta: metaResult,
    dbResult,
    agentRole: context.userRole || 'unknown',
    permissions: context.permissions || [],
    validation: validated,
    timestamp: Date.now(),
  };

  return state;
}
