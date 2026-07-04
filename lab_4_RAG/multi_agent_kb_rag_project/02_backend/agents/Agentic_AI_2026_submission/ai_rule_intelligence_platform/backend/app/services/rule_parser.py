from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass


CLAUSE_SPLIT_RE = re.compile(r"\s+(and|or)\s+", re.IGNORECASE)
COND_RE = re.compile(
    r"^\s*(?P<field>[a-zA-Z0-9_]+)\s+(?P<op>is|in|in_array|in_list|in_range|not_in)\s+(?P<value>.+?)\s*$",
    re.IGNORECASE,
)


@dataclass
class ParsedCondition:
    field: str
    op: str
    value: str


@dataclass
class ParsedRule:
    raw_text: str
    action: str
    conditions: list[ParsedCondition]
    combinators: list[str]
    canonical_text: str
    canonical_hash: str
    fields: list[str]
    countries: list[str]
    insurance_type: str | None
    specificity_score: float


ALLOWED_ACTIONS = {
    "approve_standard",
    "increase_premium",
    "apply_discount",
    "require_underwriting",
    "decline",
}


def _parse_set(value: str) -> list[str]:
    return [x.strip() for x in value.strip("[]").split(",") if x.strip()]


def _normalize_value(op: str, value: str) -> str:
    value = value.strip().lower()
    if op == "is":
        return value
    if op in {"in", "in_array", "not_in", "in_range"}:
        value = value.strip("[]")
        parts = [p.strip().lower() for p in value.split(",") if p.strip()]
        if op != "in_range":
            parts = sorted(set(parts))
        return "[" + ",".join(parts) + "]"
    if op == "in_list":
        return value.replace(" ", "_")
    return value


def _canonical_condition(condition: ParsedCondition) -> str:
    return f"{condition.field} {condition.op} {condition.value}"


def parse_rule(rule_text: str) -> ParsedRule:
    raw = rule_text.strip()
    rule_l = raw.lower()
    if not rule_l.startswith("if ") or " then " not in rule_l:
        raise ValueError("Rule format must be: if <conditions> then <action>")

    head, action = re.split(r"\s+then\s+", rule_l, maxsplit=1)
    action = action.strip()
    if action not in ALLOWED_ACTIONS:
        raise ValueError(f"Unsupported action: {action}")
    cond_part = head[3:].strip()

    chunks = CLAUSE_SPLIT_RE.split(cond_part)
    conditions: list[ParsedCondition] = []
    combinators: list[str] = []

    for idx, chunk in enumerate(chunks):
        if idx % 2 == 1:
            combinators.append(chunk.lower())
            continue
        m = COND_RE.match(chunk)
        if not m:
            raise ValueError(f"Invalid condition: {chunk}")
        field = m.group("field").lower()
        op = m.group("op").lower()
        value = _normalize_value(op, m.group("value"))
        if op == "is":
            op = "in"
            value = f"[{value}]"
        conditions.append(ParsedCondition(field=field, op=op, value=value))

    ordered = sorted(conditions, key=lambda c: (c.field, c.op, c.value))

    # Validation: avoid contradictory same-field conditions in one rule body.
    seen = {}
    for c in ordered:
        key = (c.field, c.op)
        if key in seen and seen[key] != c.value:
            raise ValueError(f"Conflicting conditions for {c.field} with operator {c.op}")
        seen[key] = c.value

    canonical_conditions = " and ".join(_canonical_condition(c) for c in ordered)
    canonical_text = f"if {canonical_conditions} then {action}"
    canonical_hash = hashlib.sha256(canonical_text.encode("utf-8")).hexdigest()
    fields = sorted({c.field for c in conditions})

    countries: set[str] = set()
    insurance_type = None
    for c in ordered:
        if c.field == "driver_country":
            if c.op in {"in", "in_array", "not_in"}:
                countries.update(_parse_set(c.value))
            elif c.op == "in_list":
                countries.add(c.value)
        if c.field == "coverage_tier":
            vals = _parse_set(c.value) if c.value.startswith("[") else [c.value]
            if vals:
                insurance_type = vals[0]

    # Specificity estimate inspired by rule-system literature:
    # more conditions + narrower operators + explicit literals => higher specificity.
    op_weight = {"in": 1.0, "in_array": 1.1, "in_list": 0.8, "in_range": 0.9, "not_in": 0.95}
    specificity = 0.0
    for c in ordered:
        w = op_weight.get(c.op, 1.0)
        if c.op in {"in", "in_array", "not_in", "in_range"}:
            size = max(len(_parse_set(c.value)), 1)
            specificity += w * (1.0 / size)
        else:
            specificity += w
    specificity += len(ordered) * 0.2

    return ParsedRule(
        raw_text=raw,
        action=action,
        conditions=conditions,
        combinators=combinators,
        canonical_text=canonical_text,
        canonical_hash=canonical_hash,
        fields=fields,
        countries=sorted(countries),
        insurance_type=insurance_type,
        specificity_score=round(float(specificity), 6),
    )
