"""Live mode with routing: the session is classified once per content, then evaluated by the rubric it was routed to."""
import pytest

from sci_core.provider import AnswerState, ProviderAnswer, ProviderResponse, ProviderUsage
from sci_core.routing import ROUTE_CRITERION_ID, RoutingConfig
from sci_workers.live import LiveProcessor, Outcome, TenantLiveConfig
from tests.test_live import MSGS, NOW, Ledger, Source, Store, Writer, event
from tests.test_live import make as make_live

ROUTING = RoutingConfig.parse({
    "routes": [{"key": "sales", "description": "compra", "rubric_id": "sales_quality", "rubric_version": 1},
               {"key": "after_sales", "description": "suporte", "rubric_id": "after_sales_quality", "rubric_version": 1},
               {"key": "other", "description": "resto"}],
    "fallback": "other"})


class RouterAI:
    model, prompt_version = "router-fake", "r1"

    def __init__(self, answer="sales", state=AnswerState.ANSWERED, cost=0.0005):
        self.answer, self.state, self.cost, self.calls = answer, state, cost, 0

    async def evaluate(self, text, criteria):
        self.calls += 1
        return ProviderResponse(answers=[ProviderAnswer(criterion_id=ROUTE_CRITERION_ID, state=self.state, answer=self.answer)],
                                usage=ProviderUsage(input_tokens=100, output_tokens=5, estimated_cost_usd=self.cost))


class Routes:
    def __init__(self):
        self.rows = []

    async def route_for(self, tenant, sid, h, *, since, identity):
        hit = [r for r in self.rows if (r["session_id"], r["session_content_hash"], r["model"], r["prompt_version"]) ==
               (sid, h, identity.model, identity.prompt_version)]
        return hit[-1] if hit else None

    async def write(self, rows):
        self.rows += rows


def make(rubric_json, ai, *, spent=0.0, budget_ledger=None):
    """Same fakes as the single-rubric tests, plus a router; the loader returns whatever rubric the route points to."""
    proc, provider, writer, store, ledger = make_live(rubric_json, ledger=budget_ledger or Ledger(spent=spent))
    routes = Routes()
    proc = LiveProcessor(tenants={("demo", "default"): TenantLiveConfig(routing=ROUTING)}, source=proc._src, store=store, ledger=proc._ledger, writer=writer, loader=proc._loader,
                         engine=proc._engine, prices=proc._prices, default_monthly_budget_usd=5.0, clock=lambda: NOW,
                         router_provider=ai, route_store=routes)
    return proc, provider, writer, store, routes


async def test_routes_then_evaluates_with_the_chosen_rubric_and_records_both_costs(rubric_json):
    ai = RouterAI("sales")
    proc, provider, writer, store, routes = make(rubric_json, ai)
    assert await proc.process(event()) is Outcome.EVALUATED
    assert ai.calls == 1 and provider.calls == 1 and len(writer.analyses) == 1
    assert routes.rows[0]["route_key"] == "sales" and routes.rows[0]["rubric_id"] == "sales_quality"
    run = store.runs[-1]
    assert run["rubric_id"] == "sales_quality" and run["actual_cost_usd"] == pytest.approx(0.001 + 0.0005)  # analysis + routing


async def test_same_content_is_not_classified_twice(rubric_json):
    ai = RouterAI("sales")
    proc, provider, writer, store, routes = make(rubric_json, ai)
    await proc.process(event())
    store.done = {("s1", routes.rows[0]["session_content_hash"])}  # the analysis exists now
    assert await proc.process(event(event_id="e2")) is Outcome.DUPLICATE_CONTENT
    assert ai.calls == 1 and provider.calls == 1 and len(routes.rows) == 1  # the cached decision was reused


async def test_changed_content_is_classified_again(rubric_json):
    ai, src = RouterAI("sales"), Source()
    proc, _, _, _, routes = make(rubric_json, ai)
    proc._src = src
    await proc.process(event())
    src.messages = [*MSGS, {"message_id": "m3", "sequence_number": 3, "sender_type": "customer", "content": "mais uma pergunta"}]
    await proc.process(event(event_id="e2"))
    assert ai.calls == 2 and len(routes.rows) == 2


async def test_skip_route_ends_cheaply_and_leaves_a_trace(rubric_json):
    ai = RouterAI("other")
    proc, provider, writer, store, routes = make(rubric_json, ai)
    assert await proc.process(event()) is Outcome.ROUTED_SKIP
    assert provider.calls == 0 and writer.analyses == [] and routes.rows[0]["rubric_id"] is None
    assert store.runs[-1]["run_status"] == "ROUTED_SKIP" and store.runs[-1]["rubric_id"] is None
    assert store.runs[-1]["actual_cost_usd"] == pytest.approx(0.0005)


async def test_unusable_classification_goes_to_the_fallback_not_to_a_rubric(rubric_json):
    ai = RouterAI(None, AnswerState.INSUFFICIENT_EVIDENCE)
    proc, provider, writer, _, routes = make(rubric_json, ai)
    assert await proc.process(event()) is Outcome.ROUTED_SKIP
    assert routes.rows[0]["route_state"] == "FALLBACK" and provider.calls == 0


async def test_monthly_budget_blocks_routing_before_any_provider_call(rubric_json):
    ai = RouterAI("sales")
    proc, provider, _, store, routes = make(rubric_json, ai, spent=5.0)
    assert await proc.process(event()) is Outcome.BUDGET_BLOCKED
    assert ai.calls == 0 and provider.calls == 0 and routes.rows == [] and store.runs[-1]["run_status"] == "BUDGET_BLOCKED"


def test_a_tenant_needs_exactly_one_of_rubric_or_routing():
    with pytest.raises(ValueError):
        TenantLiveConfig()
    with pytest.raises(ValueError):
        TenantLiveConfig("sales_quality", routing=ROUTING)


def test_routing_tenants_require_a_router_when_ai_is_on(rubric_json):
    proc, *_ = make_live(rubric_json)
    with pytest.raises(ValueError, match="router_provider"):
        LiveProcessor(tenants={("demo", "default"): TenantLiveConfig(routing=ROUTING)}, source=Source(), store=Store(), ledger=Ledger(), writer=Writer(), loader=proc._loader,
                      engine=proc._engine, prices=proc._prices)
