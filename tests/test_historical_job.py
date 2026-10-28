import json
from datetime import UTC, date, datetime, timedelta

import pytest

from sci_bq.source import Cursor, SessionPage, Tenant
from sci_core.budget import PriceBook
from sci_core.engine import EvaluationEngine
from sci_core.hashing import session_content_hash
from sci_core.loader import RubricLoader
from sci_core.provider import ProviderAnswer, ProviderResponse, ProviderUsage
from sci_core.rubric import Rubric
from sci_workers.historical import HistoricalJob, JobConfig

NOW = datetime(2026, 3, 1, tzinfo=UTC)
T = Tenant("demo", "default")


def sess(i):
    ts = datetime(2026, 1, 1, tzinfo=UTC) + timedelta(hours=i)
    return {"session_id": f"s{i:03d}", "started_at": ts, "updated_at": ts, "closed_at": ts, "status": "closed"}


def msgs(i):
    return [{"message_id": f"s{i}-m1", "sequence_number": 1, "sender_type": "customer", "content": "Olá " * 50}]


class FakeSource:
    def __init__(self, n):
        self.sessions = [sess(i) for i in range(n)]
        self.page_calls = 0
        self.message_queries = 0
        self.empty = set()

    async def list_sessions(self, tenant, *, start_date, end_date, cursor, page_size=500, status=None):
        self.page_calls += 1
        rows = [s for s in self.sessions if (s["updated_at"], s["session_id"]) > (cursor.updated_at, cursor.session_id)][:page_size]
        return SessionPage(rows, Cursor(rows[-1]["updated_at"], rows[-1]["session_id"]) if len(rows) == page_size else None)

    async def get_messages(self, tenant, ids, *, start_date, end_date):
        self.message_queries += 1
        return {i: ([] if i in self.empty else msgs(int(i[1:]))) for i in ids}


class MemStore:
    def __init__(self):
        self.runs, self.done = [], set()

    async def latest(self, tenant, run_id):
        return self.runs[-1] if self.runs else None

    async def save(self, run):
        self.runs.append(run)

    async def existing(self, tenant, rid, v, ids, *, since):
        return {k for k in self.done if k[0] in ids}


class MemWriter:
    def __init__(self, store):
        self.analyses, self.criteria, self.store = [], [], store

    async def write(self, a, c):
        self.analyses += a
        self.criteria += c
        self.store.done |= {(x["session_id"], x["session_content_hash"]) for x in a}


class Provider:
    model, prompt_version = "fake", "p1"

    def __init__(self, cost=0.01, fail=()):
        self.cost, self.fail, self.calls = cost, set(fail), 0

    async def evaluate(self, text, criteria):
        self.calls += 1
        if any(f in text for f in self.fail):
            raise RuntimeError("boom")
        return ProviderResponse(
            answers=[ProviderAnswer(criterion_id="greeting", answer=True), ProviderAnswer(criterion_id="needs", answer="complete")],
            usage=ProviderUsage(input_tokens=100, output_tokens=20, estimated_cost_usd=self.cost))


class Repo:
    def __init__(self, r):
        self.r = r

    async def fetch(self, *a):
        return self.r


def build(rubric_json, n=5, *, max_cost=10.0, max_sessions=100, page_size=2, provider=None, source=None, store=None):
    source = source or FakeSource(n)
    store = store or MemStore()
    writer = MemWriter(store)
    provider = provider or Provider()
    cfg = JobConfig(tenant=T, rubric_id="sales_quality", rubric_version=1, start_date=date(2026, 1, 1), end_date=date(2026, 1, 31),
                    prices=PriceBook(1.0, 4.0), max_cost_usd=max_cost, max_sessions=max_sessions, page_size=page_size,
                    max_output_tokens_per_session=100)
    job = HistoricalJob(source=source, store=store, writer=writer, loader=RubricLoader(Repo(Rubric.model_validate(rubric_json))),
                        engine=EvaluationEngine(provider, mode="historical", clock=lambda: NOW), config=cfg, clock=lambda: NOW)
    return job, source, store, writer, provider


async def test_run_requires_approval(rubric_json):
    job, *_ = build(rubric_json)
    with pytest.raises(PermissionError):
        await job.run()


async def test_preflight_makes_no_provider_calls(rubric_json):
    job, _, _, writer, provider = build(rubric_json)
    rep = await job.preflight()
    assert provider.calls == 0 and not writer.analyses
    assert rep.sessions == 5 and rep.to_process == 5 and rep.approvable
    assert rep.estimated_cost_usd_high > rep.estimated_cost_usd_low > 0


async def test_preflight_flags_over_budget_and_session_gate(rubric_json):
    job, *_ = build(rubric_json, max_cost=0.0000001)
    assert not (await job.preflight()).within_budget
    job, *_ = build(rubric_json, max_sessions=3)
    rep = await job.preflight()
    assert not rep.within_session_gate and not rep.approvable


async def test_full_run_checkpoints_and_batches(rubric_json):
    job, source, store, writer, provider = build(rubric_json)
    stats = await job.run(approved=True)
    assert stats.processed == 5 and provider.calls == 5 and len(writer.analyses) == 5 and len(writer.criteria) == 10
    assert [r["run_status"] for r in store.runs] == ["RUNNING"] * 3 + ["COMPLETED"]
    assert json.loads(store.runs[0]["checkpoint"])["session_id"] == "s001"
    assert source.message_queries <= 6  # grouped per page, not per session
    assert store.runs[-1]["finished_at"] and store.runs[-1]["actual_cost_usd"] == pytest.approx(0.05)


async def test_rerun_is_noop_and_resume_skips_done(rubric_json):
    job, _, store, writer, provider = build(rubric_json)
    await job.run(approved=True)
    assert (await job.run(approved=True)).processed == 0  # COMPLETED run
    store.runs.clear()  # lose run state but keep results: dedupe by content hash must prevent re-spend
    calls = provider.calls
    stats = await job.run(approved=True)
    assert provider.calls == calls and stats.processed == 0 and stats.skipped == 5


async def test_resume_from_checkpoint_after_crash(rubric_json):
    prov = Provider(fail=())
    job, source, store, writer, _ = build(rubric_json, provider=prov)
    orig = writer.write
    state = {"n": 0}

    async def flaky(a, c):
        state["n"] += 1
        if state["n"] == 2:
            raise ConnectionError("bq down")
        await orig(a, c)

    writer.write = flaky
    with pytest.raises(ConnectionError):
        await job.run(approved=True)
    assert store.runs[-1]["run_status"] == "FAILED"
    store.runs[-1]["run_status"] = "RUNNING"  # operator relaunch resumes same run_id
    writer.write = orig
    await job.run(approved=True)
    assert len({a["session_id"] for a in writer.analyses}) == 5
    assert len(writer.analyses) == 5  # no duplicate logical results


async def test_budget_stop_fails_closed_and_keeps_work(rubric_json):
    job, _, store, writer, provider = build(rubric_json, max_cost=0.0003, page_size=5)
    stats = await job.run(approved=True)
    assert store.runs[-1]["run_status"] == "BUDGET_STOPPED"
    assert provider.calls < 5 and stats.processed == provider.calls
    assert json.loads(store.runs[-1]["checkpoint"])["session_id"] == ""  # page not completed -> checkpoint not advanced


async def test_session_gate_stops_whole_pages(rubric_json):
    job, _, store, _, provider = build(rubric_json, max_sessions=3, page_size=2)
    await job.run(approved=True)
    assert store.runs[-1]["run_status"] == "SESSION_GATE_STOPPED" and provider.calls == 2


async def test_provider_failure_isolated_and_worst_case_charged(rubric_json):
    prov = Provider(fail=("Olá",))
    job, _, store, writer, _ = build(rubric_json, n=2, provider=prov)
    stats = await job.run(approved=True)
    assert stats.failed == 2 and not writer.analyses and store.runs[-1]["actual_cost_usd"] > 0
    assert store.runs[-1]["run_status"] == "COMPLETED_WITH_FAILURES"  # never "COMPLETED": a relaunch must retry


async def test_relaunch_retries_failed_sessions_and_does_not_redo_analysed(rubric_json):
    prov = Provider(fail=("Olá",))
    job, _, store, writer, _ = build(rubric_json, n=2, provider=prov)
    await job.run(approved=True)
    prov.fail = set()  # the cause is fixed (e.g. model access granted)
    calls = prov.calls
    stats = await job.run(approved=True)
    assert prov.calls == calls + 2 and stats.failed == 0 and len(writer.analyses) == 2
    assert store.runs[-1]["run_status"] == "COMPLETED"
    again = prov.calls
    await job.run(approved=True)  # now final: nothing is re-sent
    assert prov.calls == again


async def test_empty_sessions_skipped_without_ai(rubric_json):
    src = FakeSource(3)
    src.empty = {"s001"}
    job, _, _, _, provider = build(rubric_json, source=src)
    stats = await job.run(approved=True)
    assert stats.skipped == 1 and provider.calls == 2


async def test_results_carry_tenant_and_versions(rubric_json):
    job, _, _, writer, _ = build(rubric_json, n=1)
    await job.run(approved=True)
    a = writer.analyses[0]
    assert (a["organization_id"], a["workspace_id"], a["rubric_version"], a["model"], a["prompt_version"]) == ("demo", "default", 1, "fake", "p1")
    assert a["session_content_hash"] == session_content_hash(msgs(0))
    assert all("content" not in json.dumps(c) for c in writer.criteria)  # no raw chat in results


def test_run_id_deterministic(rubric_json):
    a, *_ = build(rubric_json)
    b, *_ = build(rubric_json)
    assert a._cfg.run_id == b._cfg.run_id
