from __future__ import annotations

import json
from pathlib import Path
import re

from app.db import next_rule_id, update_rule_by_rule_id, upsert_rule
from app.services.embedding_client import embed_text
from app.services.rule_parser import parse_rule


def _hierarchy_id(parsed_fields: list[str], action: str, rule_id: str) -> str:
    primary = parsed_fields[0] if parsed_fields else "unknown"
    return f"field:{primary}/action:{action}/rule:{rule_id}"


def _abbr(text: str, fallback: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "_", (text or "").lower()).strip("_")
    if not cleaned:
        return fallback
    return cleaned[:16].upper()


def _primary_field_token(parsed_fields: list[str]) -> str:
    if not parsed_fields:
        return "GEN"
    f = parsed_fields[0].lower()
    mapping = {
        "driver_age": "AGE",
        "driver_country": "COUNTRY",
        "coverage_tier": "COV",
        "fraud_risk_level": "FRAUD",
        "vehicle_class": "VEH",
    }
    return mapping.get(f, _abbr(f, "GEN"))


def build_smart_rule_id_components(parsed) -> dict[str, str]:
    insurance_type = _abbr(parsed.insurance_type or "GEN", "GEN")
    country = _abbr(parsed.countries[0] if parsed.countries else "GLB", "GLB")
    primary_field = _primary_field_token(parsed.fields)

    qualifier = "BASE"
    for c in parsed.conditions:
        if c.field == "driver_age" and c.op == "in_range":
            parts = [x.strip() for x in c.value.strip("[]").split(",") if x.strip()]
            if len(parts) == 2:
                qualifier = f"{parts[0]}_{parts[1]}".replace(".", "_")
                break
        if c.field == "driver_age" and c.op in {"in", "in_array"}:
            vals = [x.strip() for x in c.value.strip("[]").split(",") if x.strip()]
            if vals:
                qualifier = f"UNDER_{vals[0]}"
                break

    qualifier = _abbr(qualifier, "BASE")
    prefix = f"INS.{insurance_type}.{country}.{primary_field}.{qualifier}"
    return {
        "rule_family": "INS",
        "insurance_type": insurance_type,
        "country": country,
        "primary_field": primary_field,
        "qualifier": qualifier,
        "generated_rule_id_prefix": prefix,
        "generated_rule_id": next_rule_id(prefix),
    }


def build_structured_rule(rule_text: str) -> dict:
    parsed = parse_rule(rule_text)
    components = build_smart_rule_id_components(parsed)
    return {
        **components,
        "action": parsed.action,
        "conditions": [
            {"field": c.field, "op": c.op, "value": c.value}
            for c in parsed.conditions
        ],
    }


async def index_rule_text(
    rule_text: str,
    rule_id: str | None,
    source_type: str = "realtime",
    parent_rule: str | None = None,
    priority: int = 100,
    version: int = 1,
    active: bool = True,
) -> dict:
    parsed = parse_rule(rule_text)
    components = build_smart_rule_id_components(parsed)
    resolved_rule_id = rule_id or components["generated_rule_id"]
    embedding = await embed_text(parsed.canonical_text)
    payload = {
        "rule_id": resolved_rule_id,
        "parent_rule": parent_rule,
        "priority": int(priority),
        "version": int(version),
        "hierarchy_id": _hierarchy_id(parsed.fields, parsed.action, resolved_rule_id),
        "source_type": source_type,
        "active": bool(active),
        "country": parsed.countries[0] if parsed.countries else None,
        "insurance_type": parsed.insurance_type,
        "raw_text": parsed.raw_text,
        "canonical_text": parsed.canonical_text,
        "action": parsed.action,
        "fields": parsed.fields,
        "tags": ["normalized", source_type],
        "conditions_json": {
            "conditions": [
                {"field": c.field, "op": c.op, "value": c.value}
                for c in parsed.conditions
            ],
            "combinators": parsed.combinators,
        },
        "canonical_hash": parsed.canonical_hash,
        "embedding": embedding,
    }
    upsert_rule(payload)
    return payload


async def update_rule_text_by_id(
    rule_id: str,
    rule_text: str,
    source_type: str = "realtime_update",
    parent_rule: str | None = None,
    priority: int = 100,
    version: int = 1,
    active: bool = True,
) -> bool:
    parsed = parse_rule(rule_text)
    embedding = await embed_text(parsed.canonical_text)
    payload = {
        "rule_id": rule_id,
        "parent_rule": parent_rule,
        "priority": int(priority),
        "version": int(version),
        "hierarchy_id": _hierarchy_id(parsed.fields, parsed.action, rule_id),
        "source_type": source_type,
        "active": bool(active),
        "country": parsed.countries[0] if parsed.countries else None,
        "insurance_type": parsed.insurance_type,
        "raw_text": parsed.raw_text,
        "canonical_text": parsed.canonical_text,
        "action": parsed.action,
        "fields": parsed.fields,
        "tags": ["normalized", source_type],
        "conditions_json": {
            "conditions": [
                {"field": c.field, "op": c.op, "value": c.value}
                for c in parsed.conditions
            ],
            "combinators": parsed.combinators,
        },
        "canonical_hash": parsed.canonical_hash,
        "embedding": embedding,
    }
    return update_rule_by_rule_id(payload)


async def offline_index_from_jsonl(jsonl_path: Path) -> int:
    count = 0
    with jsonl_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            rule_id = item.get("id")
            text = item["text"]
            await index_rule_text(
                text,
                rule_id=rule_id,
                source_type="offline",
                parent_rule=item.get("parent_rule"),
                priority=int(item.get("priority", 100)),
                version=int(item.get("version", 1)),
                active=bool(item.get("active", True)),
            )
            count += 1
    return count
