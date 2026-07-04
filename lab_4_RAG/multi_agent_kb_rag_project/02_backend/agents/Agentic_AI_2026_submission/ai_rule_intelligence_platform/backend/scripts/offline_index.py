from __future__ import annotations

import asyncio
from pathlib import Path

from app.db import init_db
from app.services.indexing import offline_index_from_jsonl


async def main() -> None:
    init_db()
    base = Path(__file__).resolve().parents[1]
    jsonl_path = base / "seed" / "insurance_rules_dummy_100.jsonl"
    count = await offline_index_from_jsonl(jsonl_path)
    print(f"Indexed {count} rules")


if __name__ == "__main__":
    asyncio.run(main())
