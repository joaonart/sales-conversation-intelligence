"""Backward-compatible re-export; the implementation lives in packages/evaluation-core (sci_core)."""
from sci_core.scoring import (  # noqa: F401
    Applicability,
    CriterionResult,
    MissingEvidencePolicy,
    ScoreResult,
    calculate_score,
)
