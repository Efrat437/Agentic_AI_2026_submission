from __future__ import annotations

from typing import Any


class CrossEncoderReranker:
    def __init__(self, model_name: str):
        self.model_name = model_name
        self._model = None

    def _load(self):
        if self._model is not None:
            return
        try:
            from sentence_transformers import CrossEncoder

            self._model = CrossEncoder(self.model_name)
        except Exception:
            self._model = False

    def rerank(self, query_text: str, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not candidates:
            return candidates
        self._load()

        if self._model is False:
            for c in candidates:
                c["rerank_score"] = float(c.get("similarity", 0.0))
            return sorted(candidates, key=lambda x: x["rerank_score"], reverse=True)

        pairs = [[query_text, c["canonical_text"]] for c in candidates]
        scores = self._model.predict(pairs)
        for c, score in zip(candidates, scores):
            c["rerank_score"] = float(score)
        return sorted(candidates, key=lambda x: x["rerank_score"], reverse=True)
