"""Versioned, immutable rubrics: parsing from BigQuery rows, validation and answer->score mapping."""
from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from decimal import Decimal
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from sci_core.hashing import canonical_hash
from sci_core.scoring import MissingEvidencePolicy


class RubricError(ValueError):
    """Rubric is malformed or not usable for evaluation."""


class EvaluationType(StrEnum):
    PREDICATE = "PREDICATE"
    CHOICE = "CHOICE"
    SCORE = "SCORE"


class RubricStatus(StrEnum):
    DRAFT = "DRAFT"
    PUBLISHED = "PUBLISHED"
    ARCHIVED = "ARCHIVED"


class Criterion(BaseModel):
    model_config = ConfigDict(frozen=True)

    criterion_id: str = Field(min_length=1)
    name: str | None = None
    instructions: str = Field(min_length=1)
    evaluation_type: EvaluationType
    weight: float = Field(ge=0)
    required: bool = False
    enabled: bool = True
    score_mapping: dict[str, float]
    # Optional text per level/choice key, sent to the provider so "partial" or "fair" has a defined meaning.
    level_descriptions: dict[str, str] = Field(default_factory=dict)
    display_order: int = 0

    @model_validator(mode="after")
    def check_mapping(self) -> Criterion:
        if not self.score_mapping:
            raise ValueError(f"{self.criterion_id}: score_mapping is required")
        if any(not 0 <= v <= 100 for v in self.score_mapping.values()):
            raise ValueError(f"{self.criterion_id}: mapped scores must be within 0..100")
        if self.evaluation_type == EvaluationType.PREDICATE and set(self.score_mapping) != {"true", "false"}:
            raise ValueError(f"{self.criterion_id}: PREDICATE mapping must have exactly 'true' and 'false'")
        if self.enabled and self.required and self.weight == 0:
            raise ValueError(f"{self.criterion_id}: required criterion cannot have zero weight")
        return self

    @property
    def options(self) -> list[str]:
        return list(self.score_mapping)

    def map_answer(self, answer: str | bool) -> float:
        """Deterministic answer -> 0..100. Unknown answers are errors, never silently zero."""
        key = str(answer).lower() if isinstance(answer, bool) else str(answer)
        if key not in self.score_mapping:
            raise RubricError(f"{self.criterion_id}: answer {key!r} not in mapping {self.options}")
        return self.score_mapping[key]


class Policy(BaseModel):
    model_config = ConfigDict(frozen=True)

    minimum_approval_score: float = Field(default=80, ge=0, le=100)
    missing_evidence_policy: MissingEvidencePolicy = MissingEvidencePolicy.NEEDS_REVIEW
    max_analyses_per_session: int | None = Field(default=None, gt=0)
    max_input_tokens: int | None = Field(default=None, gt=0)
    monthly_budget_usd: float | None = Field(default=None, ge=0)
    # Minimum evidence gate, checked before any provider call. Messages with blank content do not count.
    # Per-party minima are opt-in (0 = off) because source systems label parties differently.
    min_messages: int = Field(default=3, ge=0)
    min_customer_messages: int = Field(default=0, ge=0)
    min_seller_messages: int = Field(default=0, ge=0)


class Rubric(BaseModel):
    model_config = ConfigDict(frozen=True)

    organization_id: str = Field(min_length=1)
    workspace_id: str = Field(min_length=1)
    rubric_id: str = Field(min_length=1)
    version: int = Field(ge=1)
    status: RubricStatus
    name: str | None = None
    criteria: tuple[Criterion, ...]
    policy: Policy = Policy()

    @model_validator(mode="after")
    def check(self) -> Rubric:
        ids = [c.criterion_id for c in self.criteria]
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate criterion_id in rubric")
        active = [c for c in self.criteria if c.enabled]
        if not active:
            raise ValueError("rubric has no enabled criteria")
        if sum(c.weight for c in active) <= 0:
            raise ValueError("enabled criteria must have a positive total weight")
        return self

    @property
    def active_criteria(self) -> tuple[Criterion, ...]:
        return tuple(sorted((c for c in self.criteria if c.enabled), key=lambda c: (c.display_order, c.criterion_id)))

    @property
    def snapshot_hash(self) -> str:
        """Stable identity of the evaluable content (published rubrics are immutable)."""
        return canonical_hash(self.model_dump(mode="json", exclude={"name"}))

    @classmethod
    def from_rows(
        cls,
        rubric_row: Mapping[str, Any],
        criteria_rows: Sequence[Mapping[str, Any]],
        policy_row: Mapping[str, Any] | None = None,
    ) -> Rubric:
        """Build from BigQuery rows (JSON columns may be str or dict; NUMERIC arrives as Decimal)."""
        criteria = tuple(_criterion_from_row(r) for r in criteria_rows)
        return cls(
            organization_id=rubric_row["organization_id"],
            workspace_id=rubric_row["workspace_id"],
            rubric_id=rubric_row["rubric_id"],
            version=rubric_row["version"],
            status=rubric_row["status"],
            name=rubric_row.get("name"),
            criteria=criteria,
            policy=_policy_from_row(policy_row),
        )


def _json(value: Any) -> Any:
    return json.loads(value) if isinstance(value, str) else value


def _num(value: Any) -> float | None:
    return None if value is None else float(value) if isinstance(value, Decimal) else value


def _criterion_from_row(r: Mapping[str, Any]) -> Criterion:
    mapping = _json(r.get("score_mapping")) or {}
    levels = _json(r.get("score_levels"))
    choices = _json(r.get("choices"))
    for declared in (levels, choices):
        if not declared:
            continue
        # A {key: description} object may describe only some options; a plain list must name exactly the mapped options.
        unknown = set(declared) - set(mapping)
        missing = set(mapping) - set(declared)
        if unknown or (missing and not isinstance(declared, dict)):
            raise RubricError(f"{r['criterion_id']}: choices/score_levels do not match score_mapping keys")
    declared = levels if isinstance(levels, dict) else choices if isinstance(choices, dict) else {}
    descriptions = {str(k): v.strip() for k, v in declared.items() if isinstance(v, str) and v.strip()}
    return Criterion(
        criterion_id=r["criterion_id"],
        name=r.get("criterion_name"),
        instructions=r.get("evaluation_instructions") or "",
        evaluation_type=r["evaluation_type"],
        weight=_num(r["weight"]),
        required=bool(r.get("required", False)),
        enabled=bool(r.get("enabled", True)),
        score_mapping={str(k): float(v) for k, v in mapping.items()},
        level_descriptions=descriptions,
        display_order=r.get("display_order") or 0,
    )


def _policy_from_row(r: Mapping[str, Any] | None) -> Policy:
    if not r:
        return Policy()
    fields: dict[str, Any] = {
        "minimum_approval_score": _num(r.get("minimum_approval_score")),
        "missing_evidence_policy": r.get("missing_evidence_policy"),
        "max_analyses_per_session": r.get("max_analyses_per_session"),
        "max_input_tokens": r.get("max_input_tokens"),
        "monthly_budget_usd": _num(r.get("monthly_budget_usd")),
        "min_messages": r.get("min_messages"),
        "min_customer_messages": r.get("min_customer_messages"),
        "min_seller_messages": r.get("min_seller_messages"),
    }
    return Policy(**{k: v for k, v in fields.items() if v is not None})
