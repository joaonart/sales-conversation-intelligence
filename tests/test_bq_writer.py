from datetime import UTC, date, datetime

import pytest
from google.api_core.exceptions import Conflict

from sci_bq.source import Tenant
from sci_bq.tables import Tables
from sci_bq.writer import BigQueryResultWriter, BigQueryRunStore
from sci_core.provider import AnalysisIdentity

T = Tables(project="my-proj-123")


class Job:
    def result(self):
        return None


class Client:
    def __init__(self):
        self.loads = []

    def load_table_from_json(self, rows, table, job_config, job_id):
        self.loads.append((rows, table, job_config, job_id))
        return Job()


A = {"analysis_id": "a1", "x": 1}
C = {"analysis_id": "a1", "criterion_id": "c", "evaluation_result": {"answer": "x", "warnings": []}}


async def test_batch_append_with_deterministic_job_ids():
    client = Client()
    w = BigQueryResultWriter(T, "US", client=client)
    await w.write([A], [C])
    await w.write([A], [C])
    assert [ld[1] for ld in client.loads[:2]] == ["my-proj-123.conversation_analytics.session_analyses",
                                                "my-proj-123.conversation_analytics.session_criterion_results"]
    assert client.loads[0][3] == client.loads[2][3]  # retry -> same job id -> BigQuery rejects duplicate job
    assert client.loads[0][2].write_disposition == "WRITE_APPEND"
    assert isinstance(client.loads[1][0][0]["evaluation_result"], dict)  # native JSON, never a JSON-encoded string


async def test_empty_batch_is_noop():
    client = Client()
    await BigQueryResultWriter(T, "US", client=client).write([], [])
    assert client.loads == []


async def test_run_store_queries_are_tenant_scoped():
    calls = []

    class R:
        async def query(self, sql, params, **kw):
            calls.append((sql, params))
            return [{"session_id": "s", "session_content_hash": "h"}]

    client = Client()
    store = BigQueryRunStore(R(), BigQueryResultWriter(T, "US", client=client), T)
    ten = Tenant("o", "w")
    ident = AnalysisIdentity(model="gpt-6-luna", prompt_version="decisions-v1")
    assert await store.existing(ten, "r", 1, ["s"], since=date(2026, 1, 1), identity=ident) == {("s", "h")}
    sql, params = calls[0]
    assert "model = @model AND prompt_version = @prompt_version" in sql
    assert params["model"] == "gpt-6-luna" and params["prompt_version"] == "decisions-v1"
    await store.latest(ten, "run", today=date(2026, 3, 1))
    await store.save({"run_id": "run", "created_at": datetime(2026, 3, 1, tzinfo=UTC).isoformat()})
    assert all(p["organization_id"] == "o" and p["workspace_id"] == "w" for _, p in calls)
    assert "DATE(started_at) >=" in calls[0][0] and "DATE(created_at) >=" in calls[1][0]
    assert client.loads[0][1].endswith("analysis_runs")


class TwinJob:
    """The job that already exists under the same id. `finishes` is how a RUNNING twin ends: "ok", "error" (the job failed) or "raises"."""

    def __init__(self, state, error_result=None, finishes="ok"):
        self.state, self.error_result, self.finishes, self.waited = state, error_result, finishes, False

    def result(self):
        self.waited = True
        if self.finishes == "raises":
            raise RuntimeError("the twin job failed")
        if self.finishes == "error":
            self.error_result = {"reason": "backendError"}
        return []

    def reload(self):
        self.state = "DONE"


class ConflictClient(Client):
    def __init__(self, state, error_result=None, finishes="ok"):
        super().__init__()
        self._existing = TwinJob(state, error_result, finishes)

    def load_table_from_json(self, rows, table, job_config, job_id):
        raise Conflict("Already Exists: Job")

    def get_job(self, job_id):
        return self._existing


async def test_duplicate_job_id_with_finished_job_is_an_idempotent_retry():
    w = BigQueryResultWriter(T, "US", client=ConflictClient("DONE"))
    await w.write([A], [C])  # does not raise


async def test_duplicate_job_id_with_failed_job_is_not_success():
    w = BigQueryResultWriter(T, "US", client=ConflictClient("DONE", {"reason": "invalid"}))
    with pytest.raises(Conflict):
        await w.write([A], [C])


async def test_a_concurrent_twin_that_is_still_loading_is_waited_for_and_accepted_when_it_finishes_clean():
    """Two evaluations of the same content race: the second one's load hits the first one's job id. It must not fail (HTTP 500) and cost a retry."""
    client = ConflictClient("RUNNING", finishes="ok")
    await BigQueryResultWriter(T, "US", client=client).write([A], [C])  # does not raise
    assert client._existing.waited is True


@pytest.mark.parametrize("finishes", ["error", "raises"])
async def test_a_concurrent_twin_that_fails_is_never_mistaken_for_success(finishes):
    with pytest.raises((Conflict, RuntimeError)):
        await BigQueryResultWriter(T, "US", client=ConflictClient("RUNNING", finishes=finishes)).write([A], [C])
