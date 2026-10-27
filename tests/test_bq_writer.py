import json
from datetime import UTC, date, datetime

from sci_bq.source import Tenant
from sci_bq.tables import Tables
from sci_bq.writer import BigQueryResultWriter, BigQueryRunStore

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
    assert isinstance(json.loads(client.loads[1][0][0]["evaluation_result"]), dict)


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
    assert await store.existing(ten, "r", 1, ["s"], since=date(2026, 1, 1)) == {("s", "h")}
    await store.latest(ten, "run", today=date(2026, 3, 1))
    await store.save({"run_id": "run", "created_at": datetime(2026, 3, 1, tzinfo=UTC).isoformat()})
    assert all(p["organization_id"] == "o" and p["workspace_id"] == "w" for _, p in calls)
    assert "DATE(started_at) >=" in calls[0][0] and "DATE(created_at) >=" in calls[1][0]
    assert client.loads[0][1].endswith("analysis_runs")
