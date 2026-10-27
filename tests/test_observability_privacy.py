"""Privacy and observability guarantees: no chat content in logs/results, PII masked before the provider."""
import base64
import io
import json
import logging
from datetime import UTC, date, datetime

import pytest
from fastapi.testclient import TestClient

from sci_core.budget import PriceBook
from sci_core.engine import EvaluationEngine
from sci_core.loader import RubricLoader
from sci_core.obs import JsonFormatter, configure_logging, parse_trace_header, safe_stack, trace_id
from sci_core.provider import ProviderAnswer, ProviderResponse, ProviderUsage
from sci_core.rubric import Rubric
from sci_workers.historical import HistoricalJob, JobConfig
from sci_workers.live import LiveProcessor, SessionUpdateEvent, TenantLiveConfig
from sci_workers.live_app import create_app
from tests.test_historical_job import FakeSource, MemStore, MemWriter, Repo
from tests.test_live import AUTH, SESSION, UPD, Ledger, Sched, Source, Store, Verifier, Writer

SECRET = "SEGREDO-DO-CLIENTE-9f3a"
PII = "Meu CPF é 123.456.789-09, email maria@example.com e telefone (11) 91234-5678"
NOW = datetime(2026, 3, 10, 12, tzinfo=UTC)


@pytest.fixture
def logs():
    stream = io.StringIO()
    configure_logging(logging.DEBUG, stream)
    yield stream
    root = logging.getLogger()
    root.handlers = [h for h in root.handlers if h.get_name() != "sci-json"]


def lines(stream):
    return [json.loads(x) for x in stream.getvalue().splitlines() if x.strip()]


class LeakyProvider:
    """Fails with an exception whose message echoes the conversation, like a careless SDK might."""
    model, prompt_version = "fake", "p1"

    def __init__(self, fail=False):
        self.fail, self.seen = fail, []

    async def evaluate(self, text, criteria):
        self.seen.append(text)
        if self.fail:
            raise RuntimeError(f"upstream said: {text}")
        return ProviderResponse(answers=[ProviderAnswer(criterion_id="greeting", answer=True),
                                         ProviderAnswer(criterion_id="needs", answer=f"{SECRET} injected answer")],
                                usage=ProviderUsage(estimated_cost_usd=0.001))


# ---------- formatter ----------
def test_formatter_drops_unlisted_fields_and_exception_text(logs):
    log = logging.getLogger("t")
    try:
        raise ValueError(f"contains {SECRET}")
    except ValueError:
        log.error("failed", extra={"content": SECRET, "prompt": SECRET, "outcome": "X", "session_id": "s1"}, exc_info=True)
    rec = lines(logs)[-1]
    assert SECRET not in logs.getvalue()
    assert rec["outcome"] == "X" and rec["session_id"] == "s1" and rec["error_type"] == "ValueError"
    assert "content" not in rec and "prompt" not in rec and rec["severity"] == "ERROR"
    assert all(" " in f or ":" in f for f in rec["stack"])  # frames only


def test_formatter_bounds_values_and_uses_static_message(logs):
    logging.getLogger("t").info("static %s", SECRET, extra={"session_id": "x" * 1000})
    out = lines(logs)[-1]
    assert SECRET not in logs.getvalue() and len(out["session_id"]) <= 200


def test_trace_correlation_header():
    tid = "a" * 32
    assert parse_trace_header(f"{tid}/123;o=1", "proj") == f"projects/proj/traces/{tid}"
    assert parse_trace_header("garbage", "proj") is None and parse_trace_header(None, "proj") is None
    assert parse_trace_header(f"{tid}/1", None) is None


def test_trace_id_is_attached_when_set(logs):
    token = trace_id.set("projects/p/traces/abc")
    try:
        logging.getLogger("t").info("x")
    finally:
        trace_id.reset(token)
    assert lines(logs)[-1]["logging.googleapis.com/trace"] == "projects/p/traces/abc"
    assert JsonFormatter and safe_stack(None) == []


# ---------- end-to-end flows ----------
def messages(text):
    return [{"message_id": "m1", "sequence_number": 1, "sender_type": "customer", "content": text}]


async def run_historical(rubric_json, provider, text):
    class Src(FakeSource):
        async def get_messages(self, tenant, ids, **kw):
            return {i: messages(text) for i in ids}

    store = MemStore()
    writer = MemWriter(store)
    cfg = JobConfig(tenant=__import__("sci_bq.source", fromlist=["Tenant"]).Tenant("demo", "default"), rubric_id="sales_quality",
                    rubric_version=1, start_date=date(2026, 1, 1), end_date=date(2026, 1, 31), prices=PriceBook(1, 4),
                    max_cost_usd=10, max_sessions=10)
    job = HistoricalJob(source=Src(2), store=store, writer=writer, loader=RubricLoader(Repo(Rubric.model_validate(rubric_json))),
                        engine=EvaluationEngine(provider, mode="historical", clock=lambda: NOW), config=cfg, clock=lambda: NOW)
    await job.run(approved=True)
    return writer, store


async def test_pii_is_masked_before_reaching_provider(rubric_json, logs):
    provider = LeakyProvider()
    await run_historical(rubric_json, provider, PII)
    sent = provider.seen[0]
    for raw in ("123.456.789-09", "maria@example.com", "91234-5678"):
        assert raw not in sent
    assert "[CPF]" in sent and "[EMAIL]" in sent and "[PHONE]" in sent


async def test_no_chat_content_in_logs_results_or_run_rows_on_success(rubric_json, logs):
    provider = LeakyProvider()
    writer, store = await run_historical(rubric_json, provider, f"Olá {SECRET}")
    blob = json.dumps([writer.analyses, writer.criteria, store.runs], default=str)
    assert SECRET in provider.seen[0]  # the provider (processor) does see the evidence
    assert SECRET not in logs.getvalue()
    # a model-controlled free-text answer is bounded and stored only as a warning string, never as chat content
    assert "Olá" not in blob
    assert any(r.get("event") == "evaluation" for r in lines(logs))


async def test_provider_error_echoing_content_never_reaches_logs(rubric_json, logs):
    await run_historical(rubric_json, LeakyProvider(fail=True), f"Olá {SECRET}")
    assert SECRET not in logs.getvalue()
    failed = [r for r in lines(logs) if r.get("event") == "session_failed"]
    assert failed and failed[0]["error_type"] == "RuntimeError"


def make_live(rubric_json, provider):
    proc = LiveProcessor(tenants={("demo", "default"): TenantLiveConfig("sales_quality", 1)},
                         source=Source(SESSION, messages(f"Olá {SECRET}")), store=Store(), ledger=Ledger(), writer=Writer(),
                         loader=RubricLoader(Repo(Rubric.model_validate(rubric_json))),
                         engine=EvaluationEngine(provider, mode="live", clock=lambda: NOW), prices=PriceBook(1, 4),
                         default_monthly_budget_usd=5.0, clock=lambda: NOW)
    return TestClient(create_app(processor=proc, scheduler=Sched(), push_verifier=Verifier(), tasks_verifier=Verifier(), project="p"))


def test_live_paths_do_not_log_content_even_on_malformed_input(rubric_json, logs):
    c = make_live(rubric_json, LeakyProvider())
    ev = SessionUpdateEvent(event_id="e1", organization_id="demo", workspace_id="default", session_id="s1", source_updated_at=UPD)
    assert c.post("/tasks/evaluate", content=ev.model_dump_json(), headers=AUTH).status_code == 200
    bad = {"message": {"data": base64.b64encode(f'{{"event_id": "{SECRET}"}}'.encode()).decode()}}
    assert c.post("/pubsub/push", json=bad, headers=AUTH).status_code == 400
    assert c.post("/tasks/evaluate", content=SECRET, headers=AUTH).status_code == 400
    assert SECRET not in logs.getvalue()
    events = {r.get("event") for r in lines(logs)}
    assert {"live_event", "malformed_event", "evaluation"} <= events


def test_unhandled_provider_failure_returns_500_without_leaking(rubric_json, logs):
    c = TestClient(make_live(rubric_json, LeakyProvider(fail=True)).app, raise_server_exceptions=False)
    ev = SessionUpdateEvent(event_id="e2", organization_id="demo", workspace_id="default", session_id="s1", source_updated_at=UPD)
    r = c.post("/tasks/evaluate", content=ev.model_dump_json(), headers=AUTH)
    assert r.status_code == 500 and SECRET not in r.text and SECRET not in logs.getvalue()


def test_trace_header_propagates_to_log_lines(rubric_json, logs):
    c = make_live(rubric_json, LeakyProvider())
    ev = SessionUpdateEvent(event_id="e3", organization_id="demo", workspace_id="default", session_id="s1", source_updated_at=UPD)
    tid = "b" * 32
    c.post("/tasks/evaluate", content=ev.model_dump_json(), headers={**AUTH, "X-Cloud-Trace-Context": f"{tid}/1;o=1"})
    traced = [r for r in lines(logs) if r.get("logging.googleapis.com/trace")]
    assert traced and all(r["logging.googleapis.com/trace"] == f"projects/p/traces/{tid}" for r in traced)
