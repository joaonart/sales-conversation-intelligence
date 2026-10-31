"""The closed list of (API, model) pairs an admin may choose for an execution, with the prices used to estimate and to gate its cost.

Single source of truth: the console receives a generated copy (`scripts/gen_model_catalog.py`, checked by a test) and the executor
refuses any pair that is not here, whatever a stored request says. Adding a model is a code change with a source and a date,
never something typed into a form.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from sci_openai.pricing import LUNA_STANDARD_SHORT, TokenPrices

Provider = Literal["decisions", "responses"]
PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing"
DEFAULT_PROVIDER: Provider = "decisions"
DEFAULT_MODEL = "gpt-6-luna"


@dataclass(frozen=True)
class CatalogModel:
    provider: Provider
    model: str
    prices: TokenPrices
    validated: (
        bool  # True: already ran for real through this adapter. False: allowed, shown with a warning; the first real run is its test.
    )
    note: str = ""

    @property
    def label(self) -> str:
        return self.model


# Standard tier, context <= 272K, USD per 1M tokens. Responses has no cache-write price: it is set equal to the input price.
CATALOG: tuple[CatalogModel, ...] = (
    CatalogModel("decisions", "gpt-6-luna", LUNA_STANDARD_SHORT, True, "Único modelo aceito pela Decisions API."),
    CatalogModel(
        "responses",
        "gpt-4o",
        TokenPrices(2.50, 1.25, 2.50, 10.00, source=PRICING_SOURCE, verified_on="2026-10-31"),
        True,
        "Já rodou de verdade pelo adaptador do Responses.",
    ),
    CatalogModel(
        "responses",
        "gpt-4o-mini",
        TokenPrices(0.15, 0.075, 0.15, 0.60, source=PRICING_SOURCE, verified_on="2026-10-31"),
        False,
        "Ainda não rodou pelo adaptador: a primeira execução real é o teste.",
    ),
)


class UnknownModel(ValueError):
    """The pair is not in the catalog."""


def find(provider: str, model: str) -> CatalogModel:
    for m in CATALOG:
        if m.provider == provider and m.model == model:
            return m
    raise UnknownModel(f"{provider}/{model} não está na lista de modelos permitidos")


def default() -> CatalogModel:
    return find(DEFAULT_PROVIDER, DEFAULT_MODEL)


def as_json() -> dict[str, Any]:
    """What the console embeds. The rates are the worst case used for estimates (the dearest input rate, never the cached one)."""
    wc = {m.model: m.prices.worst_case_price_book() for m in CATALOG}
    return {
        "source": PRICING_SOURCE,
        "default": {"provider": DEFAULT_PROVIDER, "model": DEFAULT_MODEL},
        "models": [
            {
                "provider": m.provider,
                "model": m.model,
                "label": m.label,
                "validated": m.validated,
                "note": m.note,
                "input_per_million": wc[m.model].input_per_million,
                "output_per_million": wc[m.model].output_per_million,
                "verified_on": m.prices.verified_on,
            }
            for m in CATALOG
        ],
    }
