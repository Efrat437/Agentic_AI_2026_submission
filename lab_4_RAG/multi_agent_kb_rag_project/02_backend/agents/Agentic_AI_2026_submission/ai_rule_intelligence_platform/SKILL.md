# Rule Relationship Analyzer Skill

## name
Rule Relationship Analyzer and HITL Merge Governance

## description
Analyze insurance rules against existing policy memory, classify relationship type, generate recommendation, trigger human review for medium-confidence overlaps, and support controlled human-approved merge.

## example pattern
Input rule:
if driver_country is israel and driver_age in_range [18,24] then increase_premium

Expected relationship sample:
- rule 102: 92% similarity -> high_similarity (probably duplicate)
- rule 77: 78% similarity -> contains_existing (possible override)
- rule 45: 65% similarity -> contradiction

Final recommendation sample:
Do not create new rule, update rule 102.

## validation
- Rule text must follow: if <conditions> then <action>
- Action must be one of approved underwriting actions.
- Condition syntax must use supported operators.
- Conflicting conditions in the same rule are rejected.

## rules
- If exact_duplicate or contained_by or contradiction at high confidence: reject create.
- If high_similarity without contradiction: revise/update preferred.
- If 0.65 < max_similarity < 0.8: route to HITL reviewer.
- If no significant overlap: allow new_rule path.

## dependency
- FastAPI service endpoints
- pgvector retrieval store
- Cross-encoder reranker
- Embedding server
- Postgres review task table

## check
- Analyze response contains `structured_rule` JSON.
- Analyze response contains `retrieval_layers` diagnostics.
- Analyze response contains relationship tags from required taxonomy.
- HITL fields present when similarity enters review band.

## steps
1. Parse and normalize incoming rule.
2. Generate smart structured rule id prefix.
3. Retrieve top-k vectors with metadata filters.
4. Rerank and classify relationship for each candidate.
5. Produce recommendation details and optional HITL task.
6. On human approval, merge through controlled endpoint.

## instructions
- Keep recommendation deterministic when LLM is unavailable.
- Never auto-merge without explicit human approval endpoint call.
- Preserve parent_rule/version lineage on merges.

## scripts if needed
- Offline index: POST /api/index/offline
- Analyze: POST /api/rules/analyze
- Resolve review: POST /api/reviews/{review_id}/resolve?approved=true|false
- Apply approved merge: POST /api/rules/merge/approved
