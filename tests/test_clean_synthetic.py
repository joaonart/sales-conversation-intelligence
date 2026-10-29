"""The cleaning script must be incapable of touching anything but synthetic tenants, or the console's access and audit tables."""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import clean_synthetic as cs  # noqa: E402

P = "proj-1"


def test_every_delete_is_limited_to_synthetic_tenants():
    stmts = cs.delete_statements(P)
    assert stmts
    for label, sql in stmts:
        assert re.fullmatch(r"DELETE FROM `proj-1\.[a-z_]+\.[a-z_]+` WHERE STARTS_WITH\(organization_id, 'synthetic-'\)", sql), label


def test_the_console_access_and_audit_tables_are_never_touched():
    names = {t for _, t in cs.TABLES}
    assert not names & cs.PROTECTED
    assert cs.PROTECTED == {"app_users", "audit_log"}
    for _, sql in cs.delete_statements(P) + [(a, b) for a, b, _ in cs.count_statements(P)]:
        assert "app_users" not in sql and "audit_log" not in sql


def test_it_covers_the_source_data_the_results_and_the_rubrics():
    labels = {label for label, _ in cs.delete_statements(P)}
    assert labels == {
        "conversation_config.review_decisions", "conversation_analytics.session_criterion_results", "conversation_analytics.session_analyses",
        "conversation_analytics.analysis_runs", "conversation_config.evaluation_criteria", "conversation_config.evaluation_policies",
        "conversation_config.evaluation_rubrics", "commerce.messages", "commerce.sessions",
    }


def test_derived_tables_are_deleted_before_their_sources():
    order = [label for label, _ in cs.delete_statements(P)]
    assert order.index("conversation_analytics.session_criterion_results") < order.index("commerce.sessions")
    assert order.index("conversation_config.review_decisions") < order.index("conversation_analytics.session_analyses")


def test_the_dry_run_counts_the_other_tenants_too_so_nothing_is_a_surprise():
    for _, syn, other in cs.count_statements(P):
        assert "STARTS_WITH(organization_id, 'synthetic-')" in syn and "NOT STARTS_WITH" not in syn
        assert "NOT STARTS_WITH(organization_id, 'synthetic-')" in other
