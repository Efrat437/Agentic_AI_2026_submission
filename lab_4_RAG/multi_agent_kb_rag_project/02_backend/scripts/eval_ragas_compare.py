import json
import os
import sys
from pathlib import Path

try:
    import requests
except ImportError as exc:
    raise SystemExit(
        "Missing dependency: requests. Install with 'pip install requests'."
    ) from exc

try:
    from datasets import Dataset
    from ragas import evaluate
    from ragas.metrics import faithfulness, answer_relevancy
except ImportError:
    print("RAGAS dependencies are not installed.")
    print("Install with: pip install ragas datasets requests")
    sys.exit(1)


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATASET = ROOT / "02_backend" / "eval" / "langgraph_eval_dataset.json"
BASE_URL = os.environ.get("EVAL_BASE_URL", "http://127.0.0.1:3000")


def load_dataset(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def context_to_strings(payload):
    if not isinstance(payload, dict):
        return []
    out = []
    for row in payload.get("rows", []) or []:
        out.append(json.dumps(row, ensure_ascii=False))
    for doc in payload.get("docs", []) or []:
        out.append(json.dumps(doc, ensure_ascii=False))
    return out[:16]


def fetch_compare(query, user_id="ragas-eval"):
    resp = requests.post(
        f"{BASE_URL}/api/eval/retrieval-compare",
        json={
            "query": query,
            "userId": user_id,
            "sqlOptions": {
                "evalMode": True,
                "disableMemory": True,
                "disableWrites": True,
                "sqlIngestLayerEnabled": False,
            },
        },
        timeout=180,
    )
    resp.raise_for_status()
    return resp.json()


def build_ragas_rows(items, pathway_key):
    rows = []
    for item in items:
        query = item["query"]
        gt_answer = item.get("ground_truth_answer")
        gt_context = item.get("ground_truth_context") or []
        compare = fetch_compare(query)

        if pathway_key == "baseline":
            result = compare["baseline"]["result"]
            answer = result.get("answer") or ""
            if "mergedContext" in result:
                contexts = context_to_strings(result["mergedContext"])
            else:
                contexts = context_to_strings(
                    {
                        "rows": result.get("rows", []),
                        "docs": result.get("docs", []),
                    }
                )
            latency = compare["baseline"]["metrics"].get("totalLatencyMs")
            llm_calls = compare["comparison"]["llmCallsEstimated"].get(
                "baseline"
            )
        else:
            result = compare["langgraph"]
            answer = result.get("answer") or ""
            contexts = context_to_strings(result.get("mergedContext", {}))
            latency = result.get("metrics", {}).get("totalLatencyMs")
            llm_calls = compare["comparison"]["llmCallsEstimated"].get(
                "langgraph"
            )

        rows.append({
            "id": item["id"],
            "question": query,
            "answer": answer,
            "contexts": contexts,
            "ground_truth": gt_answer or "",
            "reference_contexts": gt_context,
            "latency_ms": latency,
            "llm_calls_estimated": llm_calls,
        })
    return rows


def run_pathway_eval(items, pathway_key):
    rows = build_ragas_rows(items, pathway_key)
    dataset = Dataset.from_list([
        {
            "question": row["question"],
            "answer": row["answer"],
            "contexts": row["contexts"],
            "ground_truth": row["ground_truth"],
        }
        for row in rows
    ])
    scores = evaluate(dataset, metrics=[faithfulness, answer_relevancy])
    return rows, scores


def main():
    dataset_path = Path(os.environ.get("EVAL_DATASET", str(DEFAULT_DATASET)))
    items = load_dataset(dataset_path)
    usable_items = [item for item in items if item.get("ground_truth_answer")]

    if not usable_items:
        print("Dataset contains no filled ground_truth_answer values.")
        print(f"Populate ground truth in {dataset_path} before running RAGAS.")
        sys.exit(1)

    baseline_rows, baseline_scores = run_pathway_eval(usable_items, "baseline")
    langgraph_rows, langgraph_scores = run_pathway_eval(
        usable_items, "langgraph"
    )

    report = {
        "dataset": str(dataset_path),
        "baseline": {
            "scores": baseline_scores,
            "rows": baseline_rows,
        },
        "langgraph": {
            "scores": langgraph_scores,
            "rows": langgraph_rows,
        },
        "manual_scoring_guidance": {
            "0": "not good / incorrect",
            "1": "partial / incomplete",
            "2": "good / correct and relevant",
        },
    }

    print(json.dumps(report, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
