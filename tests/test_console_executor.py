"""The executor of console requests: re-validates, claims once, applies the requester's ceiling, never trusts the table."""
import json
from datetime import UTC, date, datetime

import pytest

from sci_bq.source import Tenant
from sci_console_executor.requests import (
    BigQueryRequestStore,
    JobOutcome,
    RequestExecutor,
    RequestRefused,
    parse_request,
)
from tests.duck import DuckBQ, DuckRunner

T = Tenant("orgA", "ws1")
TB = Tenant("orgB", "ws1")
NOW = datetime(2026, 10, 31, 12, tzinfo=UTC)
TODAY = date(2026, 10, 31)
D0 = datetime(2026, 10, 30, 10, tzinfo=UTC)


def row(request_id="r1", kind="ROUTING", params=None, cap=0.05, by="ana@x.com", tenant=T, status="REQUESTED", changed_by=None, at=D0):
    return dict(
        request_id=request_id, changed_at=at, organization_id=tenant.organization_id, workspace_id=tenant.workspace_id, kind=kind, status=status,
        params=json.dumps(params or {"start": "2026-10-01", "end": "2026-10-30", "max_sessions": 50}), max_cost_usd=cap, estimate_low_usd=0.001,
        estimate_high_usd=0.004, requested_by=by, requested_at=D0, changed_by=changed_by or by,
    )


def pending_row(**kw):
    r = row(**kw)
    return {k: r[k] for k in ("request_id", "organization_id", "workspace_id", "kind", "params", "max_cost_usd", "requested_by", "requested_at")}


# ---------- validation: the table is data, not authority ----------
@pytest.mark.parametrize(
    "over",
    [
        {"kind": "DROP_TABLE"},
        {"params": '{"start": "2026-10-01", "end": "2026-10-30", "max_sessions": 50, "model": "gpt-9"}'},  # unknown field
        {"params": "not json"},
        {"cap": 5.0},  # above the executor ceiling
        {"cap": 0},
        {"params": json.dumps({"start": "2026-10-30", "end": "2026-10-01", "max_sessions": 5})},
        {"params": json.dumps({"start": "2024-01-01", "end": "2026-10-01", "max_sessions": 5})},
        {"params": json.dumps({"start": "2026-10-01", "end": "2999-01-01", "max_sessions": 5})},
        {"params": json.dumps({"start": "2026-10-01", "end": "2026-10-30", "max_sessions": 5000})},
        {"kind": "ANALYSIS"},  # analysis without a rubric
        {"kind": "SESSION_ANALYSIS", "params": json.dumps({"session_id": "s1"})},  # no rubric
    ],
)
def test_invalid_requests_are_refused(over):
    base = pending_row()
    r = {**base, **{k: v for k, v in over.items() if k in base}}
    if "cap" in over:
        r["max_cost_usd"] = over["cap"]
    with pytest.raises(RequestRefused):
        parse_request(r, max_cost_ceiling=1.0, max_sessions_ceiling=1000, today=TODAY)


def test_valid_requests_parse_for_every_kind():
    ok = lambda r: parse_request(r, max_cost_ceiling=1.0, max_sessions_ceiling=1000, today=TODAY)  # noqa: E731
    assert ok(pending_row()).kind == "ROUTING"
    a = ok(pending_row(kind="ANALYSIS", params={"start": "2026-10-01", "end": "2026-10-30", "max_sessions": 10, "rubric_id": "r", "rubric_version": 5, "only_routed": True}))
    assert a.params.only_routed and a.tenant == T and a.requested_by == "ana@x.com"
    s = ok(pending_row(kind="SESSION_ANALYSIS", params={"session_id": "s0151", "rubric_id": "r", "rubric_version": 1}))
    assert s.params.session_id == "s0151"


# ---------- the executor loop ----------
class MemStore:
    def __init__(self, rows, admins=("ana@x.com",)):
        self.rows, self.admins, self.claimed, self.finished, self.cancel_before_claim = list(rows), set(admins), [], [], set()

    async def pending(self, tenant, limit):
        return [r for r in self.rows if (r["organization_id"], r["workspace_id"]) == (tenant.organization_id, tenant.workspace_id)][:limit]

    async def claim(self, r, executor_id):
        if r["request_id"] in self.cancel_before_claim:
            return False
        self.claimed.append((r["request_id"], executor_id))
        return True

    async def finish(self, r, executor_id, status, result, error):
        self.finished.append((r["request_id"], status, result, error))

    async def is_active_admin(self, tenant, email):
        return email in self.admins


class Jobs:
    def __init__(self, outcome=None, boom=None):
        self.ran, self.outcome, self.boom = [], outcome or JobOutcome("COMPLETED", {"processed": 3, "spent_usd": 0.001}), boom

    async def run(self, req):
        self.ran.append(req)
        if self.boom:
            raise self.boom
        return self.outcome


def executor(store, jobs):
    return RequestExecutor(store=store, jobs=jobs, executor_id="ex-1", max_cost_ceiling=1.0, max_sessions_ceiling=1000, clock=lambda: NOW)


async def test_runs_a_valid_request_and_records_the_result():
    store, jobs = MemStore([pending_row()]), Jobs()
    assert await executor(store, jobs).run_once([T], 3) == [("r1", "COMPLETED")]
    assert store.claimed == [("r1", "ex-1")] and store.finished == [("r1", "COMPLETED", {"processed": 3, "spent_usd": 0.001}, None)]
    assert jobs.ran[0].max_cost_usd == 0.05  # the requester's ceiling is what the job is bounded by


async def test_a_request_that_is_no_longer_waiting_is_skipped_without_running_anything():
    store, jobs = MemStore([pending_row()]), Jobs()
    store.cancel_before_claim = {"r1"}
    assert await executor(store, jobs).run_once([T], 3) == [] and jobs.ran == [] and store.finished == []


async def test_requester_who_is_no_longer_an_admin_is_refused_and_nothing_runs():
    store, jobs = MemStore([pending_row(by="ex-admin@x.com")]), Jobs()
    assert await executor(store, jobs).run_once([T], 3) == [("r1", "FAILED")]
    assert jobs.ran == [] and "não é mais administrador" in store.finished[0][3]


async def test_invalid_or_forged_rows_end_as_failed_with_a_reason_and_never_reach_the_jobs():
    store, jobs = MemStore([pending_row(request_id="r1", cap=99.0), pending_row(request_id="r2", kind="NOPE")]), Jobs()
    assert await executor(store, jobs).run_once([T], 5) == [("r1", "FAILED"), ("r2", "FAILED")]
    assert jobs.ran == []


async def test_a_refused_preflight_is_reported_to_the_admin():
    class Refusing(Jobs):
        async def run(self, req):
            raise RequestRefused("Pré-voo não aprovado: estimativa máxima US$ 0.2 (teto US$ 0.05).")

    store = MemStore([pending_row()])
    assert await executor(store, Refusing()).run_once([T], 3) == [("r1", "FAILED")]
    assert "teto US$ 0.05" in store.finished[0][3]


async def test_an_unexpected_error_shows_only_its_type_never_its_message():
    store = MemStore([pending_row()])
    await executor(store, Jobs(boom=RuntimeError("secret conversation text: CPF 123.456.789-09"))).run_once([T], 3)
    err = store.finished[0][3]
    assert "RuntimeError" in err and "CPF" not in err and "secret" not in err


async def test_job_statuses_pass_through_and_only_the_named_tenants_are_served():
    store = MemStore([pending_row(request_id="a"), pending_row(request_id="b", tenant=TB)])
    jobs = Jobs(JobOutcome("BUDGET_STOPPED", {"processed": 1}))
    assert await executor(store, jobs).run_once([T], 3) == [("a", "BUDGET_STOPPED")]  # orgB was not named
    assert [r.tenant for r in jobs.ran] == [T]


async def test_limit_bounds_how_many_requests_one_invocation_takes():
    store = MemStore([pending_row(request_id=f"r{i}") for i in range(5)])
    assert len(await executor(store, Jobs()).run_once([T], 2)) == 2


# ---------- the BigQuery store (real SQL, DuckDB) ----------
@pytest.fixture
def env():
    db = DuckBQ()
    db.insert("run_requests", [row("r1"), row("r2", tenant=TB), row("r3", status="CANCELLED", changed_by="ana@x.com")])
    db.insert("app_users", [
        dict(organization_id="orgA", workspace_id="ws1", email="ana@x.com", role="ADMIN", status="ACTIVE", changed_at=D0, changed_by="boot"),
        dict(organization_id="orgA", workspace_id="ws1", email="edu@x.com", role="EDITOR", status="ACTIVE", changed_at=D0, changed_by="boot"),
        dict(organization_id="orgA", workspace_id="ws1", email="old@x.com", role="ADMIN", status="ACTIVE", changed_at=D0, changed_by="boot"),
        dict(organization_id="orgA", workspace_id="ws1", email="old@x.com", role="ADMIN", status="DISABLED", changed_at=NOW, changed_by="boot"),
    ])
    runner = DuckRunner(db)
    return db, runner, BigQueryRequestStore(runner, "my-proj-123")


async def test_pending_returns_only_waiting_requests_of_the_tenant(env):
    _, _, store = env
    assert [r["request_id"] for r in await store.pending(T, 10)] == ["r1"]  # r3 is cancelled, r2 belongs to orgB
    assert [r["request_id"] for r in await store.pending(TB, 10)] == ["r2"]


async def test_claim_then_finish_follow_the_state_machine_and_the_latest_row_wins(env):
    db, _, store = env
    r1 = (await store.pending(T, 10))[0]
    assert await store.claim(r1, "ex-1") is True
    assert await store.pending(T, 10) == []  # RUNNING is no longer waiting
    assert await store.claim(r1, "ex-2") is False  # nobody else can take it
    await store.finish(r1, "ex-2", "COMPLETED", {"processed": 1}, None)  # only the claimer may finish
    latest = db.rows("SELECT status, changed_by FROM run_requests WHERE request_id = 'r1' ORDER BY changed_at DESC, status DESC")[0]
    assert latest["status"] == "RUNNING"
    await store.finish(r1, "ex-1", "COMPLETED", {"processed": 1}, None)
    done = db.rows("SELECT status, changed_by, result FROM run_requests WHERE request_id = 'r1' AND status = 'COMPLETED'")
    assert len(done) == 1 and done[0]["changed_by"] == "ex-1" and json.loads(done[0]["result"]) == {"processed": 1}


async def test_a_cancelled_request_cannot_be_claimed(env):
    _, _, store = env
    cancelled = {**pending_row(request_id="r3")}
    assert await store.claim(cancelled, "ex-1") is False


async def test_admin_check_uses_the_latest_membership_row_of_the_tenant(env):
    _, _, store = env
    assert await store.is_active_admin(T, "ana@x.com") is True
    assert await store.is_active_admin(T, "edu@x.com") is False  # an editor is not enough
    assert await store.is_active_admin(T, "old@x.com") is False  # disabled later
    assert await store.is_active_admin(TB, "ana@x.com") is False  # a member of another workspace
    assert await store.is_active_admin(T, "ANA@X.COM") is True


async def test_every_statement_is_tenant_scoped(env):
    _, runner, store = env
    r1 = (await store.pending(T, 10))[0]
    await store.claim(r1, "ex-1")
    await store.finish(r1, "ex-1", "FAILED", None, "x")
    await store.is_active_admin(T, "ana@x.com")
    assert runner.queries and all("organization_id = @organization_id AND workspace_id = @workspace_id" in q for q, _ in runner.queries)


def test_cli_requires_prices_for_once_and_a_model_for_responses():
    from sci_console_executor.main import parse

    with pytest.raises(SystemExit):
        parse(["once", "--project", "my-proj-123", "--tenant", "orgA/ws1"])
    with pytest.raises(SystemExit):
        parse(["once", "--project", "my-proj-123", "--tenant", "orgA/ws1", "--input-price-per-million", "1", "--output-price-per-million", "2",
               "--provider", "responses"])
    with pytest.raises(SystemExit):
        parse(["list", "--project", "my-proj-123", "--tenant", "no-workspace"])
    a = parse(["list", "--project", "my-proj-123", "--tenant", "orgA/ws1", "--tenant", "orgB/ws1"])
    assert [(t.organization_id, t.workspace_id) for t in a.tenant] == [("orgA", "ws1"), ("orgB", "ws1")]
