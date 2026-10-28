"""Scenario cost model for docs/deployment-plan.md. Prices are inputs, not facts: re-verify before approval.

Usage: python scripts/cost_estimate.py
"""

from __future__ import annotations

from dataclasses import dataclass

CHARS_PER_TOKEN = 3.5  # pt-BR heuristic; measure with real data
GUARD_TOKENS = 300
TOKENS_PER_QUESTION_IN = 60
TOKENS_PER_ANSWER_OUT = 30  # assumption: Decisions output size is undocumented

# OpenAI gpt-6-luna Standard <=272K (docs/openai-validation.md, verified 2026-10-27), USD / 1M tokens
OPENAI_IN, OPENAI_OUT = 0.10, 0.50

# GCP list prices recalled from training data -- NOT verified (pricing pages did not render on 2026-10-27)
BQ_SCAN_PER_TIB = 6.25
BQ_FREE_SCAN_TIB = 1.0
BQ_STORAGE_PER_GIB = 0.02
CR_VCPU_S, CR_GIB_S = 0.000024, 0.0000025  # Tier 1; Tier 2 (e.g. sao paulo) ~1.44x
CR_FREE_VCPU_S, CR_FREE_GIB_S = 180_000, 360_000
PUBSUB_PER_TIB, PUBSUB_FREE_GIB = 40.0, 10
TASKS_PER_M, TASKS_FREE_M = 0.40, 1.0


@dataclass(frozen=True)
class Scenario:
    name: str
    historical_sessions: int
    live_sessions_month: int
    messages: int
    chars: int
    criteria: int
    live_reanalysis: float = 1.5  # evaluations per live session after debounce


def tokens_in(s: Scenario) -> float:
    return GUARD_TOKENS + s.messages * s.chars / CHARS_PER_TOKEN + s.criteria * TOKENS_PER_QUESTION_IN


def openai(s: Scenario, evaluations: float) -> float:
    return evaluations * (tokens_in(s) * OPENAI_IN + s.criteria * TOKENS_PER_ANSWER_OUT * OPENAI_OUT) / 1e6


def run(s: Scenario) -> dict[str, float]:
    live_evals = s.live_sessions_month * s.live_reanalysis
    hist_ai = openai(s, s.historical_sessions)
    live_ai = openai(s, live_evals)
    raw_gib = s.messages * s.chars * 1.3 / 2**30  # bytes per session incl. overhead
    hist_scan_tib = s.historical_sessions * raw_gib * 2 / 1024  # sessions + messages read once, x2 slack
    live_scan_tib = live_evals * raw_gib * 3 / 1024  # bounded reads + checkpoint/ledger lookups
    analytics_tib = 0.02 * (s.historical_sessions + s.live_sessions_month * 12) / 50_000  # gold views, rough
    bq_scan = max(0.0, hist_scan_tib + live_scan_tib + analytics_tib - BQ_FREE_SCAN_TIB) * BQ_SCAN_PER_TIB
    results_gib = (s.historical_sessions + live_evals * 12) * (s.criteria * 600 + 1500) / 2**30
    bq_storage = max(0.0, results_gib - 10) * BQ_STORAGE_PER_GIB
    live_cpu_s = live_evals * 3.0  # ~3 s per request at 1 vCPU / 0.5 GiB
    hist_cpu_s = s.historical_sessions * 2.0 / 4  # ~2 s/session, concurrency 4
    vcpu = (live_cpu_s + hist_cpu_s) * 1.0
    gib = (live_cpu_s + hist_cpu_s) * 0.5
    run_cost = max(0, vcpu - CR_FREE_VCPU_S) * CR_VCPU_S + max(0, gib - CR_FREE_GIB_S) * CR_GIB_S
    pubsub_gib = s.live_sessions_month * 10 * 2 * 1024 / 2**30  # ~10 events/session, 1 KiB min, x2 (delivery + DLQ slack)
    pubsub = max(0, pubsub_gib - PUBSUB_FREE_GIB) / 1024 * PUBSUB_PER_TIB
    tasks = max(0.0, live_evals * 3 / 1e6 - TASKS_FREE_M) * TASKS_PER_M
    fixed = 0.0  # secret versions, AR (<0.5 GiB free), alerts, logs within free tier assumed; see doc
    gcp = bq_scan + bq_storage + run_cost + pubsub + tasks + fixed
    return {
        "tokens_in_per_eval": tokens_in(s),
        "openai_historical_once": hist_ai,
        "openai_live_month": live_ai,
        "bq_scan_tib_month": hist_scan_tib + live_scan_tib + analytics_tib,
        "gcp_live_month": gcp,
        "gcp_hist_once_scan": hist_scan_tib * BQ_SCAN_PER_TIB,
    }


SCENARIOS = [
    Scenario("pequeno", 2_000, 1_000, 30, 200, 10),
    Scenario("medio", 50_000, 20_000, 40, 250, 20),
    Scenario("grande", 500_000, 200_000, 60, 250, 30),
]

if __name__ == "__main__":
    for sc in SCENARIOS:
        print(sc.name, {k: round(v, 2) for k, v in run(sc).items()})
