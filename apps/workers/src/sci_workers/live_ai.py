"""AI wiring of the live worker. Off unless AI_ENABLED=true; when on, every choice comes from the closed model catalog and a monthly budget
is mandatory.

Fail closed: a half-configured live worker (no key, unknown model, no budget) stops at start-up with a clear message instead of
analysing without a cap.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from sci_core.budget import PriceBook
from sci_core.engine import EvaluationEngine
from sci_core.provider import AIProvider
from sci_core.spend import SpendRecorder
from sci_openai.catalog import UnknownModel, default, find
from sci_workers.ai import MissingApiKey, api_key_provider, build_engine, build_provider

ROUTER_MAX_OUTPUT_TOKENS = 200


@dataclass(frozen=True)
class LiveAI:
    engine: EvaluationEngine
    router_provider: AIProvider | None
    prices: PriceBook
    monthly_budget_usd: float
    provider: str
    model: str


class LiveAIConfigError(SystemExit):
    """The live worker cannot start with AI enabled: the message says why and never contains the key."""


def build_live_ai(env: Mapping[str, str], *, routing: bool, recorder: SpendRecorder | None = None) -> LiveAI | None:
    """None while AI is disabled (the worker then answers 503 and the backlog is retained). `routing`: a tenant routes by type."""
    if env.get("AI_ENABLED") != "true":
        return None
    base = default()
    provider = env.get("LIVE_PROVIDER") or base.provider
    model = env.get("LIVE_MODEL") or (base.model if provider == base.provider else "")
    try:
        entry = find(provider, model)
    except UnknownModel as exc:
        raise LiveAIConfigError(f"live AI: {exc}") from exc
    try:
        budget = float(env.get("LIVE_MONTHLY_BUDGET_USD", ""))
    except ValueError:
        budget = 0.0
    if not budget > 0:
        raise LiveAIConfigError("live AI: set LIVE_MONTHLY_BUDGET_USD to a positive value (the monthly cap)")
    try:
        key = api_key_provider(env)
    except (MissingApiKey, OSError) as exc:
        raise LiveAIConfigError(f"live AI: {type(exc).__name__}") from exc
    api_model = entry.model if entry.provider == "responses" else None  # the Decisions API has a single model, fixed by the adapter
    engine = build_engine(
        mode="live", tenant_safety_id=None, key=key, prices=entry.prices, provider=entry.provider, model=api_model, recorder=recorder
    )
    router = None
    if routing:
        router = build_provider(
            tenant_safety_id=None,
            key=key,
            prices=entry.prices,
            provider=entry.provider,
            model=api_model,
            max_output_tokens=ROUTER_MAX_OUTPUT_TOKENS,
        )
    return LiveAI(engine, router, entry.prices.worst_case_price_book(), budget, entry.provider, entry.model)
