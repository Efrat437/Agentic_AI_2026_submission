// Orchestrator: runs the full multi-branch pipeline
import { ocrAgent } from './ocr_agent.js';
import { visionLLMAgent } from './vision_llm_agent.js';
import { visionLLMOpenAIAgent } from './vision_llm_openai_agent.js';
import { visionLLMGeminiAgent } from './vision_llm_gemini_agent.js';
import { visionLLMClaudeAgent } from './vision_llm_claude_agent.js';
import { metadataExtractorAgent } from './metadata_extractor_agent.js';
import { annotationAgent } from './annotation_agent.js';
import { scoringAgent } from './scoring_agent.js';
import { validatorAgent } from './validator_agent.js';
import { mergingAgent } from './merging_agent.js';
import { writePool } from '../db/db.js';

// Consensus merging: prefer value if both agree, else use OCR if VisionLLM is missing, else VisionLLM
function consensusMerge(ocr, vision) {
  const result = {};
  for (const key of ['total', 'currency', 'date', 'category']) {
    if (ocr[key] && vision[key] && ocr[key] === vision[key]) {
      result[key] = ocr[key];
    } else if (ocr[key]) {
      result[key] = ocr[key];
    } else if (vision[key]) {
      result[key] = vision[key];
    } else {
      result[key] = null;
    }
  }
  result.items = ocr.items && ocr.items.length ? ocr.items : (vision.items || []);
  result.sources = [ocr.source, vision.source];
  result.raw_text = ocr.raw_text || vision.raw_text;
  return result;
}

// Simple in-memory buffer
const buffer = [];

// Analytics hook (logs to console, extend as needed)
function analyticsHook(result) {
  console.log('[Analytics] Final result:', result);
}

// Retry and human-in-the-loop
async function validateWithRetry(scored, context, maxRetries = 2) {
  let attempts = 0;
  let lastError = null;
  while (attempts <= maxRetries) {
    try {
      return await validatorAgent(scored, context);
    } catch (e) {
      lastError = e;
      attempts++;
    }
  }
  // Flag for human review (add to buffer)
  buffer.push({ ...scored, humanReview: true, error: lastError?.message });
  return { ...scored, validationError: lastError?.message, humanReview: true };
}

// DB write
async function writeToDB(result) {
  try {
    await writePool.query(
      'INSERT INTO receipts (date, total, currency, category, items, meta) VALUES ($1, $2, $3, $4, $5, $6)',
      [result.date, result.total, result.currency, result.category, JSON.stringify(result.items), JSON.stringify(result.meta)]
    );
    return true;
  } catch (e) {
    console.error('[DB Write Error]', e.message);
    return false;
  }
}

export async function runFullPipeline(imagePath, context = {}) {
  // 1. Parallel branches (OCR, all Vision LLMs, metadata)
  const [
    ocrResult,
    visionResult,
    visionOpenAIResult,
    visionGeminiResult,
    visionClaudeResult,
    metaResult
  ] = await Promise.all([
    ocrAgent(imagePath),
    visionLLMAgent(imagePath),
    visionLLMOpenAIAgent(imagePath),
    visionLLMGeminiAgent(imagePath),
    visionLLMClaudeAgent(imagePath),
    metadataExtractorAgent(imagePath)
  ]);

  // 2. Collect all Vision LLM results for comparison/logging
  const visionLLMResults = [visionResult, visionOpenAIResult, visionGeminiResult, visionClaudeResult].filter(Boolean);
  console.log('[Vision LLM Comparison]', visionLLMResults.map(r => ({ provider: r.provider, total: r.total, currency: r.currency, date: r.date })));

  // 3. Consensus merge (use all Vision LLMs and OCR)
  // For now, merge OCR and the first available Vision LLM (backward compatible)
  const mergedResult = consensusMerge(ocrResult, visionResult);
  mergedResult.meta = metaResult;
  mergedResult.visionLLMComparisons = visionLLMResults;

  // 4. Annotation
  const annotated = await annotationAgent({ visionResult, ocrResult, metaResult });

  // 5. Scoring
  const scored = await scoringAgent(annotated);

  // 6. Validation + Retry + Human-in-the-loop
  const validated = await validateWithRetry(scored, context, 2);

  // 7. Merging (single candidate for now, but can extend to multiple)
  const finalMerged = await mergingAgent([validated, mergedResult]);

  // 8. DB Write (if valid and not human review)
  if (!finalMerged.validationError && !finalMerged.humanReview) {
    await writeToDB(finalMerged);
  }

  // 9. Buffer (cache)
  buffer.push(finalMerged);

  // 10. Analytics
  analyticsHook(finalMerged);

  return finalMerged;
}
