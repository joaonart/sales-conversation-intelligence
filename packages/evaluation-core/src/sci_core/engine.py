"""Shared evaluation engine used identically by API, historical job and live worker."""
from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel

from sci_core.context import build_conversation
from sci_core.hashing import analysis_id, session_content_hash
from sci_core.obs import Stopwatch
from sci_core.provider import AIProvider, AnswerState, ProviderAnswer, ProviderResponse
from sci_core.rubric import Criterion, Policy, Rubric, RubricError
from sci_core.scoring import Applicability, CriterionResult, ScoreResult, calculate_score
from sci_core.tracing import span

log = logging.getLogger("sci.engine")  # metadata only


class EvaluationBudgetExceeded(RuntimeError):
    pass


class CriterionOutcome(BaseModel):
    criterion_id: str
    weight: float
    required: bool
    applicability: Applicability
    normalized_score: float | None
    weighted_score: float | None
    answer: str | bool | None
    confidence: float | None
    evidence_message_ids: list[str]
    warnings: list[str] = []


class Evaluation(BaseModel):
    analysis_id: str
    organization_id: str
    workspace_id: str
    session_id: str
    rubric_id: str
    rubric_version: int
    rubric_snapshot_hash: str
    session_content_hash: str
    analysis_mode: str
    model: str
    prompt_version: str
    score: ScoreResult
    criteria: list[CriterionOutcome]
    input_tokens: int
    output_tokens: int
    estimated_cost_usd: float
    started_at: datetime
    completed_at: datetime

    def to_rows(self) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """Rows matching conversation_analytics.session_analyses / session_criterion_results."""
        analysis = {
            "analysis_id": self.analysis_id, "organization_id": self.organization_id,
            "workspace_id": self.workspace_id, "session_id": self.session_id,
            "rubric_id": self.rubric_id, "rubric_version": self.rubric_version,
            "analysis_mode": self.analysis_mode, "session_content_hash": self.session_content_hash,
            "analysis_status": self.score.status, "overall_score": self.score.overall_score,
            "approval_status": self.score.approval_status, "model": self.model,
            "prompt_version": self.prompt_version, "estimated_cost_usd": self.estimated_cost_usd,
            "processing_duration_ms": int((self.completed_at - self.started_at).total_seconds() * 1000),
            "started_at": self.started_at.isoformat(), "completed_at": self.completed_at.isoformat(),
        }
        criteria = [{
            "analysis_id": self.analysis_id, "organization_id": self.organization_id,
            "workspace_id": self.workspace_id, "session_id": self.session_id,
            "criterion_id": c.criterion_id, "criterion_weight": c.weight,
            "evaluation_result": {"answer": c.answer, "warnings": c.warnings},
            "normalized_score": c.normalized_score, "weighted_score": c.weighted_score,
            "applicability_status": c.applicability.value, "confidence": c.confidence,
            "evidence_message_ids": c.evidence_message_ids,
            "evaluated_at": self.completed_at.isoformat(),
        } for c in self.criteria]
        return analysis, criteria


def evidence_gap(messages: list[dict[str, Any]], policy: Policy) -> str | None:
    """Name of the first unmet minimum-evidence rule (a fixed code, never conversation text), or None."""
    usable = [m for m in messages if (m.get("content") or "").strip()]
    if len(usable) < policy.min_messages:
        return "min_messages"
    if sum(1 for m in usable if m.get("sender_type") == "customer") < policy.min_customer_messages:
        return "min_customer_messages"
    if sum(1 for m in usable if m.get("sender_type") == "seller") < policy.min_seller_messages:
        return "min_seller_messages"
    return None


class EvaluationEngine:
    def __init__(self, provider: AIProvider, *, mode: str,
                 clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self._provider = provider
        self._mode = mode
        self._clock = clock

    async def evaluate(self, *, organization_id: str, workspace_id: str, session_id: str,
                       messages: list[dict[str, Any]], rubric: Rubric) -> Evaluation:
        watch = Stopwatch()
        with span("sci.evaluate", mode=self._mode, rubric_id=rubric.rubric_id, rubric_version=rubric.version):
            ev = await self._evaluate(organization_id=organization_id, workspace_id=workspace_id, session_id=session_id,
                                      messages=messages, rubric=rubric)
        # One metadata-only line per evaluation feeds the log-based metrics (outcome counts, latency).
        log.info("evaluation", extra={
            "event": "evaluation", "outcome": ev.score.status, "mode": self._mode, "latency_ms": watch.ms,
            "cost_usd": ev.estimated_cost_usd, "input_tokens": ev.input_tokens, "output_tokens": ev.output_tokens,
            "organization_id": organization_id, "workspace_id": workspace_id, "session_id": session_id,
            "rubric_id": rubric.rubric_id, "rubric_version": rubric.version, "model": ev.model})
        return ev

    async def _evaluate(self, *, organization_id: str, workspace_id: str, session_id: str,
                        messages: list[dict[str, Any]], rubric: Rubric) -> Evaluation:
        if (rubric.organization_id, rubric.workspace_id) != (organization_id, workspace_id):
            raise RubricError("rubric does not belong to the session's tenant")
        started = self._clock()
        conversation = build_conversation(messages)
        limit = rubric.policy.max_input_tokens
        if limit is not None and conversation.approx_tokens > limit:
            # Fail closed before any external call.
            raise EvaluationBudgetExceeded(f"approx {conversation.approx_tokens} tokens > policy max {limit}")
        active = list(rubric.active_criteria)
        gap = evidence_gap(messages, rubric.policy)
        if gap:
            # Not enough conversation to judge: abstain deterministically, no provider call, no cost.
            response = ProviderResponse(answers=[ProviderAnswer(criterion_id=c.criterion_id, state=AnswerState.INSUFFICIENT_EVIDENCE)
                                                 for c in active])
        else:
            response = await self._provider.evaluate(conversation.text, active)
        by_id = self._index_answers(response.answers, active)
        outcomes = [self._outcome(c, by_id.get(c.criterion_id), set(conversation.message_ids)) for c in active]
        if gap:
            for o in outcomes:
                o.warnings.append(f"below minimum evidence: {gap}")
        score = calculate_score(
            [CriterionResult(criterion_id=o.criterion_id, weight=o.weight, required=o.required,
                             score=o.normalized_score, applicability=o.applicability) for o in outcomes],
            rubric.policy.minimum_approval_score, rubric.policy.missing_evidence_policy,
        )
        total = score.applicable_weight
        for o in outcomes:
            if o.normalized_score is not None and total > 0 and score.status == "COMPLETED":
                o.weighted_score = round(o.weight * o.normalized_score / total, 4)
        content_hash = session_content_hash(messages)
        return Evaluation(
            analysis_id=analysis_id(
                organization_id=organization_id, workspace_id=workspace_id, session_id=session_id,
                rubric_id=rubric.rubric_id, rubric_version=rubric.version, content_hash=content_hash,
                model=self._provider.model, prompt_version=self._provider.prompt_version),
            organization_id=organization_id, workspace_id=workspace_id, session_id=session_id,
            rubric_id=rubric.rubric_id, rubric_version=rubric.version,
            rubric_snapshot_hash=rubric.snapshot_hash, session_content_hash=content_hash,
            analysis_mode=self._mode, model=self._provider.model,
            prompt_version=self._provider.prompt_version, score=score, criteria=outcomes,
            input_tokens=response.usage.input_tokens, output_tokens=response.usage.output_tokens,
            estimated_cost_usd=response.usage.estimated_cost_usd,
            started_at=started, completed_at=self._clock(),
        )

    @staticmethod
    def _index_answers(answers: list[ProviderAnswer], active: list[Criterion]) -> dict[str, ProviderAnswer]:
        known = {c.criterion_id for c in active}
        indexed: dict[str, ProviderAnswer] = {}
        for a in answers:
            if a.criterion_id not in known:
                raise RubricError(f"provider returned unknown criterion {a.criterion_id!r}")
            if a.criterion_id in indexed:
                raise RubricError(f"provider returned duplicate criterion {a.criterion_id!r}")
            indexed[a.criterion_id] = a
        return indexed

    @staticmethod
    def _outcome(c: Criterion, a: ProviderAnswer | None, valid_ids: set[str]) -> CriterionOutcome:
        base = dict(criterion_id=c.criterion_id, weight=c.weight, required=c.required,
                    normalized_score=None, weighted_score=None, answer=None, confidence=None,
                    evidence_message_ids=[])
        # A missing answer is missing evidence, never a zero.
        if a is None:
            return CriterionOutcome(**base, applicability=Applicability.INSUFFICIENT_EVIDENCE,
                                    warnings=["no answer from provider"])
        warnings: list[str] = []
        evidence = [m for m in a.evidence_message_ids if m in valid_ids]
        if len(evidence) != len(a.evidence_message_ids):
            warnings.append("dropped evidence ids not present in session")
        base.update(confidence=a.confidence, evidence_message_ids=evidence)
        if a.state == AnswerState.NOT_APPLICABLE:
            return CriterionOutcome(**base, applicability=Applicability.NOT_APPLICABLE, warnings=warnings)
        if a.state == AnswerState.INSUFFICIENT_EVIDENCE or a.answer is None:
            return CriterionOutcome(**base, applicability=Applicability.INSUFFICIENT_EVIDENCE, warnings=warnings)
        try:
            score = c.map_answer(a.answer)
        except RubricError as exc:
            # Out-of-vocabulary output is not evidence of poor performance.
            return CriterionOutcome(**base, applicability=Applicability.INSUFFICIENT_EVIDENCE,
                                    warnings=[*warnings, str(exc)[:120]])  # provider-controlled text: bounded
        base.update(normalized_score=score, answer=a.answer)
        return CriterionOutcome(**base, applicability=Applicability.APPLICABLE, warnings=warnings)
