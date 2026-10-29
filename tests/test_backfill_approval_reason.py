import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from backfill_approval_reason import recompute  # noqa: E402

POLICY = {"minimum_approval_score": 70, "missing_evidence_policy": "NEEDS_REVIEW"}
RESULTS = [
    {"criterion_id": "needs", "criterion_weight": 25, "normalized_score": 50.0, "applicability_status": "APPLICABLE"},
    {"criterion_id": "greeting", "criterion_weight": 75, "normalized_score": 100.0, "applicability_status": "APPLICABLE"},
]
STORED = {"overall_score": 87.5, "approval_status": "REJECTED", "analysis_status": "COMPLETED"}


def test_reproduces_the_reason_from_what_was_stored():
    reason, why = recompute(STORED, RESULTS, {"needs": True}, POLICY)
    assert why == "" and reason["reasons"] == [{"code": "REQUIRED_CRITERION_BELOW_MINIMUM", "criterion_id": "needs", "score": 50.0}]


def test_refuses_to_write_when_the_recomputation_disagrees_with_the_stored_result():
    for bad in (
        {**STORED, "overall_score": 80.0},
        {**STORED, "approval_status": "APPROVED"},
        {**STORED, "analysis_status": "NEEDS_REVIEW"},
    ):
        reason, why = recompute(bad, RESULTS, {"needs": True}, POLICY)
        assert reason is None and "differs" in why
    reason, _ = recompute(STORED, RESULTS, {}, POLICY)  # without the required flag the status would be APPROVED: not reproducible
    assert reason is None


def test_no_results_or_bad_data_is_skipped_not_guessed():
    assert recompute(STORED, [], {}, POLICY)[0] is None
    assert recompute(STORED, [{**RESULTS[0], "applicability_status": "???"}], {}, POLICY)[0] is None
