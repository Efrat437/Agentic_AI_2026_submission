from __future__ import annotations

from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from app.config import settings
from app.db import search_rules
from app.services.embedding_client import embed_text
from app.services.reasoning import llm_or_rule_based_recommendation
from app.services.rerank import CrossEncoderReranker
from app.services.rule_logic import (
    apply_priority_and_specificity,
    build_union_suggestion,
    classify_candidate,
    run_conflict_engine,
)
from app.services.rule_parser import parse_rule


reranker = CrossEncoderReranker(settings.cross_encoder_model)


class RuleState(TypedDict, total=False):
    rule_text: str
    should_create: bool
    top_k: int
    similarity_threshold: float
    country: str | None
    insurance_type: str | None
    active: bool | None
    parsed_rule: Any
    embedding: list[float]
    retrieved: list[dict[str, Any]]
    reranked: list[dict[str, Any]]
    resolved: list[dict[str, Any]]
    conflicted: list[dict[str, Any]]
    union_suggestion: str | None
    retrieval_layers: dict[str, int]
    recommendation: dict[str, Any]


async def parse_node(state: RuleState) -> RuleState:
    parsed = parse_rule(state["rule_text"])
    return {"parsed_rule": parsed}


async def embed_node(state: RuleState) -> RuleState:
    emb = await embed_text(state["parsed_rule"].canonical_text)
    return {"embedding": emb}


async def retrieve_node(state: RuleState) -> RuleState:
    raw = search_rules(
        embedding=state["embedding"],
        top_k=state.get("top_k") or settings.top_k,
        similarity_threshold=state.get("similarity_threshold") or settings.similarity_threshold,
        fields_filter=state["parsed_rule"].fields,
        country=state.get("country") or (state["parsed_rule"].countries[0] if state["parsed_rule"].countries else None),
        insurance_type=state.get("insurance_type") or state["parsed_rule"].insurance_type,
        active=state.get("active"),
    )
    threshold = float(state.get("similarity_threshold") or settings.similarity_threshold)
    retrieved = [r for r in raw if float(r.get("similarity", 0.0)) >= threshold]
    return {
        "retrieved": retrieved,
        "retrieval_layers": {
            "vector_retrieval": int(state.get("top_k") or settings.top_k),
            "metadata_filtered": len(raw),
            "threshold_filtered": len(retrieved),
        },
    }


async def rerank_node(state: RuleState) -> RuleState:
    candidates = reranker.rerank(state["parsed_rule"].canonical_text, state.get("retrieved", []))
    for c in candidates:
        tag, reason = classify_candidate(state["parsed_rule"], c)
        c["tag"] = tag.value
        c["reason"] = reason
    return {
        "reranked": candidates,
        "retrieval_layers": {
            **state.get("retrieval_layers", {}),
            "reranked": len(candidates),
        },
    }


async def resolve_node(state: RuleState) -> RuleState:
    resolved = apply_priority_and_specificity(state["parsed_rule"], list(state.get("reranked", [])))
    return {
        "resolved": resolved,
        "retrieval_layers": {
            **state.get("retrieval_layers", {}),
            "hierarchical_resolution": len(resolved),
        },
    }


async def conflict_node(state: RuleState) -> RuleState:
    conflicted = run_conflict_engine(list(state.get("resolved", [])))
    union_suggestion = build_union_suggestion(
        state["parsed_rule"],
        conflicted,
        threshold=settings.union_similarity_threshold,
    )
    return {
        "conflicted": conflicted,
        "union_suggestion": union_suggestion,
        "retrieval_layers": {
            **state.get("retrieval_layers", {}),
            "conflict_engine": len(conflicted),
        },
    }


async def reason_node(state: RuleState) -> RuleState:
    llm_candidates = list(state.get("conflicted", []))[: settings.llm_top_n]
    recommendation = await llm_or_rule_based_recommendation(
        parsed_rule={
            "raw_text": state["parsed_rule"].raw_text,
            "canonical_text": state["parsed_rule"].canonical_text,
            "action": state["parsed_rule"].action,
        },
        candidates=llm_candidates,
    )
    return {"recommendation": recommendation}


def build_graph():
    g = StateGraph(RuleState)
    g.add_node("parse", parse_node)
    g.add_node("embed", embed_node)
    g.add_node("retrieve", retrieve_node)
    g.add_node("rerank", rerank_node)
    g.add_node("resolve", resolve_node)
    g.add_node("conflict", conflict_node)
    g.add_node("reason", reason_node)

    g.add_edge(START, "parse")
    g.add_edge("parse", "embed")
    g.add_edge("embed", "retrieve")
    g.add_edge("retrieve", "rerank")
    g.add_edge("rerank", "resolve")
    g.add_edge("resolve", "conflict")
    g.add_edge("conflict", "reason")
    g.add_edge("reason", END)

    return g.compile()


graph_app = build_graph()
