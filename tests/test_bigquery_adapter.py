from datetime import UTC, date, datetime

import pytest
import sqlglot

from sci_bq import queries
from sci_bq.rubric_repo import BigQueryRubricRepository
from sci_bq.runner import BigQueryRunner, QueryTooExpensive, to_query_parameter
from sci_bq.source import BigQuerySource, Cursor, Tenant
from sci_bq.tables import Tables
from sci_core.loader import RubricLoader

T = Tables(project="my-proj-123")
TENANT = Tenant("org1", "ws1")
D1, D2 = date(2026, 1, 1), date(2026, 1, 31)


class FakeRunner:
    def __init__(self, *responses):
        self.responses, self.calls = list(responses), []

    async def query(self, sql, params, **kw):
        self.calls.append((sql, dict(params), kw))
        return self.responses.pop(0)

    async def dry_run(self, sql, params):
        return 0


def all_queries():
    return [
        queries.rubric_header(T, pinned=True), queries.rubric_header(T, pinned=False), queries.rubric_criteria(T),
        queries.rubric_policy(T), queries.session_page(T, only_status=True), queries.session_page(T, only_status=False),
        queries.session_by_id(T), queries.messages_for_sessions(T),
    ]


@pytest.mark.parametrize("sql", all_queries())
def test_sql_parses_and_is_safe(sql):
    sqlglot.parse_one(sql, read="bigquery")
    assert "SELECT *" not in sql.upper().replace("  ", " ")
    assert "organization_id = @organization_id" in sql and "workspace_id = @workspace_id" in sql


def test_partitioned_reads_are_bounded():
    assert "DATE(started_at) BETWEEN" in queries.session_page(T, only_status=False)
    assert "DATE(created_at) BETWEEN" in queries.messages_for_sessions(T)
    assert "DATE(started_at) >=" in queries.session_by_id(T)


def test_identifier_validation():
    for bad in [Tables(project="x"), Tables(project="my-proj-123", source_dataset="a`; DROP"),
                Tables(project="my-proj-123", config_dataset="sci-dev_config")]:
        with pytest.raises(ValueError):
            _ = bad.sessions, bad.rubrics


def test_tenant_required():
    with pytest.raises(ValueError):
        Tenant("", "ws")


async def test_rubric_repo_roundtrip_and_loader():
    header = {"organization_id": "org1", "workspace_id": "ws1", "rubric_id": "r", "version": 3, "name": "n", "status": "PUBLISHED"}
    crit = [{"criterion_id": "a", "evaluation_instructions": "q", "evaluation_type": "PREDICATE", "weight": 1,
             "required": False, "enabled": True, "score_mapping": '{"true":100,"false":0}', "display_order": 1}]
    runner = FakeRunner([header], crit, [{"minimum_approval_score": 70}])
    rubric = await RubricLoader(BigQueryRubricRepository(runner, T)).load("org1", "ws1", "r")
    assert rubric.version == 3 and rubric.policy.minimum_approval_score == 70
    assert all(c[1]["organization_id"] == "org1" and c[1]["workspace_id"] == "ws1" for c in runner.calls)
    assert runner.calls[1][1]["version"] == 3  # criteria fetched for the resolved version


async def test_rubric_repo_missing():
    assert await BigQueryRubricRepository(FakeRunner([]), T).fetch("o", "w", "r", 1) is None


async def test_session_paging_cursor():
    rows = [{"session_id": "a", "updated_at": datetime(2026, 1, 1, tzinfo=UTC)},
            {"session_id": "b", "updated_at": datetime(2026, 1, 2, tzinfo=UTC)}]
    src = BigQuerySource(FakeRunner(rows, rows[:1]), T, max_bytes_billed=123)
    zero = Cursor(datetime(1970, 1, 1, tzinfo=UTC))
    page = await src.list_sessions(TENANT, start_date=D1, end_date=D2, cursor=zero, page_size=2)
    assert page.next_cursor == Cursor(rows[1]["updated_at"], "b")
    last = await src.list_sessions(TENANT, start_date=D1, end_date=D2, cursor=page.next_cursor, page_size=2)
    assert last.next_cursor is None
    assert src._runner.calls[0][2] == {"max_bytes_billed": 123}


async def test_bounds_enforced():
    src = BigQuerySource(FakeRunner(), T)
    c = Cursor(datetime(1970, 1, 1, tzinfo=UTC))
    with pytest.raises(ValueError):
        await src.list_sessions(TENANT, start_date=D1, end_date=date(2028, 1, 1), cursor=c)
    with pytest.raises(ValueError):
        await src.list_sessions(TENANT, start_date=D1, end_date=D2, cursor=c, page_size=10**6)


async def test_messages_grouped_single_query():
    rows = [{"session_id": "a", "message_id": "1"}, {"session_id": "a", "message_id": "2"}, {"session_id": "b", "message_id": "3"}]
    runner = FakeRunner(rows)
    out = await BigQuerySource(runner, T).get_messages(TENANT, ["a", "b", "c", "a"], start_date=D1, end_date=D2)
    assert len(runner.calls) == 1 and runner.calls[0][1]["session_ids"] == ["a", "b", "c"]
    assert [len(out[k]) for k in ("a", "b", "c")] == [2, 1, 0]


async def test_get_session_lookback():
    runner = FakeRunner([])
    assert await BigQuerySource(runner, T).get_session(TENANT, "s", lookback_days=10, today=date(2026, 1, 11)) is None
    assert runner.calls[0][1]["since_date"] == date(2026, 1, 1)


def test_parameter_types():
    from google.cloud import bigquery as bq
    assert to_query_parameter("a", True).type_ == "BOOL"
    assert to_query_parameter("a", 3).type_ == "INT64"
    assert to_query_parameter("a", D1).type_ == "DATE"
    assert to_query_parameter("a", datetime(2026, 1, 1, tzinfo=UTC)).type_ == "TIMESTAMP"
    assert isinstance(to_query_parameter("a", ["x"]), bq.ArrayQueryParameter)


async def test_runner_blocks_expensive_query_before_running():
    class Job:
        total_bytes_processed = 10 * 1024**3
    class Client:
        executed = 0
        def query(self, sql, job_config):
            if not job_config.dry_run:
                Client.executed += 1
            return Job()
    runner = BigQueryRunner("my-proj-123", "US", client=Client())
    with pytest.raises(QueryTooExpensive):
        await runner.query("SELECT 1", {}, max_bytes_billed=1024)
    assert Client.executed == 0
