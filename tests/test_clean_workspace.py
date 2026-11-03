"""The workspace cleaner: it deletes only the data of ONE test workspace, never the configuration, the access, the audit or the ledger."""
import importlib.util
import sys
from pathlib import Path

import pytest
from google.api_core.exceptions import BadRequest, NotFound

SCRIPT = Path(__file__).parent.parent / "scripts" / "clean_workspace.py"
spec = importlib.util.spec_from_file_location("clean_workspace", SCRIPT)
cw = importlib.util.module_from_spec(spec)
sys.modules["clean_workspace"] = cw
spec.loader.exec_module(cw)


class Job:
    def __init__(self, rows=None, error=None):
        self.rows, self.error = rows, error

    def result(self):
        if self.error:
            raise self.error
        return self.rows or []


class FakeClient:
    """Counts rows per table; records the statements; can fail a DELETE (a streaming buffer) or pretend a table does not exist."""

    def __init__(self, counts, missing=(), fail_delete=None):
        self.counts, self.missing, self.fail_delete, self.statements, self.params = dict(counts), set(missing), fail_delete, [], []

    def query(self, sql, job_config=None):
        self.statements.append(sql)
        self.params.append({p.name: p.value for p in job_config.query_parameters})
        table = sql.split("`")[1].split(".")[-1]
        if table in self.missing:
            return Job(error=NotFound("no such table"))
        if sql.startswith("DELETE"):
            if self.fail_delete and self.fail_delete[0] == table:
                return Job(error=self.fail_delete[1])
            self.counts[table] = 0
            return Job()
        return Job([{"n": self.counts.get(table, 0)}])


COUNTS = {"session_criterion_results": 7, "session_analyses": 1, "analysis_runs": 3, "messages": 6, "sessions": 2, "evaluation_rubrics": 1, "app_users": 1, "audit_log": 6, "ai_spend": 3}


def run(client, apply=False):
    out = []
    code = cw.run(client, "proj-123456", "org-test", "default", apply=apply, out=out.append)
    return code, "\n".join(out)


def test_what_is_never_deleted_is_not_in_the_delete_list_and_the_two_lists_do_not_overlap():
    deleted = {t for _, t in cw.DELETE}
    kept = {t for _, t in cw.KEEP}
    assert not deleted & kept
    assert {"evaluation_rubrics", "evaluation_criteria", "evaluation_policies", "app_users", "audit_log", "ai_spend", "run_requests", "run_schedules"} <= kept
    assert {"sessions", "messages", "session_analyses", "session_criterion_results", "analysis_runs", "session_routes", "run_failures", "review_decisions"} <= deleted


def test_a_dry_run_counts_and_deletes_nothing():
    client = FakeClient(COUNTS)
    code, text = run(client)
    assert code == 0 and "Dry run" in text and "would delete" in text
    assert not any(s.startswith("DELETE") for s in client.statements)
    assert client.counts["sessions"] == 2  # untouched


def test_apply_deletes_the_derived_tables_first_and_the_conversations_last_and_leaves_the_rest():
    client = FakeClient(COUNTS)
    code, text = run(client, apply=True)
    order = [s.split("`")[1].split(".")[-1] for s in client.statements if s.startswith("DELETE")]
    assert code == 0 and "Done. Rows left in the cleaned tables: 0" in text
    assert order == ["session_criterion_results", "session_analyses", "analysis_runs", "messages", "sessions"]  # only tables that had rows; results before sources
    assert client.counts["evaluation_rubrics"] == 1 and client.counts["app_users"] == 1 and client.counts["audit_log"] == 6 and client.counts["ai_spend"] == 3


def test_every_statement_is_scoped_to_the_organization_and_the_workspace_as_parameters():
    client = FakeClient(COUNTS)
    run(client, apply=True)
    for sql, params in zip(client.statements, client.params, strict=True):
        assert "organization_id = @org AND workspace_id = @ws" in sql
        assert params == {"org": "org-test", "ws": "default"}
        assert "org-test" not in sql  # bound, never written into the text


def test_a_table_that_does_not_exist_in_this_environment_is_skipped_not_an_error():
    client = FakeClient(COUNTS, missing={"participants"})
    code, text = run(client, apply=True)
    assert code == 0 and "table does not exist here" in text


def test_a_streaming_buffer_stops_the_run_where_it_happened_and_says_what_to_do():
    err = BadRequest("UPDATE or DELETE statement over table p.commerce.messages would affect rows in the streaming buffer, which is not supported")
    client = FakeClient(COUNTS, fail_delete=("messages", err))
    code, text = run(client, apply=True)
    assert code == 1 and "STOPPED at commerce.messages" in text and "streaming" in text and "run it again later" in text
    assert client.counts["sessions"] == 2  # the conversations after it were not touched: never a half cleaned workspace of sources without messages
    assert not any("`proj-123456.commerce.sessions`" in s for s in client.statements if s.startswith("DELETE"))


@pytest.mark.parametrize("org", ["synthetic-a", "org-test"])
def test_test_workspaces_are_accepted(org):
    cw.check_tenant(org, "default", allow_any=False)


@pytest.mark.parametrize("org", ["acme", "prod-customer", "orgA"])
def test_a_real_organization_is_refused_unless_it_is_asked_for_on_purpose(org):
    with pytest.raises(SystemExit):
        cw.check_tenant(org, "default", allow_any=False)
    cw.check_tenant(org, "default", allow_any=True)


@pytest.mark.parametrize("bad", ["x'; DROP TABLE t; --", "a b", 'q"', "a`b", ""])
def test_a_tenant_name_that_could_carry_sql_is_refused_even_with_allow_any(bad):
    with pytest.raises(SystemExit):
        cw.check_tenant(bad, "default", allow_any=True)
    with pytest.raises(SystemExit):
        cw.check_tenant("org-test", bad, allow_any=True)
