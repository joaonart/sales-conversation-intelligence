import base64
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import jsonschema
import pytest
from fastapi.testclient import TestClient

from sci_bq.source import Tenant
from sci_core.budget import PriceBook
from sci_core.engine import EvaluationEngine
from sci_core.hashing import session_content_hash
from sci_core.loader import RubricLoader
from sci_core.provider import ProviderAnswer, ProviderResponse, ProviderUsage
from sci_core.rubric import Rubric
from sci_workers.historical import HistoricalJob, JobConfig
from sci_workers.live import LiveProcessor, Outcome, SessionUpdateEvent, TenantLiveConfig
from sci_workers.live_app import create_app
from sci_workers.live_auth import AuthError

NOW = datetime(2026, 3, 10, 12, tzinfo=UTC)
UPD = datetime(2026, 3, 10, 11, 50, tzinfo=UTC)
MSGS = [{"message_id": "m1", "sequence_number": 1, "sender_type": "customer", "content": "Olá, quanto custa?"},
        {"message_id": "m2", "sequence_number": 2, "sender_type": "seller", "content": "Olá! R$ 199."}]
SESSION = {"session_id": "s1", "started_at": UPD - timedelta(hours=1), "updated_at": UPD, "closed_at": None}
CONTRACT = json.loads((Path(__file__).parent.parent / "contracts" / "session-update.schema.json").read_text())


def event(**kw):
    base = dict(event_id="e1", organization_id="demo", workspace_id="default", session_id="s1", source_updated_at=UPD)
    return SessionUpdateEvent(**{**base, **kw})


class Source:
    def __init__(self, session=SESSION, messages=MSGS):
        self.session, self.messages, self.tenants_seen = session, messages, []

    async def get_session(self, tenant, sid, **kw):
        self.tenants_seen.append(tenant)
        return self.session

    async def get_messages(self, tenant, ids, **kw):
        self.tenants_seen.append(tenant)
        return {i: self.messages for i in ids}


class Store:
    def __init__(self, done=()):
        self.runs, self.done = [], set(done)

    async def save(self, run):
        self.runs.append(run)

    async def existing(self, tenant, rid, v, ids, *, since):
        return self.done


class Ledger:
    def __init__(self, spent=0.0, recent=0):
        self.spent, self.recent, self.calls = spent, recent, 0

    async def month_to_date_usd(self, tenant, month_start):
        self.calls += 1
        return self.spent

    async def analyses_since(self, *a):
        return self.recent


class Writer:
    def __init__(self):
        self.analyses, self.criteria = [], []

    async def write(self, a, c):
        self.analyses += a
        self.criteria += c


class Provider:
    model, prompt_version = "fake", "p1"

    def __init__(self):
        self.calls = 0

    async def evaluate(self, text, criteria):
        self.calls += 1
        return ProviderResponse(
            answers=[ProviderAnswer(criterion_id="greeting", answer=True), ProviderAnswer(criterion_id="needs", answer="complete")],
            usage=ProviderUsage(input_tokens=50, output_tokens=10, estimated_cost_usd=0.001))


class Repo:
    def __init__(self, r):
        self.r = r

    async def fetch(self, *a):
        return self.r


def make(rubric_json, *, source=None, store=None, ledger=None, ai=True, policy=None, tenants=None):
    rj = {**rubric_json, "policy": {**rubric_json["policy"], **(policy or {})}}
    provider, writer = Provider(), Writer()
    store = store or Store()
    ledger = ledger or Ledger()
    proc = LiveProcessor(
        tenants=tenants or {("demo", "default"): TenantLiveConfig("sales_quality", 1)}, source=source or Source(), store=store,
        ledger=ledger, writer=writer, loader=RubricLoader(Repo(Rubric.model_validate(rj))),
        engine=EvaluationEngine(provider, mode="live", clock=lambda: NOW) if ai else None,
        prices=PriceBook(1, 4), default_monthly_budget_usd=5.0, clock=lambda: NOW)
    return proc, provider, writer, store, ledger


def test_event_matches_published_contract():
    ok = {"event_id": "e", "organization_id": "o", "workspace_id": "w", "session_id": "s", "source_updated_at": "2026-03-10T11:50:00Z"}
    jsonschema.validate(ok, CONTRACT)
    assert SessionUpdateEvent.model_validate(ok).session_id == "s"
    for bad in ({**ok, "extra": 1}, {k: v for k, v in ok.items() if k != "session_id"}, {**ok, "source_updated_at": "2026-03-10T11:50:00"}):
        with pytest.raises(Exception):  # noqa: B017
            SessionUpdateEvent.model_validate(bad)


def test_debounce_key_groups_window_and_isolates_tenants():
    a = event().debounce_key(120)
    assert a == event(event_id="other", source_updated_at=UPD + timedelta(seconds=30)).debounce_key(120)
    assert a != event(source_updated_at=UPD + timedelta(seconds=300)).debounce_key(120)
    assert a != event(organization_id="other").debounce_key(120)
    assert a != event(session_id="s2").debounce_key(120)


async def test_evaluates_and_traces(rubric_json):
    proc, provider, writer, store, _ = make(rubric_json)
    assert await proc.process(event()) is Outcome.EVALUATED
    assert provider.calls == 1 and len(writer.analyses) == 1 and len(writer.criteria) == 2
    assert writer.analyses[0]["analysis_mode"] == "live"
    assert store.runs[-1]["run_status"] == "EVALUATED" and store.runs[-1]["processing_mode"] == "live"


async def test_unchanged_content_makes_no_ai_call(rubric_json):
    proc, provider, writer, store, _ = make(rubric_json, store=Store({("s1", session_content_hash(MSGS))}))
    assert await proc.process(event()) is Outcome.DUPLICATE_CONTENT
    assert provider.calls == 0 and not writer.analyses and store.runs[-1]["run_status"] == "DUPLICATE_CONTENT"


async def test_live_equals_historical(rubric_json):
    from tests.test_historical_job import FakeSource, MemStore, MemWriter  # reuse fakes

    proc, _, writer, *_ = make(rubric_json)
    await proc.process(event())
    live = writer.analyses[0]

    class HSource(FakeSource):
        async def get_messages(self, tenant, ids, **kw):
            return {i: MSGS for i in ids}

    src = HSource(1)
    src.sessions[0]["session_id"] = "s1"
    store = MemStore()
    hw = MemWriter(store)
    cfg = JobConfig(tenant=Tenant("demo", "default"), rubric_id="sales_quality", rubric_version=1, start_date=NOW.date(),
                    end_date=NOW.date(), prices=PriceBook(1, 4), max_cost_usd=10, max_sessions=10)
    job = HistoricalJob(source=src, store=store, writer=hw, loader=RubricLoader(Repo(Rubric.model_validate(rubric_json))),
                        engine=EvaluationEngine(Provider(), mode="historical", clock=lambda: NOW), config=cfg, clock=lambda: NOW)
    await job.run(approved=True)
    hist = hw.analyses[0]
    assert hist["analysis_id"] == live["analysis_id"]
    assert (hist["overall_score"], hist["approval_status"]) == (live["overall_score"], live["approval_status"])


async def test_source_behind_event_retries(rubric_json):
    from sci_workers.live import NotReady
    proc, provider, *_ = make(rubric_json, source=Source({**SESSION, "updated_at": UPD - timedelta(minutes=5)}))
    with pytest.raises(NotReady):
        await proc.process(event())
    with pytest.raises(NotReady):
        await make(rubric_json, source=Source(None))[0].process(event())
    assert provider.calls == 0


async def test_unknown_tenant_rejected_before_any_read(rubric_json):
    from sci_workers.live import UnauthorizedTenant
    src = Source()
    proc, *_ = make(rubric_json, source=src)
    with pytest.raises(UnauthorizedTenant):
        await proc.process(event(organization_id="intruder"))
    assert src.tenants_seen == []


async def test_reads_are_scoped_to_event_tenant(rubric_json):
    src = Source()
    proc, *_ = make(rubric_json, source=src)
    await proc.process(event())
    assert set(src.tenants_seen) == {Tenant("demo", "default")}


async def test_rate_limit(rubric_json):
    proc, provider, _, store, _ = make(rubric_json, ledger=Ledger(recent=2), policy={"max_analyses_per_session": 2})
    assert await proc.process(event()) is Outcome.RATE_LIMITED and provider.calls == 0


async def test_budget_blocks_and_is_traced(rubric_json):
    proc, provider, _, store, _ = make(rubric_json, ledger=Ledger(spent=4.9999999), policy={"monthly_budget_usd": 5})
    assert await proc.process(event()) is Outcome.BUDGET_BLOCKED
    assert provider.calls == 0 and store.runs[-1]["run_status"] == "BUDGET_BLOCKED"


async def test_ledger_failure_fails_closed(rubric_json):
    class Broken(Ledger):
        async def month_to_date_usd(self, *a):
            raise ConnectionError("bq")

    proc, provider, *_ = make(rubric_json, ledger=Broken())
    with pytest.raises(ConnectionError):
        await proc.process(event())
    assert provider.calls == 0


async def test_token_limit_policy(rubric_json):
    proc, provider, *_ = make(rubric_json, policy={"max_input_tokens": 1})
    assert await proc.process(event()) is Outcome.TOKEN_LIMIT and provider.calls == 0


# ---- HTTP layer ----
class Verifier:
    def __init__(self, ok=True):
        self.ok = ok

    def verify(self, auth):
        if not self.ok or auth != "Bearer good":
            raise AuthError("no")
        return "sa@x"


class Sched:
    def __init__(self):
        self.calls = []

    async def schedule(self, ev, delay):
        self.calls.append((ev, delay))
        return True


def client(rubric_json, **kw):
    proc, provider, writer, *_ = make(rubric_json, **kw)
    sched = Sched()
    return TestClient(create_app(processor=proc, scheduler=sched, push_verifier=Verifier(), tasks_verifier=Verifier())), sched, provider, writer


def push_body(ev=None, raw=None):
    data = raw if raw is not None else (ev or event()).model_dump_json().encode()
    return {"message": {"data": base64.b64encode(data).decode(), "messageId": "1"}, "subscription": "s"}


AUTH = {"Authorization": "Bearer good"}


def test_push_requires_oidc(rubric_json):
    c, sched, *_ = client(rubric_json)
    assert c.post("/pubsub/push", json=push_body()).status_code == 401
    assert c.post("/pubsub/push", json=push_body(), headers={"Authorization": "Bearer bad"}).status_code == 401
    assert c.post("/tasks/evaluate", content=b"{}").status_code == 401
    assert sched.calls == []


def test_push_schedules_debounced_task(rubric_json):
    c, sched, provider, _ = client(rubric_json)
    r = c.post("/pubsub/push", json=push_body(), headers=AUTH)
    assert r.status_code == 204 and sched.calls[0][1] == 120 and provider.calls == 0


def test_push_rejects_malformed_and_unknown_tenant_non_2xx(rubric_json):
    c, sched, *_ = client(rubric_json)
    assert c.post("/pubsub/push", json=push_body(raw=b"not json"), headers=AUTH).status_code == 400
    assert c.post("/pubsub/push", json={"nope": 1}, headers=AUTH).status_code == 400
    assert c.post("/pubsub/push", json=push_body(event(organization_id="intruder")), headers=AUTH).status_code == 403
    assert sched.calls == []


def test_push_returns_503_when_ai_disabled_so_backlog_is_retained(rubric_json):
    c, sched, *_ = client(rubric_json, ai=False)
    assert c.post("/pubsub/push", json=push_body(), headers=AUTH).status_code == 503
    assert sched.calls == []


def test_task_endpoint_evaluates_and_maps_errors(rubric_json):
    c, _, provider, writer = client(rubric_json)
    r = c.post("/tasks/evaluate", content=event().model_dump_json(), headers=AUTH)
    assert r.status_code == 200 and r.json() == {"outcome": "EVALUATED"} and len(writer.analyses) == 1
    c2, *_ = client(rubric_json, source=Source(None))
    assert c2.post("/tasks/evaluate", content=event().model_dump_json(), headers=AUTH).status_code == 503
    assert c2.post("/tasks/evaluate", content=b"{}", headers=AUTH).status_code == 400
