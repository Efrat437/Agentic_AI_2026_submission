from __future__ import annotations

from typing import Any

from app.models.schemas import MatchTag
from app.services.rule_parser import ParsedRule


SEVERITY_ORDER = {
    "approve_standard": 1,
    "apply_discount": 2,
    "increase_premium": 3,
    "require_underwriting": 4,
    "decline": 5,
}


def _parse_set(v: str) -> set[str]:
    return {x.strip() for x in v.strip("[]").split(",") if x.strip()}


def _parse_range(v: str) -> tuple[float, float] | None:
    try:
        parts = [p.strip() for p in v.strip("[]").split(",")]
        if len(parts) != 2:
            return None
        return float(parts[0]), float(parts[1])
    except Exception:
        return None


def _is_contained(query_conditions: list[dict[str, str]], existing_conditions: list[dict[str, str]]) -> bool:
    existing_map = {(c["field"], c["op"]): c["value"] for c in existing_conditions}
    for qc in query_conditions:
        key = (qc["field"], qc["op"])
        if key not in existing_map:
            return False
        ev = existing_map[key]
        if qc["op"] in {"in", "in_array", "not_in"}:
            if not _parse_set(qc["value"]).issubset(_parse_set(ev)):
                return False
        elif qc["op"] == "in_range":
            q_range = _parse_range(qc["value"])
            e_range = _parse_range(ev)
            if not q_range or not e_range:
                return False
            if q_range[0] < e_range[0] or q_range[1] > e_range[1]:
                return False
        else:
            if qc["value"] != ev:
                return False
    return True


def classify_candidate(parsed: ParsedRule, candidate: dict[str, Any]) -> tuple[MatchTag, str]:
    candidate_conditions = candidate["conditions_json"]["conditions"]
    query_conditions = [
        {"field": c.field, "op": c.op, "value": c.value}
        for c in parsed.conditions
    ]

    similarity = float(candidate.get("similarity", 0.0))
    fields_overlap = bool(set(candidate.get("fields", [])) & set(parsed.fields))

    if candidate["canonical_text"] == parsed.canonical_text:
        if candidate["action"] == parsed.action:
            return MatchTag.EXACT_DUPLICATE, "Exact normalized rule already exists"
        return MatchTag.CONTRADICTION, "Same condition footprint but conflicting action"

    if _is_contained(query_conditions, candidate_conditions) and candidate["action"] == parsed.action:
        return MatchTag.CONTAINED_BY, "New rule is already covered by an existing broader rule"

    if _is_contained(candidate_conditions, query_conditions) and candidate["action"] == parsed.action:
        return MatchTag.CONTAINS_EXISTING, "New rule is broader and contains existing rule context"

    if _is_contained(candidate_conditions, query_conditions) and candidate["action"] != parsed.action:
        return MatchTag.CONTRADICTION, "Broader/narrower conflict with action mismatch"

    sev_q = SEVERITY_ORDER.get(parsed.action, 0)
    sev_c = SEVERITY_ORDER.get(candidate["action"], 0)
    if abs(sev_q - sev_c) >= 2:
        return MatchTag.CONTRADICTION, "Semantically close but materially conflicting severity"
    if abs(sev_q - sev_c) == 1 and fields_overlap:
        return MatchTag.COMPLEMENTS, "Rules are related and can complement in layered policy design"
    if similarity >= 0.8 and fields_overlap:
        return MatchTag.HIGH_SIMILARITY, "High semantic similarity likely indicates near-duplicate/override"
    if not fields_overlap:
        return MatchTag.DIFFERENT_CONTEXT, "Different business context/feature space"

    return MatchTag.NEW_RULE, "No strong conflict or containment found"


def _candidate_specificity(candidate: dict[str, Any]) -> float:
    conditions = candidate.get("conditions_json", {}).get("conditions", [])
    if not conditions:
        return 0.0
    score = 0.0
    for c in conditions:
        op = c.get("op", "")
        value = c.get("value", "")
        if op in {"in", "in_array", "not_in", "in_range"} and isinstance(value, str) and value.startswith("["):
            size = max(len(_parse_set(value)), 1)
            score += 1.0 / size
        else:
            score += 1.0
    return float(score + len(conditions) * 0.2)


def apply_priority_and_specificity(parsed: ParsedRule, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    prioritized = []
    for c in candidates:
        priority = int(c.get("priority", 100))
        priority_score = 1.0 / (1.0 + max(priority, 0))
        specificity_score = _candidate_specificity(c)
        rerank_score = float(c.get("rerank_score", 0.0))
        similarity = float(c.get("similarity", 0.0))
        final_score = (rerank_score * 0.55) + (similarity * 0.25) + (specificity_score * 0.15) + (priority_score * 0.05)
        c["priority_score"] = float(priority_score)
        c["specificity_score"] = float(specificity_score)
        c["final_score"] = float(final_score)
        prioritized.append(c)
    prioritized.sort(key=lambda x: x["final_score"], reverse=True)
    return prioritized


def run_conflict_engine(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # Escalate contradictions in sorting while preserving score.
    blocker_tags = {
        MatchTag.EXACT_DUPLICATE.value,
        MatchTag.CONTRADICTION.value,
        MatchTag.CONTAINED_BY.value,
    }
    blockers = [c for c in candidates if c.get("tag") in blocker_tags]
    non_blockers = [c for c in candidates if c.get("tag") not in blocker_tags]
    return blockers + non_blockers


def build_union_suggestion(parsed: ParsedRule, candidates: list[dict[str, Any]], threshold: float) -> str | None:
    similar = [c for c in candidates if float(c.get("similarity", 0.0)) >= threshold and c.get("action") == parsed.action]
    if len(similar) < 2:
        return None
    texts = [c.get("raw_text", "") for c in similar[:3] if c.get("raw_text")]
    if not texts:
        return None
    return "Possible union candidate: " + " | ".join(texts)


def relationship_label_for_summary(tag: str) -> str:
    if tag == MatchTag.EXACT_DUPLICATE.value:
        return "probably duplicate"
    if tag == MatchTag.HIGH_SIMILARITY.value:
        return "possible override"
    if tag == MatchTag.CONTRADICTION.value:
        return "contradiction risk"
    if tag == MatchTag.CONTAINED_BY.value:
        return "already covered"
    if tag == MatchTag.CONTAINS_EXISTING.value:
        return "broader rule"
    if tag == MatchTag.COMPLEMENTS.value:
        return "complement"
    if tag == MatchTag.DIFFERENT_CONTEXT.value:
        return "different context"
    return "new pattern"
