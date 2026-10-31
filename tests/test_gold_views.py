from datetime import UTC, datetime

import pytest

from tests.duck import DuckBQ

D1 = datetime(2026, 3, 1, 10, tzinfo=UTC)
D2 = datetime(2026, 3, 2, 10, tzinfo=UTC)


def analysis(aid, session, *, version=1, status="COMPLETED", score=80.0, approval="APPROVED", cost=0.01,
             when=D1, h="h1", org="o1", ws="w1", rubric="r1", mode="historical", model="m"):
    return dict(analysis_id=aid, organization_id=org, workspace_id=ws, session_id=session, rubric_id=rubric,
                rubric_version=version, analysis_mode=mode, session_content_hash=h, analysis_status=status,
                overall_score=score, approval_status=approval, model=model, prompt_version="p",
                estimated_cost_usd=cost, processing_duration_ms=100, started_at=when, completed_at=when)


def crit(aid, cid, *, status="APPLICABLE", score=100.0, when=D1, org="o1", ws="w1", session="s1"):
    return dict(analysis_id=aid, organization_id=org, workspace_id=ws, session_id=session, criterion_id=cid,
                criterion_weight=10, normalized_score=score, weighted_score=score, applicability_status=status,
                confidence=0.5, evidence_message_ids=["m1"], evaluated_at=when)


@pytest.fixture
def db():
    d = DuckBQ()
    d.create_views()
    return d


def test_all_view_sql_parses_as_bigquery():
    d = DuckBQ()
    d.create_views()  # raises on any untranslatable/invalid SQL
    names = {r[0] for r in d.con.execute("SELECT view_name FROM duckdb_views() WHERE NOT internal").fetchall()}
    assert {"current_session_results", "gold_daily_quality", "gold_criterion_daily", "gold_cost_daily", "review_queue",
            "gold_run_health", "latest_criterion_results", "latest_analysis_runs", "latest_session_analyses",
            "current_session_routes", "gold_routing_daily"} <= names


def test_retried_duplicates_do_not_double_count(db):
    a = analysis("a1", "s1")
    db.insert("session_analyses", [a, {**a, "completed_at": D2}])  # same logical result written twice
    db.insert("session_criterion_results", [crit("a1", "c1"), crit("a1", "c1", when=D2), crit("a1", "c2", score=0.0)])
    assert len(db.rows("SELECT * FROM latest_session_analyses")) == 1
    cr = db.rows("SELECT criterion_id FROM latest_criterion_results ORDER BY criterion_id")
    assert [r["criterion_id"] for r in cr] == ["c1", "c2"]
    q = db.rows("SELECT * FROM gold_daily_quality")
    assert len(q) == 1 and q[0]["sessions"] == 1


def test_needs_review_and_not_evaluable_are_visible_not_scored(db):
    db.insert("session_analyses", [
        analysis("a1", "s1", score=90, approval="APPROVED"),
        analysis("a2", "s2", status="NEEDS_REVIEW", score=None, approval="PENDING", h="h2"),
        analysis("a3", "s3", status="NOT_EVALUABLE", score=None, approval="N_A", h="h3"),
        analysis("a4", "s4", score=50, approval="REJECTED", h="h4"),
    ])
    q = db.rows("SELECT * FROM gold_daily_quality")[0]
    assert (q["sessions"], q["scored_sessions"], q["needs_review"], q["not_evaluable"]) == (4, 2, 1, 1)
    assert q["avg_score"] == 70 and q["approval_rate"] == 0.5  # unscored sessions never count as zero
    assert [r["session_id"] for r in db.rows("SELECT * FROM review_queue")] == ["s2"]


def test_newest_rubric_version_is_the_current_result(db):
    db.insert("session_analyses", [analysis("a1", "s1", version=1, score=40, approval="REJECTED"),
                                   analysis("a2", "s1", version=2, score=95, h="h1", when=D2)])
    cur = db.rows("SELECT rubric_version, overall_score FROM current_session_results")
    assert cur == [{"rubric_version": 2, "overall_score": 95.0}]
    # both analyses stay available (reprocessing never mutates old results)
    assert len(db.rows("SELECT * FROM latest_session_analyses")) == 2


def test_content_change_keeps_history_but_one_current_per_session(db):
    db.insert("session_analyses", [analysis("a1", "s1", h="old", when=D1, score=60, approval="REJECTED"),
                                   analysis("a2", "s1", h="new", when=D2, score=90)])
    cur = db.rows("SELECT overall_score FROM current_session_results")
    assert cur == [{"overall_score": 90.0}]


def test_criterion_gold_excludes_na_and_insufficient_from_average(db):
    db.insert("session_analyses", [analysis("a1", "s1"), analysis("a2", "s2", h="h2"), analysis("a3", "s3", h="h3")])
    db.insert("session_criterion_results", [
        crit("a1", "c1", score=100, session="s1"), crit("a2", "c1", score=50, session="s2"),
        crit("a3", "c1", status="INSUFFICIENT_EVIDENCE", score=None, session="s3")])
    g = db.rows("SELECT * FROM gold_criterion_daily")[0]
    assert (g["evaluations"], g["applicable"], g["insufficient_evidence"]) == (3, 2, 1)
    assert g["avg_normalized_score"] == 75 and g["insufficient_rate"] == pytest.approx(1 / 3)


def test_cost_gold_counts_all_spend_by_mode_and_model(db):
    db.insert("session_analyses", [analysis("a1", "s1", cost=0.02, mode="live"), analysis("a2", "s2", cost=0.03, mode="live", h="h2"),
                                   analysis("a3", "s3", cost=0.10, mode="historical", h="h3", model="other")])
    rows = {(r["analysis_mode"], r["model"]): r for r in db.rows("SELECT * FROM gold_cost_daily")}
    assert float(rows[("live", "m")]["cost_usd"]) == pytest.approx(0.05) and rows[("historical", "other")]["analyses"] == 1


def test_run_health_uses_latest_checkpoint_row_per_run(db):
    def run(rid, status, created, cost, org="o1"):
        return dict(run_id=rid, organization_id=org, workspace_id="w1", processing_mode="historical", run_status=status,
                    sessions_total=10, sessions_processed=10, sessions_failed=0, sessions_skipped=0,
                    estimated_cost_usd=cost, actual_cost_usd=cost, created_at=created)
    db.insert("analysis_runs", [run("r1", "RUNNING", D1, 1.0), run("r1", "COMPLETED", D2, 2.0)])
    rows = db.rows("SELECT * FROM gold_run_health")
    assert len(rows) == 1 and rows[0]["run_status"] == "COMPLETED" and float(rows[0]["actual_cost_usd"]) == 2.0


def test_gold_views_never_mix_tenants(db):
    db.insert("session_analyses", [analysis("a1", "s1", org="o1"), analysis("a2", "s1", org="o2", score=10, approval="REJECTED")])
    rows = db.rows("SELECT organization_id, sessions, avg_score FROM gold_daily_quality ORDER BY organization_id")
    assert rows == [{"organization_id": "o1", "sessions": 1, "avg_score": 80.0}, {"organization_id": "o2", "sessions": 1, "avg_score": 10.0}]


def test_generated_view_sql_is_current():
    import importlib.util
    from pathlib import Path
    path = Path(__file__).parent.parent / "scripts" / "gen_view_sql.py"
    spec = importlib.util.spec_from_file_location("gen", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.OUT.read_text() == mod.render(), "run: python scripts/gen_view_sql.py"


def test_reanalysis_by_another_model_supersedes_in_the_latest_views_but_history_and_cost_stay(db):
    old = analysis("a-old", "s1", model="gpt-6-luna", score=40.0, approval="REJECTED", when=D1)
    new = analysis("a-new", "s1", model="gpt-7", score=90.0, approval="APPROVED", when=D2)  # same content hash, same rubric version
    db.insert("session_analyses", [old, new])
    # the raw table keeps both analyses (audit trail); the "latest" views expose one logical result per session, content and rubric version
    assert {r["analysis_id"] for r in db.rows("SELECT analysis_id FROM session_analyses")} == {"a-old", "a-new"}
    assert [r["analysis_id"] for r in db.rows("SELECT analysis_id FROM latest_session_analyses")] == ["a-new"]
    cur = db.rows("SELECT analysis_id, model FROM current_session_results")
    assert [(r["analysis_id"], r["model"]) for r in cur] == [("a-new", "gpt-7")]  # one current result per session and rubric
    cost = {r["model"]: float(r["cost_usd"]) for r in db.rows("SELECT model, cost_usd FROM gold_cost_daily")}
    assert cost == {"gpt-6-luna": 0.01, "gpt-7": 0.01}  # both runs were paid for and stay visible in the cost view
