from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class MatchTag(str, Enum):
    EXACT_DUPLICATE = "exact_duplicate"
    HIGH_SIMILARITY = "high_similarity"
    CONTAINED_BY = "contained_by"
    CONTAINS_EXISTING = "contains_existing"
    CONTRADICTION = "contradiction"
    COMPLEMENTS = "complements"
    DIFFERENT_CONTEXT = "different_context"
    NEW_RULE = "new_rule"


class RuleAnalysisRequest(BaseModel):
    rule_text: str = Field(min_length=8)
    should_create: bool = False
    top_k: int | None = None
    similarity_threshold: float | None = None
    country: str | None = None
    insurance_type: str | None = None
    active: bool | None = True
    priority_override: int | None = None
    parent_rule: str | None = None


class StructuredRuleModel(BaseModel):
    rule_family: str
    insurance_type: str
    country: str
    primary_field: str
    qualifier: str
    generated_rule_id_prefix: str
    generated_rule_id: str
    action: str
    conditions: list[dict[str, str]]


class CandidateRule(BaseModel):
    rule_id: str | None = None
    parent_rule: str | None = None
    priority: int
    version: int
    rule_text: str
    canonical_text: str
    action: str
    similarity: float
    rerank_score: float
    specificity_score: float
    priority_score: float
    final_score: float
    tag: MatchTag
    reason: str


class ChainOfThoughtRequest(BaseModel):
    rule_text: str
    top_k: int
    similarity_threshold: float
    metadata_filters: dict[str, Any]


class ChainOfThoughtRetrieval(BaseModel):
    vector_candidates_count: int
    metadata_filtered_count: int
    threshold_filtered_count: int
    reranked_count: int
    final_candidate_count: int
    top_scores: list[float]


class ChainOfThoughtAnalysis(BaseModel):
    total_candidates_analyzed: int
    relationships_found: dict[str, int]
    severity_differences: list[dict[str, Any]]
    specificity_comparisons: list[dict[str, Any]]
    action_compatibility: dict[str, Any]


class ChainOfThoughtConflict(BaseModel):
    conflict_type: str
    conflicting_rules: list[str]
    severity_delta: float | None = None
    scope_overlap: float | None = None
    recommendation_impact: str


class ChainOfThoughtDecision(BaseModel):
    reasoning_chain: list[str]
    decision_criteria: dict[str, Any]
    confidence_score: float
    hitl_triggered: bool
    hitl_trigger_reason: str | None = None


class ChainOfThoughtRecommendation(BaseModel):
    primary: str
    alternatives: list[str]
    confidence: float
    action: str
    target_rule: str | None = None


class ChainOfThoughtAudit(BaseModel):
    timestamp: str
    operation: str
    user: str | None = None
    input_hash: str
    output_hash: str
    processing_time_ms: float
    events: list[dict[str, Any]]


class RuleAnalysisResponse(BaseModel):
    status: str
    recommendation: str
    summary: str
    relationship_found: str | None = None
    top_match_rule_id: str | None = None
    top_match_similarity: float | None = None
    action_recommendation: str | None = None
    reasoning: str | None = None
    recommendation_details: str
    retrieval_layers: dict[str, int]
    parsed_rule: dict[str, Any]
    structured_rule: StructuredRuleModel
    candidates: list[CandidateRule]
    union_suggestion: str | None = None
    hitl_required: bool = False
    hitl_reason: str | None = None
    hitl_review_id: str | None = None
    create_indexed: bool = False
    # Chain of thought analysis
    chain_of_thought: dict[str, Any] | None = None
    request_context: ChainOfThoughtRequest | None = None
    retrieval_context: ChainOfThoughtRetrieval | None = None
    analysis_context: ChainOfThoughtAnalysis | None = None
    conflicts_context: list[ChainOfThoughtConflict] | None = None
    decision_context: ChainOfThoughtDecision | None = None
    recommendations_context: list[ChainOfThoughtRecommendation] | None = None
    audit_context: ChainOfThoughtAudit | None = None


class IngestResponse(BaseModel):
    indexed_count: int
    status: str


class MergeApprovedRequest(BaseModel):
    source_rule_id: str = Field(min_length=2)
    merged_rule_text: str = Field(min_length=8)
    reviewer: str = Field(min_length=2)
    priority_override: int | None = None
    active: bool = True


class MergeApprovedResponse(BaseModel):
    status: str
    merged_rule_id: str
    parent_rule: str
    version: int


class RuleUpdateRequest(BaseModel):
    rule_id: str = Field(min_length=2)
    rule_text: str = Field(min_length=8)
    priority_override: int | None = None
    active: bool | None = None


class RuleUpdateResponse(BaseModel):
    status: str
    rule_id: str
    updated: bool
    reason: str | None = None


class ReviewTaskResponse(BaseModel):
    review_id: str
    status: str
    reason: str
