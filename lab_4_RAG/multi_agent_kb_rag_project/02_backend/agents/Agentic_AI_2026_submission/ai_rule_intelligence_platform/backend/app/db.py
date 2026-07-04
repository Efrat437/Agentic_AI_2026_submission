from __future__ import annotations

import json
from contextlib import contextmanager
from uuid import uuid4
from typing import Any, Iterable

import psycopg

from app.config import settings


@contextmanager
def get_conn():
    conn = psycopg.connect(settings.database_url)
    try:
        yield conn
    finally:
        conn.close()


def init_db() -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
            cur.execute(
                f"""
                CREATE TABLE IF NOT EXISTS rules (
                    id BIGSERIAL PRIMARY KEY,
                    rule_id TEXT UNIQUE,
                    parent_rule TEXT,
                    priority INTEGER NOT NULL DEFAULT 100,
                    version INTEGER NOT NULL DEFAULT 1,
                    hierarchy_id TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    active BOOLEAN NOT NULL DEFAULT TRUE,
                    country TEXT,
                    insurance_type TEXT,
                    raw_text TEXT NOT NULL,
                    canonical_text TEXT NOT NULL,
                    action TEXT NOT NULL,
                    fields TEXT[] NOT NULL,
                    tags TEXT[] NOT NULL,
                    conditions_json JSONB NOT NULL,
                    canonical_hash TEXT NOT NULL UNIQUE,
                    embedding VECTOR({settings.embedding_dim}) NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS review_tasks (
                    review_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    payload JSONB NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                )
                """
            )
            cur.execute("ALTER TABLE rules ADD COLUMN IF NOT EXISTS parent_rule TEXT")
            cur.execute("ALTER TABLE rules ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 100")
            cur.execute("ALTER TABLE rules ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1")
            cur.execute("ALTER TABLE rules ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE")
            cur.execute("ALTER TABLE rules ADD COLUMN IF NOT EXISTS country TEXT")
            cur.execute("ALTER TABLE rules ADD COLUMN IF NOT EXISTS insurance_type TEXT")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_rules_action ON rules(action)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_rules_parent_rule ON rules(parent_rule)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_rules_priority ON rules(priority)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_rules_version ON rules(version)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_rules_active ON rules(active)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_rules_country ON rules(country)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_rules_insurance_type ON rules(insurance_type)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_review_tasks_status ON review_tasks(status)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_rules_fields ON rules USING GIN(fields)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_rules_tags ON rules USING GIN(tags)")
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_rules_embedding ON rules USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)"
            )
            conn.commit()


def next_rule_id(prefix: str) -> str:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COALESCE(MAX(CAST(RIGHT(rule_id, 3) AS INTEGER)), 0)
                FROM rules
                WHERE rule_id LIKE %(prefix_like)s
                  AND rule_id ~ %(pattern)s
                """,
                {
                    "prefix_like": f"{prefix}.%",
                    "pattern": f"^{prefix}\\.[0-9]{{3}}$",
                },
            )
            max_suffix = cur.fetchone()[0] or 0
    return f"{prefix}.{int(max_suffix) + 1:03d}"


def get_rule_by_rule_id(rule_id: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
            cur.execute(
                """
                SELECT rule_id, parent_rule, priority, version, raw_text, canonical_text, action,
                       fields, tags, conditions_json, active, country, insurance_type
                FROM rules
                WHERE rule_id = %(rule_id)s
                LIMIT 1
                """,
                {"rule_id": rule_id},
            )
            return cur.fetchone()


def next_version_for_parent(parent_rule: str) -> int:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COALESCE(MAX(version), 0)
                FROM rules
                WHERE rule_id = %(rule_id)s OR parent_rule = %(rule_id)s
                """,
                {"rule_id": parent_rule},
            )
            max_version = cur.fetchone()[0] or 0
    return int(max_version) + 1


def create_review_task(reason: str, payload: dict[str, Any]) -> str:
    review_id = f"rev_{uuid4().hex[:12]}"
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO review_tasks (review_id, status, reason, payload)
                VALUES (%(review_id)s, 'pending', %(reason)s, %(payload)s::jsonb)
                """,
                {
                    "review_id": review_id,
                    "reason": reason,
                    "payload": json.dumps(payload),
                },
            )
            conn.commit()
    return review_id


def resolve_review_task(review_id: str, status: str, payload: dict[str, Any] | None = None) -> bool:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE review_tasks
                SET status = %(status)s,
                    payload = COALESCE(%(payload)s::jsonb, payload),
                    updated_at = NOW()
                WHERE review_id = %(review_id)s
                """,
                {
                    "status": status,
                    "payload": json.dumps(payload) if payload is not None else None,
                    "review_id": review_id,
                },
            )
            updated = cur.rowcount > 0
            conn.commit()
            return updated


def _vector_literal(values: Iterable[float]) -> str:
    return "[" + ",".join(f"{float(x):.8f}" for x in values) + "]"


def upsert_rule(row: dict[str, Any]) -> None:
    normalized_row = {
        "parent_rule": None,
        "priority": 100,
        "version": 1,
        "active": True,
        "country": None,
        "insurance_type": None,
        **row,
    }
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO rules (
                    rule_id, parent_rule, priority, version, hierarchy_id, source_type, active, country, insurance_type,
                    raw_text, canonical_text, action,
                    fields, tags, conditions_json, canonical_hash, embedding
                ) VALUES (
                    %(rule_id)s, %(parent_rule)s, %(priority)s, %(version)s, %(hierarchy_id)s, %(source_type)s, %(active)s,
                    %(country)s, %(insurance_type)s, %(raw_text)s, %(canonical_text)s, %(action)s,
                    %(fields)s, %(tags)s, %(conditions_json)s, %(canonical_hash)s, %(embedding)s::vector
                )
                ON CONFLICT (canonical_hash)
                DO UPDATE SET
                    parent_rule = EXCLUDED.parent_rule,
                    priority = EXCLUDED.priority,
                    version = EXCLUDED.version,
                    active = EXCLUDED.active,
                    country = EXCLUDED.country,
                    insurance_type = EXCLUDED.insurance_type,
                    raw_text = EXCLUDED.raw_text,
                    canonical_text = EXCLUDED.canonical_text,
                    action = EXCLUDED.action,
                    fields = EXCLUDED.fields,
                    tags = EXCLUDED.tags,
                    conditions_json = EXCLUDED.conditions_json,
                    embedding = EXCLUDED.embedding::vector
                """,
                {
                    **normalized_row,
                    "conditions_json": json.dumps(normalized_row["conditions_json"]),
                    "embedding": _vector_literal(normalized_row["embedding"]),
                },
            )
            conn.commit()


def update_rule_by_rule_id(row: dict[str, Any]) -> bool:
    normalized_row = {
        "parent_rule": None,
        "priority": 100,
        "version": 1,
        "active": True,
        "country": None,
        "insurance_type": None,
        **row,
    }
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE rules
                SET
                    parent_rule = %(parent_rule)s,
                    priority = %(priority)s,
                    version = %(version)s,
                    hierarchy_id = %(hierarchy_id)s,
                    source_type = %(source_type)s,
                    active = %(active)s,
                    country = %(country)s,
                    insurance_type = %(insurance_type)s,
                    raw_text = %(raw_text)s,
                    canonical_text = %(canonical_text)s,
                    action = %(action)s,
                    fields = %(fields)s,
                    tags = %(tags)s,
                    conditions_json = %(conditions_json)s::jsonb,
                    canonical_hash = %(canonical_hash)s,
                    embedding = %(embedding)s::vector
                WHERE rule_id = %(rule_id)s
                """,
                {
                    **normalized_row,
                    "conditions_json": json.dumps(normalized_row["conditions_json"]),
                    "embedding": _vector_literal(normalized_row["embedding"]),
                },
            )
            updated = cur.rowcount > 0
            conn.commit()
            return updated


def search_rules(
    embedding: list[float],
    top_k: int,
    similarity_threshold: float,
    fields_filter: list[str] | None = None,
    country: str | None = None,
    insurance_type: str | None = None,
    active: bool | None = True,
) -> list[dict[str, Any]]:
    fields_filter = fields_filter or []
    with get_conn() as conn:
        with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
            if fields_filter:
                cur.execute(
                    """
                    SELECT
                        rule_id,
                        parent_rule,
                        priority,
                        version,
                        hierarchy_id,
                        active,
                        country,
                        insurance_type,
                        raw_text,
                        canonical_text,
                        action,
                        fields,
                        tags,
                        conditions_json,
                        (1 - (embedding <=> %(embedding)s::vector)) AS similarity
                    FROM rules
                    WHERE fields && %(fields_filter)s::text[]
                      AND (%(active)s::boolean IS NULL OR active = %(active)s::boolean)
                      AND (%(country)s::text IS NULL OR country = %(country)s::text)
                      AND (%(insurance_type)s::text IS NULL OR insurance_type = %(insurance_type)s::text)
                    ORDER BY embedding <=> %(embedding)s::vector
                    LIMIT %(top_k)s
                    """,
                    {
                        "embedding": _vector_literal(embedding),
                        "fields_filter": fields_filter,
                        "active": active,
                        "country": country,
                        "insurance_type": insurance_type,
                        "top_k": top_k,
                    },
                )
            else:
                cur.execute(
                    """
                    SELECT
                        rule_id,
                        parent_rule,
                        priority,
                        version,
                        hierarchy_id,
                        active,
                        country,
                        insurance_type,
                        raw_text,
                        canonical_text,
                        action,
                        fields,
                        tags,
                        conditions_json,
                        (1 - (embedding <=> %(embedding)s::vector)) AS similarity
                    FROM rules
                                        WHERE (%(active)s::boolean IS NULL OR active = %(active)s::boolean)
                                            AND (%(country)s::text IS NULL OR country = %(country)s::text)
                                            AND (%(insurance_type)s::text IS NULL OR insurance_type = %(insurance_type)s::text)
                    ORDER BY embedding <=> %(embedding)s::vector
                    LIMIT %(top_k)s
                    """,
                                        {
                                                "embedding": _vector_literal(embedding),
                                                "active": active,
                                                "country": country,
                                                "insurance_type": insurance_type,
                                                "top_k": top_k,
                                        },
                )
            rows = cur.fetchall()
            return list(rows)
