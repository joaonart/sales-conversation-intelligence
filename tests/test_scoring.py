import pytest

from sci_api.scoring import Applicability, CriterionResult, calculate_score


def test_weighted_score():
    r = calculate_score([CriterionResult(criterion_id="a", weight=25, score=100), CriterionResult(criterion_id="b", weight=75, score=60)])
    assert r.overall_score == 70
    assert r.approval_status == "REJECTED"

def test_not_applicable_excluded():
    r = calculate_score([CriterionResult(criterion_id="a", weight=25, score=100), CriterionResult(criterion_id="b", weight=75, applicability=Applicability.NOT_APPLICABLE)])
    assert r.overall_score == 100

def test_insufficient_evidence_not_zero():
    r = calculate_score([CriterionResult(criterion_id="a", weight=1, applicability=Applicability.INSUFFICIENT_EVIDENCE)])
    assert r.overall_score is None and r.status == "NEEDS_REVIEW"

def test_zero_weight():
    r = calculate_score([CriterionResult(criterion_id="a", weight=0, score=100)])
    assert r.status == "NOT_EVALUABLE"

def test_duplicate_rejected():
    with pytest.raises(ValueError):
        calculate_score([CriterionResult(criterion_id="a", weight=1, score=50), CriterionResult(criterion_id="a", weight=1, score=50)])

def test_required_failure():
    r = calculate_score([CriterionResult(criterion_id="required", weight=1, score=70, required=True), CriterionResult(criterion_id="other", weight=9, score=100)])
    assert r.overall_score == 97 and r.approval_status == "REJECTED"


def _c(cid, weight, score, required=False, applicability=Applicability.APPLICABLE):
    return CriterionResult(criterion_id=cid, weight=weight, score=score, required=required, applicability=applicability)


def test_reason_names_the_required_criterion_that_rejects_a_high_average():
    r = calculate_score([_c("needs", 25, 50, required=True), _c("greeting", 75, 100)], threshold=70)
    assert r.overall_score == 87.5 and r.approval_status == "REJECTED"
    assert r.approval_reason == {
        "minimum": 70, "overall": 87.5,
        "reasons": [{"code": "REQUIRED_CRITERION_BELOW_MINIMUM", "criterion_id": "needs", "score": 50}],
    }


def test_reason_for_every_outcome_uses_fixed_codes_and_ids_only():
    low = calculate_score([_c("a", 1, 40)], threshold=70)
    assert [x["code"] for x in low.approval_reason["reasons"]] == ["OVERALL_BELOW_MINIMUM"]
    both = calculate_score([_c("a", 1, 40, required=True)], threshold=70)
    assert [x["code"] for x in both.approval_reason["reasons"]] == ["REQUIRED_CRITERION_BELOW_MINIMUM", "OVERALL_BELOW_MINIMUM"]
    ok = calculate_score([_c("a", 1, 90, required=True)], threshold=70)
    assert ok.approval_status == "APPROVED" and ok.approval_reason["reasons"] == [{"code": "MEETS_MINIMUM"}]
    review = calculate_score([_c("a", 1, None, required=True, applicability=Applicability.INSUFFICIENT_EVIDENCE)], threshold=70)
    assert review.approval_status == "PENDING"
    assert review.approval_reason["reasons"] == [{"code": "INSUFFICIENT_EVIDENCE", "criterion_id": "a", "required": True}]
    na = calculate_score([_c("a", 1, None, applicability=Applicability.NOT_APPLICABLE)], threshold=70)
    assert na.approval_status == "N_A" and na.approval_reason["reasons"] == [{"code": "NO_APPLICABLE_CRITERIA"}]


def test_reason_does_not_change_the_decision():
    """Persisting the reason must not alter score or status."""
    for score in (60, 70, 100):
        r = calculate_score([_c("a", 1, score, required=True)], threshold=70)
        assert r.approval_status == ("APPROVED" if score >= 70 else "REJECTED")
