"""Token pricing. Rates are configuration with provenance, not constants buried in logic."""
from __future__ import annotations

from dataclasses import dataclass

from sci_core.budget import PriceBook


@dataclass(frozen=True)
class DecisionsUsage:
    input_tokens: int = 0
    cached_tokens: int = 0
    cache_write_tokens: int = 0
    output_tokens: int = 0


@dataclass(frozen=True)
class TokenPrices:
    """USD per 1M tokens."""
    input: float
    cached_input: float
    cache_write: float
    output: float
    source: str = ""
    verified_on: str = ""
    multiplier: float = 1.0  # e.g. 1.10 for data-residency endpoints

    def cost(self, u: DecisionsUsage) -> float:
        uncached = max(0, u.input_tokens - u.cached_tokens - u.cache_write_tokens)
        total = (uncached * self.input + u.cached_tokens * self.cached_input
                 + u.cache_write_tokens * self.cache_write + u.output_tokens * self.output) / 1e6
        return total * self.multiplier

    def worst_case_price_book(self) -> PriceBook:
        """For budget gates: every input token billed at the dearest input rate."""
        m = self.multiplier
        return PriceBook(max(self.input, self.cache_write) * m, self.output * m)


# gpt-6-luna, Standard, context <= 272K. Source: https://developers.openai.com/api/docs/pricing (checked 2026-10-27).
# The Decisions guide says output tokens are not charged while the pricing page lists $0.50/1M;
# the higher figure is used until OpenAI clarifies. Re-verify before every production enablement.
LUNA_STANDARD_SHORT = TokenPrices(
    input=0.10, cached_input=0.01, cache_write=0.125, output=0.50,
    source="https://developers.openai.com/api/docs/pricing", verified_on="2026-10-27")
LUNA_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000  # adapter refuses larger requests so the short tier always applies
