"""Why runs fail: a closed set of safe codes, recorded by every job, never the message or the provider body."""
from datetime import UTC, date, datetime

import pytest

from sci_bq.runner import QueryTooExpensive
from sci_bq.source import Tenant
from sci_bq.tables import Tables
from sci_bq.writer import BigQueryResultWriter
from sci_core.budget import PriceBook
from sci_core.engine import EvaluationEngine
from sci_core.loader import RubricLoader
from sci_core.provider import AnalysisIdentity, ProviderAnswer, ProviderResponse, ProviderUsage
from sci_core.routing import RoutingConfig, SessionRouter
from sci_core.rubric import Rubric, RubricError
from sci_openai.errors import (
    CircuitOpen,
    InvalidProviderResponse,
    ProviderError,
    ProviderRequestError,
    QuotaExceeded,
    TransientProviderError,
)
from sci_workers.failures import CODES, classify_failure, failure_row
from sci_workers.historical import HistoricalJob, JobConfig
from sci_workers.routing import RoutingJob, RoutingJobConfig
from tests.test_historical_job import FakeSource, MemStore, MemWriter, Repo
from tests.test_routing_job import FakeSource as RouteSource
from tests.test_routing_job import MemRoutes

NOW = datetime(2026, 3, 1, tzinfo=UTC)
T = Tenant("demo", "default")
SECRET = "CPF 123.456.789-09 said: my card is 4111 1111 1111 1111"


@pytest.mark.parametrize(
    "exc,code,status,provider",
    [
        (ProviderRequestError(401, "invalid_api_key"), "PROVIDER_AUTH", 401, "invalid_api_key"),
        (ProviderRequestError(403, None), "PROVIDER_AUTH", 403, None),
        (ProviderRequestError(400, "bad request!"), "PROVIDER_REJECTED", 400, None),  # a code with odd characters is dropped, not stored
        (ProviderRequestError(404, "model_not_found"), "PROVIDER_REJECTED", 404, "model_not_found"),
        (QuotaExceeded("quota"), "PROVIDER_QUOTA", None, None),
        (TransientProviderError("x"), "PROVIDER_UNAVAILABLE", None, None),
        (CircuitOpen("x"), "PROVIDER_CIRCUIT_OPEN", None, None),
        (InvalidProviderResponse("x"), "INVALID_PROVIDER_RESPONSE", None, None),
        (ProviderError("conversation exceeds adapter max_input_tokens; refusing to send"), "INPUT_TOO_LARGE", None, None),
        (ProviderError("something else"), "PROVIDER_ERROR", None, None),
        (RubricError("rubric x not found"), "RUBRIC_UNAVAILABLE", None, None),
        (QueryTooExpensive("dry-run"), "QUERY_TOO_EXPENSIVE", None, None),
        (TimeoutError(), "TIMEOUT", None, None),
        (TimeoutError(), "TIMEOUT", None, None),
        (RuntimeError("boom"), "UNEXPECTED", None, None),
        (KeyError("k"), "UNEXPECTED", None, None),
    ],
)
def test_classification(exc, code, status, provider):
    info = classify_failure(exc)
    assert (info.code, info.http_status, info.provider_code) == (code, status, provider)
    assert info.code in CODES and info.error_type == type(exc).__name__


def test_google_errors_are_bigquery_errors():
    from google.api_core.exceptions import BadRequest

    assert classify_failure(BadRequest("bad")).code == "BIGQUERY_ERROR"


def test_a_failure_row_never_carries_the_message_or_any_content():
    row = failure_row(T, "run1", "s1", "EVALUATION", RuntimeError(SECRET), NOW)
    assert "123.456" not in str(row) and "4111" not in str(row) and "said" not in str(row)
    assert set(row) == {"failure_id", "run_id", "organization_id", "workspace_id", "session_id", "stage", "error_code", "error_type",
                        "http_status", "provider_code", "occurred_at"}
    assert row["failure_id"] == failure_row(T, "run1", "s1", "EVALUATION", RuntimeError("other"), NOW)["failure_id"]  # same failure -> same id


async def test_writer_appends_failures_with_a_deterministic_job_id():
    from tests.test_bq_writer import Client

    client = Client()
    w = BigQueryResultWriter(Tables(project="my-proj-123"), "US", client=client)
    rows = [failure_row(T, "run1", "s1", "EVALUATION", RuntimeError("x"), NOW)]
    await w.write_failures(rows)
    await w.write_failures(rows)
    await w.write_failures([])
    assert [ld[1] for ld in client.loads] == ["my-proj-123.conversation_analytics.run_failures"] * 2
    assert client.loads[0][3] == client.loads[1][3] and client.loads[0][3].startswith("sci-failures-")


class MemFailures:
    def __init__(self, boom=False):
        self.rows, self.boom = [], boom

    async def write_failures(self, rows):
        if self.boom:
            raise RuntimeError("bigquery down")
        self.rows += rows


class Failing:
    model, prompt_version = "fake", "p1"

    def __init__(self, exc_by_text):
        self.exc_by_text = exc_by_text

    async def evaluate(self, text, criteria):
        for needle, exc in self.exc_by_text.items():
            if needle in text:
                raise exc
        return ProviderResponse(answers=[ProviderAnswer(criterion_id="greeting", answer=True), ProviderAnswer(criterion_id="needs", answer="complete")],
                                usage=ProviderUsage(input_tokens=100, output_tokens=20, estimated_cost_usd=0.01))


def build(rubric_json, provider, failures):
    source, store = FakeSource(4), MemStore()
    cfg = JobConfig(tenant=T, rubric_id="sales_quality", rubric_version=1, start_date=date(2026, 1, 1), end_date=date(2026, 1, 31),
                    prices=PriceBook(1.0, 4.0), max_cost_usd=10.0, max_sessions=100, page_size=10, max_output_tokens_per_session=100,
                    identity=AnalysisIdentity(model=provider.model, prompt_version=provider.prompt_version))
    return HistoricalJob(source=source, store=store, writer=MemWriter(store), loader=RubricLoader(Repo(Rubric.model_validate(rubric_json))),
                         engine=EvaluationEngine(provider, mode="historical", clock=lambda: NOW), config=cfg, clock=lambda: NOW, failures=failures), cfg


async def test_historical_job_records_why_each_session_failed(rubric_json):
    import tests.test_historical_job as th

    sink = MemFailures()
    # FakeSource messages are "Olá " * 50 for every session, so tell sessions apart by monkeypatching the text per call order
    calls = {"n": 0}
    excs = [ProviderRequestError(401, "invalid_api_key"), TransientProviderError("429"), None, InvalidProviderResponse("shape")]

    class Seq(Failing):
        async def evaluate(self, text, criteria):
            e = excs[calls["n"]]
            calls["n"] += 1
            if e:
                raise e
            return await Failing({}).evaluate(text, criteria)

    job, cfg = build(rubric_json, Seq({}), sink)
    job._cfg = JobConfig(**{**cfg.__dict__, "concurrency": 1})
    stats = await job.run(approved=True)
    assert stats.failed == 3 and th  # imported to keep the shared fakes in one place
    codes = sorted(r["error_code"] for r in sink.rows)
    assert codes == ["INVALID_PROVIDER_RESPONSE", "PROVIDER_AUTH", "PROVIDER_UNAVAILABLE"]
    assert {r["run_id"] for r in sink.rows} == {cfg.run_id} and {r["stage"] for r in sink.rows} == {"EVALUATION"}
    assert all(r["organization_id"] == "demo" and r["session_id"].startswith("s") for r in sink.rows)
    assert next(r for r in sink.rows if r["error_code"] == "PROVIDER_AUTH")["http_status"] == 401


async def test_losing_the_explanation_never_stops_or_fails_the_run(rubric_json):
    job, _ = build(rubric_json, Failing({"Olá": TransientProviderError("x")}), MemFailures(boom=True))
    stats = await job.run(approved=True)
    assert stats.failed == 4 and stats.status == "COMPLETED_WITH_FAILURES"  # counters intact


async def test_a_run_that_stops_with_an_error_records_a_job_level_failure(rubric_json):
    sink = MemFailures()
    job, cfg = build(rubric_json, Failing({}), sink)

    async def boom(*a, **k):
        raise RubricError("rubric sales_quality not found")

    job._loader.load = boom  # the run cannot start
    with pytest.raises(RubricError):
        await job.run(approved=True)
    assert sink.rows == []  # nothing ran yet: failing before the first page is raised, not recorded as a session failure

    job2, cfg2 = build(rubric_json, Failing({}), sink)

    async def broken_writer(*a, **k):
        raise RuntimeError("bigquery write failed")

    job2._writer.write = broken_writer
    with pytest.raises(RuntimeError):
        await job2.run(approved=True)
    assert [(r["stage"], r["error_code"], r["session_id"]) for r in sink.rows] == [("JOB", "UNEXPECTED", None)]
    assert sink.rows[0]["run_id"] == cfg2.run_id


async def test_routing_job_records_failures_and_summarises_codes():
    sink = MemFailures()
    cfg = RoutingConfig.parse({"routes": [{"key": "a", "description": "x", "rubric_id": "r"}, {"key": "b", "description": "y"}], "fallback": "b"})

    class Boom:
        model, prompt_version = "fake", "p1"

        async def evaluate(self, text, criteria):
            raise QuotaExceeded("insufficient_quota")

    job = RoutingJob(source=RouteSource(3), store=MemRoutes(), router=SessionRouter(Boom(), cfg), clock=lambda: NOW, failures=sink,
                     config=RoutingJobConfig(tenant=T, start_date=date(2026, 1, 1), end_date=date(2026, 1, 31), prices=PriceBook(1.0, 4.0),
                                             max_cost_usd=1.0, max_sessions=10))
    stats = await job.run(approved=True)
    assert stats.failed == 3 and stats.failure_codes == {"PROVIDER_QUOTA": 3}
    assert {(r["stage"], r["error_code"], r["run_id"]) for r in sink.rows} == {("ROUTING", "PROVIDER_QUOTA", job.run_id)}
    assert job.run_id.startswith("route-")


async def test_live_records_the_reason_and_still_raises_but_not_for_control_flow(rubric_json):
    from tests.test_live import Source, event
    from tests.test_live import make as make_live

    sink = MemFailures()
    proc, provider, *_ = make_live(rubric_json)
    proc._failures = sink

    async def boom(text, criteria):
        raise ProviderRequestError(429, "rate_limit_exceeded")

    provider.evaluate = boom
    with pytest.raises(ProviderRequestError):
        await proc.process(event())
    assert [(r["stage"], r["error_code"], r["run_id"], r["session_id"]) for r in sink.rows] == [("LIVE", "PROVIDER_REJECTED", "live-e1", "s1")]

    behind = make_live(rubric_json, source=Source(session={**Source().session, "updated_at": datetime(2020, 1, 1, tzinfo=UTC)}))[0]
    behind._failures = sink
    with pytest.raises(Exception, match="behind"):  # NotReady: retry later, not a failure
        await behind.process(event())
    assert len(sink.rows) == 1


def test_every_code_has_an_explanation_in_the_console_and_nothing_else():
    """The console explains each cause. A code the jobs can record without a text there would show as a bare identifier."""
    import re
    from pathlib import Path

    js = (Path(__file__).parent.parent / "apps" / "admin-console" / "src" / "client" / "app.js").read_text()
    block = js[js.index("var FAILURE_CODES = {"): js.index("var FAILURE_STAGE")]
    assert set(re.findall(r"^\s{4}([A-Z_]+): \[", block, re.M)) == set(CODES)
