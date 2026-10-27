"""Spend gate. Fails closed: when in doubt, the call is not made."""
from __future__ import annotations

from dataclasses import dataclass, field


class BudgetExceeded(RuntimeError):
    pass


@dataclass(frozen=True)
class PriceBook:
    """USD per 1M tokens. Supplied by configuration from official current pricing; never hardcoded."""
    input_per_million: float
    output_per_million: float

    def __post_init__(self) -> None:
        if self.input_per_million < 0 or self.output_per_million < 0:
            raise ValueError("prices must be >= 0")

    def cost(self, input_tokens: int, output_tokens: int) -> float:
        return input_tokens / 1e6 * self.input_per_million + output_tokens / 1e6 * self.output_per_million


@dataclass
class BudgetGate:
    cap_usd: float
    spent_usd: float = 0.0
    _inflight: dict[int, float] = field(default_factory=dict)
    _next: int = 0

    def __post_init__(self) -> None:
        if self.cap_usd < 0:
            raise ValueError("cap must be >= 0")

    @property
    def committed_usd(self) -> float:
        return self.spent_usd + sum(self._inflight.values())

    def reserve(self, estimated_usd: float) -> int:
        """Reserve worst-case cost before calling the provider. Single event loop -> atomic."""
        if self.committed_usd + estimated_usd > self.cap_usd + 1e-12:
            raise BudgetExceeded(f"cap ${self.cap_usd:.4f}: committed ${self.committed_usd:.4f} + ${estimated_usd:.4f}")
        self._next += 1
        self._inflight[self._next] = estimated_usd
        return self._next

    def settle(self, token: int, actual_usd: float | None) -> None:
        """Release a reservation; if the call outcome is unknown (error), keep the worst case charged."""
        reserved = self._inflight.pop(token)
        self.spent_usd += reserved if actual_usd is None else actual_usd
