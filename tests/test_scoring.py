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
