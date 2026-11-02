"""Recurring executions: a due schedule becomes ONE ordinary request, never twice, never a backlog, never beyond the executor's gates."""
import json
from datetime import UTC, datetime, timedelta

import pytest

from sci_bq.source import Tenant
from sci_console_executor.requests import BigQueryRequestStore, JobOutcome, RequestExecutor, RequestRefused
from sci_console_executor.schedules import (
    MAX_ACTIVE_REQUESTS,
    BigQueryScheduleStore,
    Schedule,
    ScheduleMaterializer,
    due_slot,
    last_slot,
    request_params,
    slot_request_id,
)
from tests.duck import DuckBQ, DuckRunner

A = Tenant("orgA", "ws1")
B = Tenant("orgB", "ws1")
CREATED = datetime(2026, 11, 1, 10, 0, tzinfo=UTC)  # a Sunday


def srow(sid="s1", tenant=A, frequency="DAILY", hour=2, minute=0, weekday=None, status="ACTIVE", changed_at=CREATED, **over):
    base = dict(
        schedule_id=sid, changed_at=changed_at, organization_id=tenant.organization_id, workspace_id=tenant.workspace_id, name="Diária", status=status,
        frequency=frequency, hour_utc=hour, minute_utc=minute, weekday=weekday, rubric_id="sales_quality", rubric_version=5, window_days=7,
        max_sessions=200, only_routed=False, provider="decisions", model="gpt-6-luna", max_cost_usd=0.05, created_by="ana@x.com", created_at=CREATED,
        changed_by="ana@x.com",
    )
    return {**base, **over}


def sched(**kw) -> Schedule:
    return Schedule.from_row({k: v for k, v in srow(**kw).items() if k not in ("status", "created_at", "changed_by")})


# ---------- when a schedule is due ----------
def test_a_daily_schedule_runs_at_its_hour_and_only_the_last_slot_is_ever_due():
    s = sched(changed_at=datetime(2026, 11, 1, 0, 0, tzinfo=UTC))
    assert last_slot(s, datetime(2026, 11, 3, 2, 0, tzinfo=UTC)) == datetime(2026, 11, 3, 2, 0, tzinfo=UTC)
    assert last_slot(s, datetime(2026, 11, 3, 1, 59, tzinfo=UTC)) == datetime(2026, 11, 2, 2, 0, tzinfo=UTC)
    # an executor that was stopped for four days finds ONE slot, not four
    assert due_slot(s, datetime(2026, 11, 6, 9, 0, tzinfo=UTC)) == datetime(2026, 11, 6, 2, 0, tzinfo=UTC)


def test_a_weekly_schedule_runs_on_its_weekday():
    s = sched(frequency="WEEKLY", weekday=2, hour=4, minute=30, changed_at=datetime(2026, 10, 1, tzinfo=UTC))  # Wednesday 04:30
    assert last_slot(s, datetime(2026, 11, 4, 4, 30, tzinfo=UTC)) == datetime(2026, 11, 4, 4, 30, tzinfo=UTC)  # 2026-11-04 is a Wednesday
    assert last_slot(s, datetime(2026, 11, 4, 4, 29, tzinfo=UTC)) == datetime(2026, 10, 28, 4, 30, tzinfo=UTC)
    assert last_slot(s, datetime(2026, 11, 8, 23, 0, tzinfo=UTC)) == datetime(2026, 11, 4, 4, 30, tzinfo=UTC)


def test_a_change_counts_from_the_next_slot_never_from_one_already_in_the_past():
    s = sched(changed_at=datetime(2026, 11, 1, 10, 0, tzinfo=UTC))  # created, edited or resumed at 10:00 on Sunday
    assert due_slot(s, datetime(2026, 11, 1, 10, 5, tzinfo=UTC)) is None  # today's 02:00 had already passed
    assert due_slot(s, datetime(2026, 11, 2, 1, 0, tzinfo=UTC)) is None
    assert due_slot(s, datetime(2026, 11, 2, 2, 0, tzinfo=UTC)) == datetime(2026, 11, 2, 2, 0, tzinfo=UTC)


def test_the_request_id_is_stable_per_slot_and_differs_by_schedule_slot_and_workspace():
    s, slot = sched(), datetime(2026, 11, 2, 2, 0, tzinfo=UTC)
    assert slot_request_id(s, slot) == slot_request_id(s, slot) and slot_request_id(s, slot).startswith("sched-")
    assert slot_request_id(s, slot) != slot_request_id(s, slot + timedelta(days=1))
    assert slot_request_id(s, slot) != slot_request_id(sched(sid="s2"), slot)
    assert slot_request_id(s, slot) != slot_request_id(sched(tenant=B), slot)


def test_the_window_rolls_back_from_the_day_of_the_slot_and_carries_the_schedule_id():
    p = request_params(sched(window_days=7), datetime(2026, 11, 2, 2, 0, tzinfo=UTC))
    assert (p["start"], p["end"]) == ("2026-10-26", "2026-11-02") and p["schedule_id"] == "s1"
    assert (p["rubric_id"], p["rubric_version"], p["provider"], p["model"], p["max_sessions"]) == ("sales_quality", 5, "decisions", "gpt-6-luna", 200)


@pytest.mark.parametrize("over", [
    {"frequency": "MONTHLY"}, {"hour": 24}, {"minute": 60}, {"frequency": "WEEKLY", "weekday": None}, {"frequency": "DAILY", "weekday": 1},
    {"window_days": 0}, {"window_days": 400}, {"max_cost_usd": 0}, {"model": "gpt-9"}, {"provider": "responses", "model": "gpt-6-luna"},
])
def test_a_stored_schedule_is_validated_again(over):
    with pytest.raises(Exception):  # noqa: B017  (pydantic ValidationError, ValueError or UnknownModel: all mean refused)
        sched(**over)


# ---------- the materializer, with an in-memory store ----------
class Mem:
    def __init__(self, rows, active=()):
        self.rows, self.active, self.created = list(rows), list(active), []

    async def schedules(self, tenant):
        return [r for r in self.rows if r["organization_id"] == tenant.organization_id]

    async def active_requests(self, tenant):
        return [dict(a) for a in self.active]

    async def create_request(self, s, request_id, params):
        self.created.append((s.schedule_id, request_id, params))


def at(day, hour, minute=0):
    return datetime(2026, 11, day, hour, minute, tzinfo=UTC)


async def test_a_due_schedule_creates_one_request_per_slot():
    store = Mem([srow(changed_at=at(1, 0))])
    out = await ScheduleMaterializer(store, clock=lambda: at(3, 2, 5)).run([A])
    assert len(out.created) == 1 and len(store.created) == 1
    sid, rid, params = store.created[0]
    assert sid == "s1" and rid == out.created[0] and params["end"] == "2026-11-03"
    fresh = Mem([srow(changed_at=at(3, 0, 30))])  # created half an hour before the 02:00 slot: nothing is due until 02:00
    assert (await ScheduleMaterializer(fresh, clock=lambda: at(3, 1, 0)).run([A])).created == []
    assert len((await ScheduleMaterializer(fresh, clock=lambda: at(3, 2, 1)).run([A])).created) == 1


async def test_a_schedule_that_is_not_active_or_not_due_creates_nothing():
    store = Mem([srow(changed_at=at(3, 9))])  # edited this morning, after today's slot
    assert (await ScheduleMaterializer(store, clock=lambda: at(3, 12)).run([A])).created == []


async def test_the_same_slot_is_not_created_again_while_its_request_is_waiting():
    s = sched(changed_at=at(1, 0))
    rid = slot_request_id(s, at(3, 2))
    store = Mem([srow(changed_at=at(1, 0))], active=[{"request_id": rid, "schedule_id": "s1"}])
    assert (await ScheduleMaterializer(store, clock=lambda: at(3, 5)).run([A])).created == []


async def test_two_runs_of_the_same_schedule_never_overlap():
    store = Mem([srow(changed_at=at(1, 0))], active=[{"request_id": "sched-old", "schedule_id": "s1"}])
    out = await ScheduleMaterializer(store, clock=lambda: at(3, 5)).run([A])
    assert out.created == [] and out.skipped == {"s1": "previous_run_still_active"}


async def test_a_busy_workspace_waits_and_the_slot_is_retried_on_the_next_poll():
    busy = [{"request_id": f"r{i}", "schedule_id": None} for i in range(MAX_ACTIVE_REQUESTS)]
    store = Mem([srow(changed_at=at(1, 0))], active=busy)
    out = await ScheduleMaterializer(store, clock=lambda: at(3, 5)).run([A])
    assert out.created == [] and out.skipped == {"s1": "workspace_busy"}
    store.active = []  # the queue drained: the same slot is still the last one
    assert len((await ScheduleMaterializer(store, clock=lambda: at(3, 20)).run([A])).created) == 1


async def test_one_poll_never_creates_more_than_the_workspace_limit():
    rows = [srow(sid=f"s{i}", changed_at=at(1, 0)) for i in range(6)]
    store = Mem(rows)
    out = await ScheduleMaterializer(store, clock=lambda: at(3, 5)).run([A])
    assert len(out.created) == MAX_ACTIVE_REQUESTS and sum(1 for v in out.skipped.values() if v == "workspace_busy") == 3


async def test_an_invalid_stored_schedule_is_skipped_and_the_others_still_run():
    store = Mem([srow(sid="bad", model="gpt-9", changed_at=at(1, 0)), srow(sid="good", changed_at=at(1, 0))])
    out = await ScheduleMaterializer(store, clock=lambda: at(3, 5)).run([A])
    assert out.skipped == {"bad": "invalid"} and [c[0] for c in store.created] == ["good"]


# ---------- the BigQuery store (real SQL on DuckDB) ----------
@pytest.fixture
def env():
    db = DuckBQ()
    runner = DuckRunner(db)
    return db, runner, BigQueryScheduleStore(runner, "my-proj-123")


async def test_only_the_latest_row_of_an_active_schedule_is_read_and_only_for_its_tenant(env):
    db, _, store = env
    db.insert("run_schedules", [
        srow("s1", changed_at=at(1, 1)), srow("s1", status="PAUSED", changed_at=at(1, 5)),  # paused later: not active any more
        srow("s2", changed_at=at(1, 1)), srow("s2", changed_at=at(1, 6), name="Renomeada"),  # edited: the latest wins
        srow("s3", tenant=B, changed_at=at(1, 1)), srow("s4", status="ARCHIVED", changed_at=at(1, 1)),
    ])
    rows = await store.schedules(A)
    assert [(r["schedule_id"], r["name"]) for r in rows] == [("s2", "Renomeada")]
    assert [r["schedule_id"] for r in await store.schedules(B)] == ["s3"]


async def test_a_created_request_is_an_ordinary_waiting_request_of_the_creator_and_a_repeat_writes_nothing(env):
    db, runner, store = env
    s = sched(changed_at=at(1, 0))
    slot = at(3, 2)
    rid, params = slot_request_id(s, slot), request_params(s, slot)
    await store.create_request(s, rid, params)
    await store.create_request(s, rid, params)  # a second poll, or a second executor
    rows = db.rows("SELECT request_id, kind, status, requested_by, changed_by, max_cost_usd, params FROM run_requests")
    assert len(rows) == 1 and rows[0]["kind"] == "ANALYSIS" and rows[0]["status"] == "REQUESTED"
    assert rows[0]["requested_by"] == "ana@x.com" and rows[0]["changed_by"] == "scheduler:s1" and rows[0]["max_cost_usd"] == 0.05
    # the request store (the ordinary path) sees it as waiting and the stored params are exactly what the executor validates
    pend = await BigQueryRequestStore(runner, "my-proj-123").pending(A, 10)
    assert [p["request_id"] for p in pend] == [rid] and json.loads(rows[0]["params"]) == params  # the params are stored as the executor validates them
    assert await store.active_requests(A) == [{"request_id": rid, "schedule_id": "s1"}]
    assert await store.active_requests(B) == []


async def test_every_statement_is_tenant_scoped(env):
    db, runner, store = env
    seen = []
    orig = runner.query

    async def spy(sql, params=None):
        seen.append((sql, params))
        return await orig(sql, params)

    runner.query = spy
    s = sched(changed_at=at(1, 0))
    await store.schedules(A)
    await store.active_requests(A)
    await store.create_request(s, "sched-x", request_params(s, at(3, 2)))
    assert seen and all("organization_id = @organization_id AND workspace_id = @workspace_id" in sql for sql, _ in seen)
    assert all(p["organization_id"] == "orgA" and p["workspace_id"] == "ws1" for _, p in seen)


async def test_a_request_made_by_a_schedule_is_executed_like_any_other_request_and_obeys_the_same_gates():
    class Store:
        def __init__(self, admin):
            self.admin, self.finished = admin, []

        async def pending(self, tenant, limit):
            s = sched(changed_at=at(1, 0))
            slot = at(3, 2)
            return [dict(request_id=slot_request_id(s, slot), organization_id="orgA", workspace_id="ws1", kind="ANALYSIS",
                         params=json.dumps(request_params(s, slot)), max_cost_usd=0.05, requested_by="ana@x.com", requested_at=at(3, 2))]

        async def claim(self, r, eid):
            return True

        async def finish(self, r, eid, status, result, error):
            self.finished.append((status, error))

        async def is_active_admin(self, tenant, email):
            return self.admin

    class Jobs:
        ran = []

        async def run(self, req):
            self.ran.append(req)
            return JobOutcome("COMPLETED", {"processed": 2})

    ok = Store(True)
    jobs = Jobs()
    ex = RequestExecutor(store=ok, jobs=jobs, executor_id="e", max_cost_ceiling=1.0, max_sessions_ceiling=1000, clock=lambda: at(3, 3))
    assert await ex.run_once([A], 3) and ok.finished == [("COMPLETED", None)] and jobs.ran[0].params.schedule_id == "s1"
    gone = Store(False)  # the person who created the schedule is no longer an active ADMIN
    jobs2 = Jobs()
    jobs2.ran = []
    ex2 = RequestExecutor(store=gone, jobs=jobs2, executor_id="e", max_cost_ceiling=1.0, max_sessions_ceiling=1000, clock=lambda: at(3, 3))
    await ex2.run_once([A], 3)
    assert gone.finished[0][0] == "FAILED" and "administrador" in gone.finished[0][1] and jobs2.ran == []
    assert RequestRefused  # the same refusal as for a request made by hand


# ---------- the executor's monthly budget ----------
class Ledger:
    def __init__(self, spent):
        self.spent, self.asked = spent, []

    async def month_to_date_usd(self, tenant, month_start):
        self.asked.append((tenant, month_start))
        return self.spent


def _one_request_store():
    class S:
        finished = []

        async def pending(self, tenant, limit):
            return [dict(request_id="r1", organization_id="orgA", workspace_id="ws1", kind="ROUTING", max_cost_usd=0.05, requested_by="ana@x.com",
                         requested_at=at(3, 2), params=json.dumps({"start": "2026-10-01", "end": "2026-10-30", "max_sessions": 50}))]

        async def claim(self, r, eid):
            return True

        async def finish(self, r, eid, status, result, error):
            self.finished.append((status, error))

        async def is_active_admin(self, tenant, email):
            return True

    return S()


class _Jobs:
    def __init__(self):
        self.ran = []

    async def run(self, req):
        self.ran.append(req)
        return JobOutcome("COMPLETED", {})


async def test_a_request_that_would_pass_the_monthly_budget_is_refused_with_the_numbers_and_never_runs():
    store, jobs, ledger = _one_request_store(), _Jobs(), Ledger(0.47)
    ex = RequestExecutor(store=store, jobs=jobs, executor_id="e", max_cost_ceiling=1.0, max_sessions_ceiling=1000, clock=lambda: at(3, 3),
                         ledger=ledger, monthly_budget_usd=0.5)
    await ex.run_once([A], 3)
    status, error = store.finished[0]
    assert status == "FAILED" and jobs.ran == [] and "US$ 0.5000" in error and "US$ 0.4700" in error and "US$ 0.0500" in error
    assert ledger.asked[0][0] == A and ledger.asked[0][1].isoformat() == "2026-11-01"  # this workspace, this month


async def test_a_request_that_fits_the_monthly_budget_runs():
    store, jobs = _one_request_store(), _Jobs()
    ex = RequestExecutor(store=store, jobs=jobs, executor_id="e", max_cost_ceiling=1.0, max_sessions_ceiling=1000, clock=lambda: at(3, 3),
                         ledger=Ledger(0.40), monthly_budget_usd=0.5)
    await ex.run_once([A], 3)
    assert store.finished[0][0] == "COMPLETED" and len(jobs.ran) == 1
