from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.db import create_review_task, get_rule_by_rule_id, init_db, next_version_for_parent, resolve_review_task
from app.models.schemas import (
    CandidateRule,
    IngestResponse,
    MergeApprovedRequest,
    MergeApprovedResponse,
    RuleUpdateRequest,
    RuleUpdateResponse,
    ReviewTaskResponse,
    RuleAnalysisRequest,
    RuleAnalysisResponse,
    StructuredRuleModel,
)
from app.orchestration.graph import graph_app
from app.services.indexing import (
    build_structured_rule,
    index_rule_text,
    offline_index_from_jsonl,
    update_rule_text_by_id,
)

app = FastAPI(title="AI Rule Intelligence Platform", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup_event() -> None:
    init_db()


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/api/index/offline", response_model=IngestResponse)
async def index_offline() -> IngestResponse:
    base = Path(__file__).resolve().parents[1]
    jsonl_path = base / "seed" / "insurance_rules_dummy_100.jsonl"
    if not jsonl_path.exists():
        raise HTTPException(status_code=404, detail=f"Missing seed file: {jsonl_path}")
    count = await offline_index_from_jsonl(jsonl_path)
    return IngestResponse(indexed_count=count, status="ok")


@app.post("/api/rules/analyze", response_model=RuleAnalysisResponse)
async def analyze_rule(req: RuleAnalysisRequest) -> RuleAnalysisResponse:
    structured = build_structured_rule(req.rule_text)
    state = None
    last_error = None
    for attempt in range(1, 4):
        try:
            state = await graph_app.ainvoke(
                {
                    "rule_text": req.rule_text,
                    "should_create": req.should_create,
                    "top_k": req.top_k,
                    "similarity_threshold": req.similarity_threshold,
                    "country": req.country,
                    "insurance_type": req.insurance_type,
                    "active": req.active,
                }
            )
            break
        except Exception as exc:
            last_error = exc
            if attempt == 3:
                raise HTTPException(status_code=500, detail=f"analysis failed after retries: {exc}")
            await asyncio.sleep(0.2 * attempt)

    if state is None:
        raise HTTPException(status_code=500, detail=f"analysis failed: {last_error}")

    parsed = state["parsed_rule"]
    candidates = [
        CandidateRule(
            rule_id=c.get("rule_id"),
            parent_rule=c.get("parent_rule"),
            priority=int(c.get("priority", 100)),
            version=int(c.get("version", 1)),
            rule_text=c.get("raw_text", ""),
            canonical_text=c.get("canonical_text", ""),
            action=c.get("action", ""),
            similarity=float(c.get("similarity", 0.0)),
            rerank_score=float(c.get("rerank_score", 0.0)),
            specificity_score=float(c.get("specificity_score", 0.0)),
            priority_score=float(c.get("priority_score", 0.0)),
            final_score=float(c.get("final_score", 0.0)),
            tag=c.get("tag", "new_rule"),
            reason=c.get("reason", ""),
        )
        for c in state.get("conflicted", [])
    ]

    create_indexed = False
    hitl_review_id = None
    hitl_required = bool(state["recommendation"].get("hitl_required", False))
    hitl_reason = state["recommendation"].get("hitl_reason")

    if hitl_required:
        hitl_review_id = create_review_task(
            reason=str(hitl_reason or "Human review required"),
            payload={
                "rule_text": req.rule_text,
                "structured_rule": structured,
                "top_candidate": state.get("conflicted", [None])[0],
                "recommendation": state["recommendation"],
            },
        )

    recommendation = state["recommendation"].get("recommendation", "revise")
    if req.should_create and recommendation in {"approve", "revise"} and not hitl_required:
        await index_rule_text(
            req.rule_text,
            structured["generated_rule_id"],
            source_type="realtime",
            parent_rule=req.parent_rule,
            priority=int(req.priority_override or 100),
            version=1,
            active=bool(req.active if req.active is not None else True),
        )
        create_indexed = True

    return RuleAnalysisResponse(
        status="ok",
        recommendation=recommendation,
        summary=state["recommendation"].get("summary", ""),
        relationship_found=state["recommendation"].get("relationship_found"),
        top_match_rule_id=state["recommendation"].get("top_match_rule_id"),
        top_match_similarity=state["recommendation"].get("top_match_similarity"),
        action_recommendation=state["recommendation"].get("action_recommendation"),
        reasoning=state["recommendation"].get("reasoning"),
        recommendation_details=state["recommendation"].get("recommendation_details", ""),
        retrieval_layers=state.get("retrieval_layers", {}),
        parsed_rule={
            "raw_text": parsed.raw_text,
            "canonical_text": parsed.canonical_text,
            "action": parsed.action,
            "fields": parsed.fields,
            "countries": parsed.countries,
            "insurance_type": parsed.insurance_type,
            "specificity_score": parsed.specificity_score,
            "conditions": [
                {"field": c.field, "op": c.op, "value": c.value}
                for c in parsed.conditions
            ],
        },
        structured_rule=StructuredRuleModel(**structured),
        candidates=candidates,
        union_suggestion=state.get("union_suggestion"),
        hitl_required=hitl_required,
        hitl_reason=hitl_reason,
        hitl_review_id=hitl_review_id,
        create_indexed=create_indexed,
        # Chain-of-thought and context fields
        chain_of_thought=state["recommendation"].get("chain_of_thought"),
        request_context=state["recommendation"].get("request_context"),
        retrieval_context=state["recommendation"].get("retrieval_context"),
        analysis_context=state["recommendation"].get("analysis_context"),
        conflicts_context=state["recommendation"].get("conflicts_context"),
        decision_context=state["recommendation"].get("decision_context"),
        recommendations_context=state["recommendation"].get("recommendations_context"),
        audit_context=state["recommendation"].get("audit_context"),
    )


@app.post("/api/rules/merge/approved", response_model=MergeApprovedResponse)
async def merge_approved(req: MergeApprovedRequest) -> MergeApprovedResponse:
    source = get_rule_by_rule_id(req.source_rule_id)
    if not source:
        raise HTTPException(status_code=404, detail=f"source rule not found: {req.source_rule_id}")

    structured = build_structured_rule(req.merged_rule_text)
    next_version = next_version_for_parent(req.source_rule_id)
    await index_rule_text(
        req.merged_rule_text,
        structured["generated_rule_id"],
        source_type="human_approved_merge",
        parent_rule=req.source_rule_id,
        priority=int(req.priority_override or source.get("priority", 100)),
        version=next_version,
        active=bool(req.active),
    )
    return MergeApprovedResponse(
        status="ok",
        merged_rule_id=structured["generated_rule_id"],
        parent_rule=req.source_rule_id,
        version=next_version,
    )


@app.post("/api/rules/update", response_model=RuleUpdateResponse)
async def update_rule(req: RuleUpdateRequest) -> RuleUpdateResponse:
    source = get_rule_by_rule_id(req.rule_id)
    if not source:
        raise HTTPException(status_code=404, detail=f"rule not found: {req.rule_id}")

    updated = await update_rule_text_by_id(
        rule_id=req.rule_id,
        rule_text=req.rule_text,
        source_type="realtime_update",
        parent_rule=source.get("parent_rule"),
        priority=int(req.priority_override if req.priority_override is not None else source.get("priority", 100)),
        version=int(source.get("version", 1)),
        active=bool(req.active if req.active is not None else source.get("active", True)),
    )
    if not updated:
        raise HTTPException(status_code=500, detail=f"update failed for rule: {req.rule_id}")

    return RuleUpdateResponse(
        status="ok",
        rule_id=req.rule_id,
        updated=True,
        reason="Rule updated in table.",
    )


@app.post("/api/reviews/{review_id}/resolve", response_model=ReviewTaskResponse)
async def resolve_review(review_id: str, approved: bool) -> ReviewTaskResponse:
    status = "approved" if approved else "rejected"
    updated = resolve_review_task(review_id=review_id, status=status)
    if not updated:
        raise HTTPException(status_code=404, detail=f"review task not found: {review_id}")
    return ReviewTaskResponse(
        review_id=review_id,
        status=status,
        reason="Reviewed by human operator.",
    )
