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
    """A required criterion is rejected against ITS OWN minimum, even when the weighted average is far above the overall one."""
    r = calculate_score([CriterionResult(criterion_id="required", weight=1, score=70, required=True, minimum=80), CriterionResult(criterion_id="other", weight=9, score=100)])
    assert r.overall_score == 97 and r.approval_status == "REJECTED"


def test_a_required_criterion_without_a_minimum_is_not_judged_by_its_score():
    """No minimum was defined for the criterion: the overall minimum is not borrowed for it. It only has to be evaluated."""
    r = calculate_score([CriterionResult(criterion_id="needs", weight=25, score=0, required=True), CriterionResult(criterion_id="other", weight=75, score=100)], threshold=70)
    assert r.overall_score == 75 and r.approval_status == "APPROVED"
    assert r.approval_reason == {"minimum": 70, "overall": 75, "reasons": [{"code": "MEETS_MINIMUM"}]}
    # the overall minimum still decides on its own
    low = calculate_score([CriterionResult(criterion_id="needs", weight=75, score=0, required=True), CriterionResult(criterion_id="other", weight=25, score=100)], threshold=70)
    assert low.approval_status == "REJECTED" and [x["code"] for x in low.approval_reason["reasons"]] == ["OVERALL_BELOW_MINIMUM"]


def test_a_required_criterion_exactly_at_its_minimum_passes_and_a_minimum_never_applies_to_an_optional_one():
    ok = calculate_score([CriterionResult(criterion_id="a", weight=1, score=60, required=True, minimum=60)], threshold=50)
    assert ok.approval_status == "APPROVED"
    optional = calculate_score([CriterionResult(criterion_id="a", weight=1, score=10, required=False, minimum=60), CriterionResult(criterion_id="b", weight=9, score=100)], threshold=50)
    assert optional.approval_status == "APPROVED"  # (the rubric refuses a minimum on an optional criterion; the scorer ignores it anyway)


def _c(cid, weight, score, required=False, applicability=Applicability.APPLICABLE, minimum=None):
    return CriterionResult(criterion_id=cid, weight=weight, score=score, required=required, minimum=minimum, applicability=applicability)


def test_reason_names_the_required_criterion_that_rejects_a_high_average():
    r = calculate_score([_c("needs", 25, 50, required=True, minimum=60), _c("greeting", 75, 100)], threshold=70)
    assert r.overall_score == 87.5 and r.approval_status == "REJECTED"
    assert r.approval_reason == {
        "minimum": 70, "overall": 87.5,
        "reasons": [{"code": "REQUIRED_CRITERION_BELOW_MINIMUM", "criterion_id": "needs", "score": 50, "minimum": 60}],
    }


def test_reason_for_every_outcome_uses_fixed_codes_and_ids_only():
    low = calculate_score([_c("a", 1, 40)], threshold=70)
    assert [x["code"] for x in low.approval_reason["reasons"]] == ["OVERALL_BELOW_MINIMUM"]
    both = calculate_score([_c("a", 1, 40, required=True, minimum=50)], threshold=70)
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
        r = calculate_score([_c("a", 1, score, required=True, minimum=70)], threshold=70)
        assert r.approval_status == ("APPROVED" if score >= 70 else "REJECTED")
