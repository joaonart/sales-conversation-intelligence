"""Deterministic scoring. LLM confidence must never be used as quality score."""
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field, model_validator


class Applicability(StrEnum):
    APPLICABLE = "APPLICABLE"
    NOT_APPLICABLE = "NOT_APPLICABLE"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


class MissingEvidencePolicy(StrEnum):
    # Any criterion without evidence sends the whole analysis to review (default, safest).
    NEEDS_REVIEW = "NEEDS_REVIEW"
    # Optional criteria without evidence are excluded; required ones still need review.
    EXCLUDE_OPTIONAL = "EXCLUDE_OPTIONAL"


class CriterionResult(BaseModel):
    criterion_id: str
    weight: float = Field(ge=0)
    score: float | None = Field(default=None, ge=0, le=100)
    required: bool = False
    applicability: Applicability = Applicability.APPLICABLE

    @model_validator(mode="after")
    def check(self) -> "CriterionResult":
        if self.applicability == Applicability.APPLICABLE and self.score is None:
            raise ValueError("Applicable criterion requires a score")
        if self.applicability != Applicability.APPLICABLE and self.score is not None:
            raise ValueError("Non-applicable or insufficient evidence must have null score")
        return self


class ScoreResult(BaseModel):
    status: str
    overall_score: float | None
    approval_status: str
    applicable_weight: float
    # Why the approval status is what it is: fixed codes and criterion ids only (never conversation text), so it is PII-free
    # and safe to persist. Shape: {"minimum": 70, "overall": 87.5, "reasons": [{"code": ..., "criterion_id": ..., "score": ...}]}.
    approval_reason: dict[str, Any] | None = None


def calculate_score(
    criteria: list[CriterionResult],
    threshold: float = 80,
    missing_evidence_policy: MissingEvidencePolicy = MissingEvidencePolicy.NEEDS_REVIEW,
) -> ScoreResult:
    if not 0 <= threshold <= 100:
        raise ValueError("threshold out of range")
    if len({c.criterion_id for c in criteria}) != len(criteria):
        raise ValueError("Duplicate criterion IDs")
    missing = [c for c in criteria if c.applicability == Applicability.INSUFFICIENT_EVIDENCE]
    blocking = [
        c for c in missing
        if missing_evidence_policy == MissingEvidencePolicy.NEEDS_REVIEW or c.required
    ]
    if blocking:
        held = [{"code": "INSUFFICIENT_EVIDENCE", "criterion_id": c.criterion_id, "required": c.required} for c in blocking]
        return ScoreResult(status="NEEDS_REVIEW", overall_score=None, approval_status="PENDING", applicable_weight=0,
                           approval_reason={"minimum": threshold, "overall": None, "reasons": held})
    applicable = [c for c in criteria if c.applicability == Applicability.APPLICABLE]
    total = sum(c.weight for c in applicable)
    if total == 0:
        return ScoreResult(status="NOT_EVALUABLE", overall_score=None, approval_status="N_A", applicable_weight=0,
                           approval_reason={"minimum": threshold, "overall": None, "reasons": [{"code": "NO_APPLICABLE_CRITERIA"}]})
    scored = [(c, c.score) for c in applicable if c.score is not None]
    score = sum(c.weight * s for c, s in scored) / total
    failed_required = [(c, sc) for c, sc in scored if c.required and sc < threshold]
    below = score < threshold
    reasons: list[dict[str, Any]] = [
        {"code": "REQUIRED_CRITERION_BELOW_MINIMUM", "criterion_id": c.criterion_id, "score": sc} for c, sc in failed_required
    ]
    if below:
        reasons.append({"code": "OVERALL_BELOW_MINIMUM"})
    rejected = bool(failed_required) or below
    return ScoreResult(
        status="COMPLETED",
        overall_score=round(score, 4),
        approval_status="REJECTED" if rejected else "APPROVED",
        applicable_weight=total,
        approval_reason={"minimum": threshold, "overall": round(score, 4), "reasons": reasons or [{"code": "MEETS_MINIMUM"}]},
    )
