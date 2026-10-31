"""Routing pass: bounded, idempotent, budget-gated, tenant-scoped. Fake source/store/provider; the SQL has its own tests."""
from datetime import UTC, date, datetime, timedelta

import pytest

from sci_bq.source import Cursor, SessionPage, Tenant
from sci_core.budget import PriceBook
from sci_core.provider import AnswerState, ProviderAnswer, ProviderResponse, ProviderUsage
from sci_core.routing import ROUTE_CRITERION_ID, RoutingConfig, SessionRouter
from sci_workers.routing import RoutingJob, RoutingJobConfig

NOW = datetime(2026, 3, 1, tzinfo=UTC)
T = Tenant("demo", "default")
CFG = RoutingConfig.parse({
    "routes": [{"key": "sales", "description": "compra", "rubric_id": "sales_quality"},
               {"key": "after_sales", "description": "suporte", "rubric_id": "after_sales_quality"},
               {"key": "other", "description": "resto"}],
    "fallback": "other"})


def sess(i):
    ts = datetime(2026, 1, 1, tzinfo=UTC) + timedelta(hours=i)
    return {"session_id": f"s{i:03d}", "started_at": ts, "updated_at": ts, "closed_at": ts, "status": "closed"}


def msgs(i, text=None):
    return [{"message_id": f"s{i}-m1", "sequence_number": 1, "sender_type": "customer", "content": text or ("quero comprar " * 20 if i % 2 else "meu pedido veio com defeito " * 10)}]


class FakeSource:
    def __init__(self, n):
        self.sessions = [sess(i) for i in range(n)]
        self.empty = set()

    async def list_sessions(self, tenant, *, start_date, end_date, cursor, page_size=500, status=None):
        rows = [s for s in self.sessions if (s["updated_at"], s["session_id"]) > (cursor.updated_at, cursor.session_id)][:page_size]
        return SessionPage(rows, Cursor(rows[-1]["updated_at"], rows[-1]["session_id"]) if len(rows) == page_size else None)

    async def get_messages(self, tenant, ids, *, start_date, end_date):
        return {i: ([] if i in self.empty else msgs(int(i[1:]))) for i in ids}


class MemRoutes:
    def __init__(self):
        self.rows, self.fail_write = [], False

    async def existing(self, tenant, ids, *, since, identity):
        return {(r["session_id"], r["session_content_hash"]) for r in self.rows
                if r["session_id"] in ids and (r["model"], r["prompt_version"]) == (identity.model, identity.prompt_version)}

    async def write(self, rows):
        self.rows += rows


class Classifier:
    """Odd sessions talk about buying, even ones about a defect. `weird`/`boom` hold the message-id prefix ("s2" = session s002)."""
    model, prompt_version = "fake", "p1"

    def __init__(self, cost=0.001, weird=(), boom=()):
        self.cost, self.weird, self.boom, self.calls = cost, set(weird), set(boom), 0

    async def evaluate(self, text, criteria):
        self.calls += 1
        sid = text.split("id=")[1].split("-")[0]
        if sid in self.boom:
            raise RuntimeError("provider down")
        if sid in self.weird:
            a = ProviderAnswer(criterion_id=ROUTE_CRITERION_ID, state=AnswerState.INSUFFICIENT_EVIDENCE)
        else:
            a = ProviderAnswer(criterion_id=ROUTE_CRITERION_ID, answer="sales" if "comprar" in text else "after_sales")
        return ProviderResponse(answers=[a], usage=ProviderUsage(input_tokens=200, output_tokens=10, estimated_cost_usd=self.cost))


def job(n=6, provider=None, **kw):
    cfg = RoutingJobConfig(tenant=T, start_date=date(2026, 1, 1), end_date=date(2026, 1, 31), prices=PriceBook(1.0, 4.0),
                           max_cost_usd=kw.pop("max_cost_usd", 1.0), max_sessions=kw.pop("max_sessions", 100), **kw)
    src, store, p = FakeSource(n), MemRoutes(), provider or Classifier()
    return RoutingJob(source=src, store=store, router=SessionRouter(p, CFG), config=cfg, clock=lambda: NOW), src, store, p


async def test_preflight_never_calls_the_provider_and_estimates_a_cost():
    j, _, store, p = job()
    r = await j.preflight()
    assert (r.sessions, r.to_classify, r.already_routed) == (6, 6, 0) and r.needs_ai and r.approvable
    assert 0 < r.estimated_cost_usd_low < r.estimated_cost_usd_high and p.calls == 0 and store.rows == []


async def test_run_requires_approval():
    j, *_ = job()
    with pytest.raises(PermissionError):
        await j.run()


async def test_run_routes_each_session_once_and_rerun_costs_nothing():
    j, _, store, p = job()
    s = await j.run(approved=True)
    assert (s.seen, s.routed, s.failed, s.status) == (6, 6, 0, "COMPLETED") and p.calls == 6
    assert s.by_route == {"sales": 3, "after_sales": 3} and s.spent_usd == pytest.approx(0.006)
    by = {r["session_id"]: r for r in store.rows}
    assert by["s001"]["rubric_id"] == "sales_quality" and by["s002"]["rubric_id"] == "after_sales_quality"
    assert all(r["organization_id"] == "demo" and r["workspace_id"] == "default" and r["route_state"] == "CLASSIFIED" for r in store.rows)
    again = await j.run(approved=True)
    assert (again.routed, again.skipped) == (0, 6) and p.calls == 6 and len(store.rows) == 6  # no new call, no duplicate row


async def test_changed_conversation_or_route_definitions_are_decided_again():
    j, src, store, p = job(3)
    await j.run(approved=True)
    edited = RoutingConfig.parse({**CFG.model_dump(), "routes": [{**r.model_dump(), "description": r.description + "."} for r in CFG.routes]})
    j2 = RoutingJob(source=src, store=store, router=SessionRouter(p, edited), config=j._cfg, clock=lambda: NOW)
    assert (await j2.run(approved=True)).routed == 3  # new identity -> new decisions, old rows stay as history
    assert len(store.rows) == 6


async def test_unusable_answer_uses_the_fallback_and_is_counted():
    j, _, store, _ = job(4, Classifier(weird={"s2"}))
    s = await j.run(approved=True)
    assert s.fallbacks == 1 and s.by_route["other"] == 1
    row = next(r for r in store.rows if r["session_id"] == "s002")
    assert (row["route_key"], row["rubric_id"], row["route_state"]) == ("other", None, "FALLBACK")


async def test_a_failing_session_is_counted_and_retried_on_the_next_run_without_blocking_the_others():
    p = Classifier(boom={"s1"})
    j, _, store, _ = job(4, p)
    s = await j.run(approved=True)
    assert (s.routed, s.failed) == (3, 1) and s.status == "COMPLETED"
    p.boom.clear()
    assert (await j.run(approved=True)).routed == 1 and len(store.rows) == 4


async def test_budget_cap_stops_the_pass_and_keeps_what_was_decided():
    j, _, store, p = job(10, max_cost_usd=0.0025, concurrency=1)  # worst case per call ~0.0010 -> only two fit
    s = await j.run(approved=True)
    assert s.status == "BUDGET_STOPPED" and 0 < s.routed < 10 and p.calls == s.routed
    assert s.spent_usd <= 0.0025 and len(store.rows) == s.routed
    resumed = RoutingJob(source=j._src, store=store, router=j._router, config=RoutingJobConfig(
        tenant=T, start_date=date(2026, 1, 1), end_date=date(2026, 1, 31), prices=PriceBook(1.0, 4.0), max_cost_usd=1.0, max_sessions=100),
        clock=lambda: NOW)
    assert (await resumed.run(approved=True)).routed == 10 - s.routed


async def test_session_gate_refuses_a_whole_page_beyond_the_limit():
    j, _, store, p = job(10, max_sessions=5)
    s = await j.run(approved=True)
    assert s.status == "SESSION_GATE_STOPPED" and p.calls == 0 and store.rows == []
    assert not (await j.preflight()).approvable


async def test_empty_conversations_are_skipped_without_a_call():
    j, src, store, p = job(3)
    src.empty = {"s001"}
    s = await j.run(approved=True)
    assert (s.routed, s.skipped, p.calls) == (2, 1, 2)


async def test_single_route_writes_decisions_without_any_provider_call_or_cost():
    one = RoutingConfig.parse({"routes": [{"key": "sales", "description": "tudo", "rubric_id": "sales_quality"}], "fallback": "sales"})
    j, src, store, p = job(3)
    j = RoutingJob(source=src, store=store, router=SessionRouter(p, one), config=j._cfg, clock=lambda: NOW)
    pf = await j.preflight()
    assert not pf.needs_ai and pf.estimated_cost_usd_high == 0
    s = await j.run(approved=True)
    assert (s.routed, s.spent_usd, p.calls) == (3, 0.0, 0) and {r["route_state"] for r in store.rows} == {"SINGLE"}
