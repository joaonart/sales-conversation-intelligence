"""LLM-written synthetic conversations (pt-BR) on top of the deterministic plan in `synthetic_data`.

Local only: writes sessions/messages/rubric JSONL into --out. Loading to BigQuery is a separate, explicit step:
`python scripts/seed_synthetic.py --from-dir --out <dir> --project <p>`.

`--dry-run` builds the briefs and prints the worst-case cost without calling any API. A real run needs OPENAI_API_KEY[_FILE],
explicit model and prices (verify them on the official pricing page) and a hard `--max-cost-usd` that the BudgetGate enforces.
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import seed_synthetic  # noqa: E402
import synthetic_data as sd  # noqa: E402
from synthetic_data import llm  # noqa: E402


def parse(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--sessions-per-tenant", type=int, required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--input-price-per-million", type=float, required=True)
    p.add_argument("--cached-input-price-per-million", type=float, required=True)
    p.add_argument("--output-price-per-million", type=float, required=True)
    p.add_argument("--max-cost-usd", type=float, required=True)
    p.add_argument(
        "--cache", type=Path, help="JSON file with accepted dialogues by brief hash (reruns cost nothing); default <out>/llm_cache.json"
    )
    p.add_argument("--concurrency", type=int, default=4)
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args(argv)


async def main(argv: list[str] | None = None) -> int:
    a = parse(argv)
    sessions, messages = sd.generate()
    by_session = collections.defaultdict(list)
    for m in messages:
        by_session[(m["organization_id"], m["session_id"])].append(m)
    chosen = []
    for org in sorted({s["organization_id"] for s in sessions}):
        chosen += llm.select_sessions([s for s in sessions if s["organization_id"] == org], a.sessions_per_tenant)
    briefs = [(s, llm.make_brief(s, by_session[(s["organization_id"], s["session_id"])])) for s in chosen]
    worst = sum(
        (
            (len(llm.SYSTEM_PROMPT) + len(b.text)) / 2.5 * a.input_price_per_million
            + llm.max_output_tokens(b.target) * a.output_price_per_million
        )
        / 1e6
        for _, b in briefs
    )
    print(f"sessions: {len(briefs)}  worst-case cost for one attempt each: ${worst:.4f}  cap: ${a.max_cost_usd:.2f}")
    if a.dry_run:
        print(briefs[0][1].text)
        return 0

    from sci_core.budget import BudgetGate
    from sci_openai.http import OpenAIHttp
    from sci_workers.ai import api_key_provider

    cache_path = a.cache or a.out / "llm_cache.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    gate = BudgetGate(cap_usd=a.max_cost_usd)
    call = llm.responses_caller(OpenAIHttp(api_key_provider(), concurrency=a.concurrency), a.model)
    stats = llm.RunStats()
    sem = asyncio.Semaphore(a.concurrency)

    async def one(s, b):  # type: ignore[no-untyped-def]
        async with sem:
            msgs = await llm.write_dialogue(
                b, call, gate, a.input_price_per_million, a.cached_input_price_per_million, a.output_price_per_million, cache, stats
            )
        return s, b, msgs

    results = await asyncio.gather(*(one(s, b) for s, b in briefs))
    a.out.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(cache, ensure_ascii=False))
    seed_synthetic.write_local(a.out, 0.05)  # rubrics/policies (and throwaway sessions/messages replaced below)
    out_s, out_m = [], []
    for s, b, msgs in results:
        if msgs is None:
            continue
        ns, rows = llm.assemble(s, b, msgs, a.model, sd.NOW)
        out_s.append(ns)
        out_m += rows
        stats.written += 1
    for name, rows in (("sessions", out_s), ("messages", out_m)):
        (a.out / f"{name}.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    stats.spent_usd = gate.spent_usd
    print(
        json.dumps(
            {
                "written": stats.written,
                "from_cache": stats.cached,
                "dropped": stats.dropped,
                "api_calls": stats.calls,
                "spent_usd": round(gate.spent_usd, 4),
                "stopped_by_budget": stats.stopped_by_budget,
                "messages": len(out_m),
            },
            indent=2,
        )
    )
    return 0 if not stats.dropped and not stats.stopped_by_budget else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
