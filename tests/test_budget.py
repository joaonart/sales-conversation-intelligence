import pytest

from sci_core.budget import BudgetExceeded, BudgetGate, PriceBook


def test_price_book():
    assert PriceBook(2, 8).cost(1_000_000, 500_000) == 6
    with pytest.raises(ValueError):
        PriceBook(-1, 0)


def test_reserve_blocks_when_over_cap_and_counts_inflight():
    g = BudgetGate(cap_usd=1.0)
    t = g.reserve(0.6)
    with pytest.raises(BudgetExceeded):
        g.reserve(0.5)  # inflight counts
    g.settle(t, 0.2)
    g.reserve(0.5)


def test_unknown_outcome_keeps_worst_case():
    g = BudgetGate(cap_usd=1.0)
    g.settle(g.reserve(0.7), None)
    assert g.spent_usd == 0.7


def test_zero_cap_rejects_everything():
    with pytest.raises(BudgetExceeded):
        BudgetGate(cap_usd=0).reserve(0.0001)
