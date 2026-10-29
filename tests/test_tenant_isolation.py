"""Definition of done: tenant isolation tested; every BigQuery read carries organization/workspace filters.

Runs the adapter's real SQL against two tenants that deliberately reuse the same ids.
"""
from datetime import UTC, date, datetime

import pytest

from sci_bq.ledger import BigQueryLedger
from sci_bq.rubric_repo import BigQueryRubricRepository
from sci_bq.source import BigQuerySource, Cursor, Tenant
from sci_bq.tables import Tables
from sci_bq.writer import BigQueryRunStore
from sci_core.loader import RubricLoader
from tests.duck import DuckBQ, DuckRunner

T = Tables(project="my-proj-123")
A, B = Tenant("orgA", "ws1"), Tenant("orgB", "ws1")
A2 = Tenant("orgA", "ws2")  # same org, other workspace
TS = datetime(2026, 3, 1, 10, tzinfo=UTC)
EPOCH = Cursor(datetime(1970, 1, 1, tzinfo=UTC))
DAY = date(2026, 3, 1)


def seed(db: DuckBQ) -> None:
    for t, tag in ((A, "A"), (B, "B"), (A2, "A2")):
        k = {"organization_id": t.organization_id, "workspace_id": t.workspace_id}
        db.insert("sessions", [dict(**k, session_id="s1", status="closed", started_at=TS, updated_at=TS, closed_at=TS)])
        db.insert("messages", [dict(**k, session_id="s1", message_id=f"m-{tag}", sender_type="customer", content=f"secret-{tag}",
                                    created_at=TS, sequence_number=1)])
        db.insert("evaluation_rubrics", [dict(**k, rubric_id="r", version=1, name=f"rubric-{tag}", status="PUBLISHED", created_at=TS)])
        db.insert("evaluation_criteria", [dict(**k, rubric_id="r", rubric_version=1, criterion_id=f"crit-{tag}",
                                               evaluation_instructions="q", evaluation_type="PREDICATE", weight=1, required=False,
                                               enabled=True, score_mapping='{"true":100,"false":0}', display_order=1)])
        db.insert("evaluation_policies", [dict(**k, rubric_id="r", rubric_version=1, minimum_approval_score=70 if tag == "A" else 90)])
        db.insert("session_analyses", [dict(analysis_id=f"an-{tag}", **k, session_id="s1", rubric_id="r", rubric_version=1,
                                            analysis_mode="live", session_content_hash=f"hash-{tag}", analysis_status="COMPLETED",
                                            overall_score=1.0, approval_status="APPROVED", model="m", prompt_version="p",
                                            estimated_cost_usd={"A": 1, "B": 5, "A2": 20}[tag], started_at=TS, completed_at=TS)])
        db.insert("analysis_runs", [dict(run_id="run1", **k, rubric_id="r", rubric_version=1, processing_mode="historical",
                                         run_status="RUNNING", checkpoint=f"cp-{tag}", created_at=TS)])


@pytest.fixture
def env():
    db = DuckBQ()
    seed(db)
    runner = DuckRunner(db)
    return db, runner


async def test_source_reads_are_tenant_scoped(env):
    _, runner = env
    src = BigQuerySource(runner, T)
    for tenant, tag in ((A, "A"), (B, "B"), (A2, "A2")):
        page = await src.list_sessions(tenant, start_date=DAY, end_date=DAY, cursor=EPOCH)
        assert [(s["organization_id"], s["workspace_id"]) for s in page.sessions] == [(tenant.organization_id, tenant.workspace_id)]
        msgs = await src.get_messages(tenant, ["s1"], start_date=DAY, end_date=date(2026, 3, 2))
        assert [m["message_id"] for m in msgs["s1"]] == [f"m-{tag}"]
        one = await src.get_session(tenant, "s1", lookback_days=365, today=date(2026, 3, 5))
        assert one["organization_id"] == tenant.organization_id and one["workspace_id"] == tenant.workspace_id


async def test_unknown_tenant_sees_nothing(env):
    _, runner = env
    ghost = Tenant("orgA", "ws-does-not-exist")
    src = BigQuerySource(runner, T)
    assert (await src.list_sessions(ghost, start_date=DAY, end_date=DAY, cursor=EPOCH)).sessions == []
    assert (await src.get_messages(ghost, ["s1"], start_date=DAY, end_date=DAY))["s1"] == []
    assert await src.get_session(ghost, "s1", lookback_days=365, today=date(2026, 3, 5)) is None


async def test_rubric_config_is_tenant_scoped(env):
    _, runner = env
    repo = BigQueryRubricRepository(runner, T)
    for tenant, tag, threshold in ((A, "A", 70), (B, "B", 90)):
        r = await RubricLoader(repo).load(tenant.organization_id, tenant.workspace_id, "r", 1)
        assert r.name == f"rubric-{tag}" and [c.criterion_id for c in r.criteria] == [f"crit-{tag}"]
        assert r.policy.minimum_approval_score == threshold
    assert await repo.fetch("orgC", "ws1", "r", 1) is None


async def test_run_store_and_ledger_are_tenant_scoped(env):
    _, runner = env
    from sci_bq.writer import BigQueryResultWriter

    class NoWrite(BigQueryResultWriter):
        def __init__(self):  # reads only
            pass

    store = BigQueryRunStore(runner, NoWrite(), T)
    today = date(2026, 3, 5)
    assert (await store.latest(A, "run1", today=today))["checkpoint"] == "cp-A"
    assert (await store.latest(B, "run1", today=today))["checkpoint"] == "cp-B"
    since = date(2026, 1, 1)
    assert await store.existing(A, "r", 1, ["s1"], since=since) == {("s1", "hash-A")}
    assert await store.existing(B, "r", 1, ["s1"], since=since) == {("s1", "hash-B")}
    ledger = BigQueryLedger(runner, T)
    month = date(2026, 3, 1)
    assert await ledger.month_to_date_usd(A, month) == 1 and await ledger.month_to_date_usd(B, month) == 5
    assert await ledger.month_to_date_usd(A2, month) == 20  # another workspace of the same org is NOT pooled
    since_ts = datetime(2026, 3, 1, tzinfo=UTC)
    assert await ledger.analyses_since(A, "r", 1, "s1", since_ts) == 1
    assert await ledger.analyses_since(Tenant("orgC", "ws1"), "r", 1, "s1", since_ts) == 0


async def test_every_executed_query_bound_both_tenant_params(env):
    _, runner = env
    src = BigQuerySource(runner, T)
    await src.list_sessions(A, start_date=DAY, end_date=DAY, cursor=EPOCH)
    await src.get_messages(A, ["s1"], start_date=DAY, end_date=DAY)
    await src.get_session(A, "s1", lookback_days=30, today=DAY)
    await BigQueryRubricRepository(runner, T).fetch("orgA", "ws1", "r", None)
    assert runner.queries
    for sql, params in runner.queries:
        assert params["organization_id"] == "orgA" and params["workspace_id"] == "ws1", sql
        assert "organization_id = @organization_id" in sql and "workspace_id = @workspace_id" in sql


async def test_applicability_rule_is_read_from_the_real_criteria_query(env):
    db, runner = env
    k = {"organization_id": "orgR", "workspace_id": "ws1"}
    db.insert("evaluation_rubrics", [dict(**k, rubric_id="gated", version=1, name="g", status="PUBLISHED", created_at=TS)])
    common = dict(**k, rubric_id="gated", rubric_version=1, evaluation_instructions="q", required=False, enabled=True)
    db.insert("evaluation_criteria", [
        dict(common, criterion_id="has_objection", evaluation_type="PREDICATE", weight=0, score_mapping='{"true":100,"false":0}', display_order=1),
        dict(common, criterion_id="ok", evaluation_type="PREDICATE", weight=5, score_mapping='{"true":100,"false":0}', display_order=2),
        dict(common, criterion_id="objections", evaluation_type="SCORE", weight=20, score_mapping='{"poor":0,"good":100}', display_order=3,
             applicability_rule='{"type":"depends_on","criterion_id":"has_objection","equals":["true"]}'),
    ])
    rubric = await RubricLoader(BigQueryRubricRepository(runner, T)).load("orgR", "ws1", "gated", 1)
    by_id = {c.criterion_id: c for c in rubric.criteria}
    assert by_id["objections"].applicability_rule.criterion_id == "has_objection"
    assert by_id["objections"].applicability_rule.equals == ("true",)
    assert by_id["ok"].applicability_rule is None
