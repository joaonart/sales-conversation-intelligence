"""The audit cleaner: a separate process that clears the audit trail of ONE test workspace and leaves a record that it did."""
import importlib.util
import json
import sys
from pathlib import Path

import pytest
from google.api_core.exceptions import BadRequest

SCRIPT = Path(__file__).parent.parent / "scripts" / "clean_audit.py"
spec = importlib.util.spec_from_file_location("clean_audit", SCRIPT)
ca = importlib.util.module_from_spec(spec)
sys.modules["clean_audit"] = ca
spec.loader.exec_module(ca)


class Job:
    def __init__(self, rows=None, error=None):
        self.rows, self.error = rows, error

    def result(self):
        if self.error:
            raise self.error
        return self.rows or []


class FakeClient:
    """Holds a count of audit events; records the statements and their parameters; a DELETE can fail; an INSERT adds the trace row."""

    def __init__(self, n=6, fail_delete=None, stuck=0):
        self.n, self.fail_delete, self.stuck, self.statements, self.params = n, fail_delete, stuck, [], []

    def query(self, sql, job_config=None):
        self.statements.append(sql)
        self.params.append({p.name: p.value for p in job_config.query_parameters})
        if sql.startswith("DELETE"):
            if self.fail_delete:
                return Job(error=self.fail_delete)
            self.n = self.stuck  # `stuck` rows survive (to test a delete that did not finish the job)
            return Job()
        if sql.startswith("INSERT"):
            self.n += 1
            return Job()
        return Job([{"n": self.n, "oldest": "2026-10-01 10:00:00+00:00", "newest": "2026-11-14 12:00:00+00:00"}])


def run(client, apply=False, **kw):
    out = []
    code = ca.run(client, "proj-123456", "org-test", "default", apply=apply, out=out.append, **kw)
    return code, "\n".join(out)


def kind(sql):
    return sql.split(" ")[0]


def test_a_dry_run_counts_and_changes_nothing():
    client = FakeClient()
    code, text = run(client)
    assert code == 0 and "6 event(s)" in text and "oldest" in text and "Dry run" in text and "would delete" in text
    assert [kind(s) for s in client.statements] == ["SELECT"]
    assert client.n == 6


def test_apply_deletes_the_trail_of_the_workspace_then_records_that_it_did():
    client = FakeClient()
    code, text = run(client, apply=True)
    assert code == 0 and "deleted       conversation_config.audit_log (6 row(s))" in text and "audit.clean" in text
    assert [kind(s) for s in client.statements] == ["SELECT", "DELETE", "SELECT", "INSERT"]  # the trace is written after the check that nothing stayed
    assert client.n == 1  # only the record of the clean is left


def test_every_statement_is_scoped_to_the_organization_and_the_workspace_as_bound_parameters():
    client = FakeClient()
    run(client, apply=True)
    for sql, params in zip(client.statements, client.params, strict=True):
        assert "org-test" not in sql and "default" not in sql
        assert params["org"] == "org-test" and params["ws"] == "default"
        if not sql.startswith("INSERT"):
            assert "organization_id = @org AND workspace_id = @ws" in sql
    assert client.statements[1].startswith("DELETE FROM `proj-123456.conversation_config.audit_log` WHERE")


def test_the_trace_says_who_what_and_how_much_and_binds_its_values():
    client = FakeClient()
    run(client, apply=True)
    insert = next(s for s in client.statements if s.startswith("INSERT"))
    params = next(p for s, p in zip(client.statements, client.params, strict=True) if s.startswith("INSERT"))
    assert "'script:clean_audit'" in insert and "'audit.clean'" in insert and "'SUCCESS'" in insert
    assert json.loads(params["details"]) == {"rows_removed": 6, "before": None}
    assert len(params["event_id"]) == 36
    assert "before" not in params  # no unused parameter (BigQuery rejects it)


def test_before_limits_the_delete_to_older_events_and_is_a_bound_parameter():
    client = FakeClient()
    code, text = run(client, apply=True, before="2026-11-01")
    assert code == 0 and "before 2026-11-01" in text
    delete = next(s for s in client.statements if s.startswith("DELETE"))
    assert delete.endswith("AND occurred_at < TIMESTAMP(@before)")
    assert "2026-11-01" not in delete
    assert next(p for s, p in zip(client.statements, client.params, strict=True) if s.startswith("DELETE"))["before"] == "2026-11-01"
    assert json.loads(next(p for s, p in zip(client.statements, client.params, strict=True) if s.startswith("INSERT"))["details"])["before"] == "2026-11-01"


def test_an_empty_trail_has_nothing_to_delete_but_still_gets_the_record():
    client = FakeClient(n=0)
    code, _ = run(client, apply=True)
    assert code == 0
    assert not any(s.startswith("DELETE") for s in client.statements)
    assert any(s.startswith("INSERT") for s in client.statements)


def test_a_delete_that_fails_stops_without_writing_anything_and_says_what_to_do():
    client = FakeClient(fail_delete=BadRequest("would affect rows in the streaming buffer"))
    code, text = run(client, apply=True)
    assert code == 1 and "STOPPED" in text and "streaming buffer" in text and "run it again later" in text
    assert not any(s.startswith("INSERT") for s in client.statements)
    assert client.n == 6


def test_if_events_stay_after_the_delete_nothing_is_recorded_and_it_fails():
    client = FakeClient(stuck=2)
    code, text = run(client, apply=True)
    assert code == 1 and "Events left" in text and "Nothing was recorded" in text
    assert not any(s.startswith("INSERT") for s in client.statements)


@pytest.mark.parametrize("org", ["synthetic-a", "org-test"])
def test_test_workspaces_are_accepted(org):
    ca.check_args(org, "default", None)


@pytest.mark.parametrize("org", ["acme", "prod-customer", "orgA"])
def test_the_trail_of_any_other_organization_is_never_cleared_and_there_is_no_flag_for_it(org):
    with pytest.raises(SystemExit):
        ca.check_args(org, "default", None)
    assert "allow" not in SCRIPT.read_text().split("def main()")[1].lower()  # no --allow-any-tenant here


@pytest.mark.parametrize("bad", ["x'; DROP TABLE t; --", "a b", 'q"', "a`b", ""])
def test_a_tenant_name_that_could_carry_sql_is_refused(bad):
    with pytest.raises(SystemExit):
        ca.check_args(bad, "default", None)
    with pytest.raises(SystemExit):
        ca.check_args("org-test", bad, None)


@pytest.mark.parametrize("bad", ["2026-11", "11/01/2026", "2026-11-01T00:00:00", "yesterday", "2026-11-01'; --"])
def test_before_must_be_a_day(bad):
    with pytest.raises(SystemExit):
        ca.check_args("org-test", "default", bad)
    ca.check_args("org-test", "default", "2026-11-01")
