from __future__ import annotations

import asyncio

import httpx

from app.config import settings


async def embed_text(text: str) -> list[float]:
    retries = max(int(settings.embedding_retries), 1)
    backoff_ms = max(int(settings.embedding_retry_backoff_ms), 1)
    last_error = None

    async with httpx.AsyncClient(timeout=40) as client:
        for attempt in range(1, retries + 1):
            try:
                response = await client.post(
                    f"{settings.embedding_server_url}/embed",
                    json={"text": text, "model": settings.embedding_model},
                )
                response.raise_for_status()
                payload = response.json()
                return payload["embedding"]
            except Exception as exc:
                last_error = exc
                if attempt == retries:
                    break
                await asyncio.sleep((backoff_ms * (2 ** (attempt - 1))) / 1000.0)

    raise RuntimeError(f"Embedding call failed after {retries} attempts: {last_error}")
