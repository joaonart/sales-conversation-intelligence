"""The routing SQL on sample data: latest decision wins, only-routed filter, tenant isolation."""
from datetime import UTC, date, datetime

import pytest

from sci_bq.queries import TENANT
from sci_bq.source import BigQuerySource, Cursor, Tenant
from sci_bq.tables import Tables
from sci_bq.writer import BigQueryRouteStore
from sci_core.provider import AnalysisIdentity
from tests.duck import DuckBQ, DuckRunner

T = Tables(project="my-proj-123")
A, B = Tenant("orgA", "ws1"), Tenant("orgB", "ws1")
D1, D2 = datetime(2026, 3, 1, 10, tzinfo=UTC), datetime(2026, 3, 2, 10, tzinfo=UTC)
EPOCH = Cursor(datetime(1970, 1, 1, tzinfo=UTC))
IDENT = AnalysisIdentity(model="m", prompt_version="p|router-v1|abc")


def route(t, sid, key, rubric, ver, at, ident=IDENT, h="h1"):
    return dict(route_id=f"{t.organization_id}-{sid}-{key}-{at:%d}", organization_id=t.organization_id, workspace_id=t.workspace_id,
                session_id=sid, session_content_hash=h, route_key=key, rubric_id=rubric, rubric_version=ver, route_state="CLASSIFIED",
                model=ident.model, prompt_version=ident.prompt_version, input_tokens=100, output_tokens=5, estimated_cost_usd=0.001, decided_at=at)


@pytest.fixture
def env():
    db = DuckBQ()
    for t in (A, B):
        k = {"organization_id": t.organization_id, "workspace_id": t.workspace_id}
        for sid in ("s1", "s2", "s3"):
            db.insert("sessions", [dict(**k, session_id=sid, status="closed", started_at=D1, updated_at=D1, closed_at=D1)])
    db.insert("session_routes", [
        route(A, "s1", "sales", "sales_quality", None, D1),
        route(A, "s2", "after_sales", "after_sales_quality", 1, D1),
        route(A, "s3", "other", None, None, D1),
        route(B, "s1", "after_sales", "after_sales_quality", 1, D1),  # same session id in another tenant
    ])
    db.create_views()
    return db, DuckRunner(db)


async def ids(src, tenant, routed_to):
    page = await src.list_sessions(tenant, start_date=date(2026, 3, 1), end_date=date(2026, 3, 2), cursor=EPOCH, routed_to=routed_to)
    return [s["session_id"] for s in page.sessions]


async def test_only_routed_keeps_the_sessions_sent_to_that_rubric(env):
    _, runner = env
    src = BigQuerySource(runner, T)
    assert await ids(src, A, ("after_sales_quality", 1)) == ["s2"]
    assert await ids(src, A, ("sales_quality", 3)) == ["s1"]  # route without a pinned version matches any version
    assert await ids(src, A, ("nope", 1)) == []
    assert sorted(await ids(src, A, None)) == ["s1", "s2", "s3"]  # no filter -> unchanged behaviour


async def test_routing_never_crosses_tenants(env):
    _, runner = env
    src = BigQuerySource(runner, T)
    assert await ids(src, B, ("after_sales_quality", 1)) == ["s1"]
    assert await ids(src, B, ("sales_quality", 1)) == []  # orgA's s1 route is invisible to orgB
    store = BigQueryRouteStore(runner, None, T)  # type: ignore[arg-type]
    assert await store.existing(B, ["s1", "s2"], since=date(2026, 1, 1), identity=IDENT) == {("s1", "h1")}
    routed = [q for q, _ in runner.queries if "session_routes" in q]
    assert routed and all(q.count(TENANT) >= (2 if "FROM `my-proj-123.commerce.sessions`" in q else 1) for q in routed)  # outer query AND subquery


async def test_latest_decision_wins_and_old_ones_stay_as_history(env):
    db, runner = env
    db.insert("session_routes", [route(A, "s1", "after_sales", "after_sales_quality", 1, D2, h="h2")])
    src = BigQuerySource(runner, T)
    assert await ids(src, A, ("sales_quality", 1)) == []
    assert await ids(src, A, ("after_sales_quality", 1)) == ["s1", "s2"]
    assert db.rows("SELECT COUNT(*) AS n FROM session_routes WHERE organization_id = 'orgA' AND session_id = 's1'")[0]["n"] == 2


async def test_existing_is_per_identity_and_content(env):
    _, runner = env
    store = BigQueryRouteStore(runner, None, T)  # type: ignore[arg-type]
    other = AnalysisIdentity(model="m", prompt_version="p|router-v1|different")
    got = await store.existing(A, ["s1", "s2", "s3"], since=date(2026, 1, 1), identity=IDENT)
    assert got == {("s1", "h1"), ("s2", "h1"), ("s3", "h1")}
    assert await store.existing(A, ["s1"], since=date(2026, 1, 1), identity=other) == set()
    assert await store.existing(A, ["s1"], since=date(2026, 3, 5), identity=IDENT) == set()


async def test_route_for_returns_the_decision_for_that_exact_content_and_identity(env):
    _, runner = env
    store = BigQueryRouteStore(runner, None, T)  # type: ignore[arg-type]
    got = await store.route_for(A, "s2", "h1", since=date(2026, 1, 1), identity=IDENT)
    assert (got["route_key"], got["rubric_id"], got["rubric_version"]) == ("after_sales", "after_sales_quality", 1)
    assert await store.route_for(A, "s2", "changed", since=date(2026, 1, 1), identity=IDENT) is None
    assert await store.route_for(B, "s2", "h1", since=date(2026, 1, 1), identity=IDENT) is None  # B has no s2


async def test_monthly_spend_covers_analyses_and_routing_and_stays_per_tenant(env):
    from sci_bq.ledger import BigQueryLedger

    db, runner = env
    db.insert("session_analyses", [dict(analysis_id="a1", organization_id="orgA", workspace_id="ws1", session_id="s1", rubric_id="r",
                                        rubric_version=1, analysis_mode="live", session_content_hash="h", analysis_status="COMPLETED",
                                        estimated_cost_usd=0.5, started_at=D1)])
    ledger = BigQueryLedger(runner, T)
    assert float(await ledger.month_to_date_usd(A, date(2026, 3, 1))) == pytest.approx(0.5 + 3 * 0.001)  # 3 routes of orgA
    assert float(await ledger.month_to_date_usd(B, date(2026, 3, 1))) == pytest.approx(0.001)
    assert float(await ledger.month_to_date_usd(A, date(2026, 4, 1))) == 0


def test_routing_cost_view_groups_by_route_and_never_mixes_tenants(env):
    db, _ = env
    rows = db.rows("SELECT organization_id, route_key, decisions, cost_usd FROM gold_routing_daily ORDER BY organization_id, route_key")
    assert [(r["organization_id"], r["route_key"], r["decisions"]) for r in rows] == [
        ("orgA", "after_sales", 1), ("orgA", "other", 1), ("orgA", "sales", 1), ("orgB", "after_sales", 1)]


async def test_only_session_keeps_exactly_one_session_and_stays_tenant_scoped(env):
    _, runner = env
    src = BigQuerySource(runner, T)
    page = await src.list_sessions(A, start_date=date(2026, 3, 1), end_date=date(2026, 3, 2), cursor=EPOCH, only_session="s2")
    assert [s["session_id"] for s in page.sessions] == ["s2"]
    none = await src.list_sessions(A, start_date=date(2026, 3, 1), end_date=date(2026, 3, 2), cursor=EPOCH, only_session="nope")
    assert none.sessions == []
