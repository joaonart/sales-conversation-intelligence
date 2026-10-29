import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from evaluate_vs_truth import evaluate  # noqa: E402


def row(sid, crit, answer, applicability="APPLICABLE", *, truth=None, status="COMPLETED", score=80.0, skill=0.9, tags=()):
    base = {"scenario": "retail_sale", "sales_conversation": True, "greeting": True, "discovery": "complete", "product_info": "good", "has_objection": True,
            "objection_handling": "good", "closing_attempt": True, "outcome": "won"}
    return {"org": "o", "session_id": sid, "analysis_status": status, "overall_score": score, "truth": {**base, **(truth or {})}, "seller_skill": skill,
            "tags": list(tags), "criterion_id": crit, "answer": answer, "applicability": applicability}


def session(sid, **kw):
    ans = kw.pop("answers", {})
    d = {"greeting": "true", "needs": "complete", "product": "good", "has_objection": "true", "objections": "good", "closing": "true", **ans}
    return [row(sid, c, a, **kw) for c, a in d.items()]


def test_perfect_model_scores_perfectly():
    r = evaluate(session("s1") + session("s2"))
    assert r["needs"]["exact"].startswith("2/2") and r["product"]["mean_abs_error"] == 0.0
    assert r["has_objection_gate"]["accuracy"].startswith("2/2") and r["objections_applicability_follows_truth"].startswith("2/2")


def test_errors_and_confusion_are_reported():
    wrong = session("s2", answers={"needs": "none", "greeting": "false"})
    r = evaluate(session("s1") + wrong)
    assert r["needs"]["exact"].startswith("1/2") and r["needs"]["mean_abs_error"] == 1.0
    assert r["needs"]["truth_pred"] == {"truth=complete pred=complete": 1, "truth=complete pred=none": 1}
    assert r["greeting"]["accuracy"].startswith("1/2")


def test_not_applicable_objections_are_checked_against_the_truth():
    no_obj = session("s1", truth={"has_objection": False, "objection_handling": None}, answers={"has_objection": "false"})
    no_obj = [x for x in no_obj if x["criterion_id"] != "objections"] + [row("s1", "objections", None, "NOT_APPLICABLE", truth={"has_objection": False, "objection_handling": None})]
    assert evaluate(no_obj)["objections_applicability_follows_truth"].startswith("1/1")
    wrong = [x for x in no_obj if x["criterion_id"] != "objections"] + [row("s1", "objections", "poor", "APPLICABLE", truth={"has_objection": False, "objection_handling": None})]
    assert evaluate(wrong)["objections_applicability_follows_truth"].startswith("0/1")


def test_non_sales_injection_and_skill_signals():
    support = session("s9", truth={"scenario": "support", "sales_conversation": False}, score=55.0)
    inj = session("s3", tags=("prompt_injection",), score=95.0)
    r = evaluate(session("s1", score=70.0, skill=0.2) + session("s2", score=90.0, skill=0.9) + support + inj)
    assert r["non_sales"]["sessions"] == 1 and r["non_sales"]["scored"] == 1
    assert r["prompt_injection"]["sessions_scored"] == 1 and r["prompt_injection"]["scored_90_or_more"] == 1
    assert r["corr_seller_skill_vs_score"] > 0.9


def test_is_sales_gate_is_judged_on_every_session_and_reactivation_counts_as_sales():
    sales = session("s1", answers={"is_sales": "true"})
    support = session("s2", truth={"scenario": "support", "sales_conversation": False}, status="NOT_EVALUABLE", score=None, answers={"is_sales": "false"})
    wrong_gate = session("s3", truth={"scenario": "support", "sales_conversation": False}, answers={"is_sales": "true"})
    reactivation = session("s4", truth={"scenario": "reactivation", "sales_conversation": True}, answers={"is_sales": "true"})
    r = evaluate(sales + support + wrong_gate + reactivation)
    assert r["is_sales_gate"]["accuracy"].startswith("3/4")
    assert r["is_sales_gate"]["non_sales_wrongly_scored"] == 1 and r["is_sales_gate"]["sales_wrongly_excluded"] == 0
    assert r["non_sales"]["sessions"] == 2 and r["non_sales"]["by_status"] == {"NOT_EVALUABLE": 1, "COMPLETED": 1}
    assert r["other_sales_by_status"] == {"COMPLETED": 1}  # reactivation is not "non-sales"
