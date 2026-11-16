"""The workspace cleaner: it deletes the data of ONE test workspace and, last, its lines of the spend ledger; never the configuration, the access or the audit."""
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
        if "SUM(cost_usd)" in sql:
            return Job([{"usd": 0.00126 if self.counts.get(table, 0) else 0}])
        return Job([{"n": self.counts.get(table, 0)}])


COUNTS = {"session_criterion_results": 7, "session_analyses": 1, "analysis_runs": 3, "messages": 6, "sessions": 2, "evaluation_rubrics": 1, "app_users": 1, "audit_log": 6, "ai_spend": 3}


def run(client, apply=False, **kw):
    out = []
    code = cw.run(client, "proj-123456", "org-test", "default", apply=apply, out=out.append, **kw)
    return code, "\n".join(out)


def test_what_is_never_deleted_is_not_in_the_delete_list_and_the_two_lists_do_not_overlap():
    deleted = {t for _, t in cw.DELETE}
    kept = {t for _, t in cw.KEEP}
    assert not deleted & kept
    assert {"evaluation_rubrics", "evaluation_criteria", "evaluation_policies", "app_users", "audit_log", "run_requests", "run_schedules"} <= kept
    assert "ai_spend" not in kept and cw.SPEND == ("conversation_analytics", "ai_spend")  # the spend ledger has its own last step
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
    assert order == ["session_criterion_results", "session_analyses", "analysis_runs", "messages", "sessions", "ai_spend"]  # results before sources, the ledger last
    assert client.counts["evaluation_rubrics"] == 1 and client.counts["app_users"] == 1 and client.counts["audit_log"] == 6  # configuration, access and audit stay
    assert client.counts["ai_spend"] == 0


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


def test_the_general_evaluations_of_the_workspace_are_deleted_before_the_analyses_they_belong_to():
    order = [t for _, t in cw.DELETE]
    assert "session_summaries" in order and order.index("session_summaries") < order.index("session_analyses")  # derived rows go first
    assert ("conversation_analytics", "session_summaries") not in cw.KEEP
    client = FakeClient({**COUNTS, "session_summaries": 2})
    cw.run(client, "proj-123456", "org-test", "default", apply=True)
    deletes = [s for s in client.statements if s.startswith("DELETE")]
    assert any("session_summaries" in s and "organization_id = @org AND workspace_id = @ws" in s for s in deletes)


def spend_statements(client):
    return [s for s in client.statements if "ai_spend" in s and s.startswith("DELETE")]


def test_the_dry_run_says_how_much_recorded_spend_the_ledger_holds_and_deletes_nothing():
    client = FakeClient(COUNTS)
    code, text = run(client)
    assert code == 0 and "would delete" in text and "conversation_analytics.ai_spend" in text and "holding US$ 0.001260 of recorded spend" in text
    assert not spend_statements(client) and client.counts["ai_spend"] == 3


def test_apply_clears_the_ledger_last_and_says_how_much_spend_was_forgotten():
    client = FakeClient(COUNTS)
    code, text = run(client, apply=True)
    assert code == 0 and "deleted       conversation_analytics.ai_spend (3 row(s), US$ 0.001260 of recorded spend)" in text
    assert text.splitlines()[-1].endswith("the spend ledger is cleared too.")
    deletes = [s.split("`")[1].split(".")[-1] for s in client.statements if s.startswith("DELETE")]
    assert deletes[-1] == "ai_spend" and deletes.index("sessions") < deletes.index("ai_spend")
    assert "organization_id = @org AND workspace_id = @ws" in spend_statements(client)[0]  # scoped like every other statement


def test_keep_spend_leaves_the_ledger_as_it_is():
    client = FakeClient(COUNTS)
    code, text = run(client, apply=True, spend=False)
    assert code == 0 and not spend_statements(client) and client.counts["ai_spend"] == 3
    assert "keeps         conversation_analytics.ai_spend" in text and text.splitlines()[-1].endswith("the spend ledger was kept.")


def test_a_run_that_stops_before_the_end_never_touches_the_ledger():
    err = BadRequest("would affect rows in the streaming buffer")
    client = FakeClient(COUNTS, fail_delete=("messages", err))
    code, _ = run(client, apply=True)
    assert code == 1 and client.counts["ai_spend"] == 3 and not spend_statements(client)


def test_recent_spend_still_in_the_streaming_buffer_leaves_the_data_cleaned_and_says_to_run_again():
    err = BadRequest("UPDATE or DELETE statement over table p.ai_spend would affect rows in the streaming buffer, which is not supported")
    client = FakeClient(COUNTS, fail_delete=("ai_spend", err))
    code, text = run(client, apply=True)
    assert code == 1 and "STOPPED at conversation_analytics.ai_spend" in text and "streaming" in text and "run it again later" in text
    assert client.counts["sessions"] == 0 and client.counts["ai_spend"] == 3  # the data is clean; only the ledger waits for a second run


def test_an_empty_ledger_has_nothing_to_delete():
    client = FakeClient({**COUNTS, "ai_spend": 0})
    code, text = run(client, apply=True)
    assert code == 0 and not spend_statements(client) and "the spend ledger is cleared too." in text


@pytest.mark.parametrize("org,keep,expected", [("org-test", False, True), ("synthetic-a", False, True), ("org-test", True, False), ("synthetic-b", True, False), ("acme", False, False), ("prod-customer", True, False)])
def test_the_ledger_is_cleared_only_for_a_test_organization_and_never_when_kept(org, keep, expected):
    assert cw.spend_is_cleanable(org, keep_spend=keep) is expected  # a real tenant's spend is a financial record, even with --allow-any-tenant
