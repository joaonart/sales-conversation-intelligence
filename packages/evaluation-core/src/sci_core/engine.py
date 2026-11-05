"""Shared evaluation engine used identically by API, historical job and live worker."""
from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel

from sci_core.context import build_conversation
from sci_core.hashing import analysis_id, canonical_hash, session_content_hash
from sci_core.obs import Stopwatch
from sci_core.provider import AIProvider, AnalysisIdentity, AnswerState, ProviderAnswer, ProviderResponse, ProviderUsage
from sci_core.rubric import Criterion, Policy, Rubric, RubricError, RuleCondition
from sci_core.scoring import Applicability, CriterionResult, ScoreResult, calculate_score
from sci_core.spend import SpendRecorder, record_best_effort, spend_row
from sci_core.summary import Summarizer, Summary, SummaryResult
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
    # The general evaluation, when the rubric asked for one and a summarizer is configured. Its cost is already inside
    # `estimated_cost_usd` and the tokens above (they are the whole analysis), and it never took part in the score.
    summary: Summary | None = None
    summary_model: str | None = None
    summary_version: str | None = None
    summary_prompt_hash: str | None = None
    summary_input_tokens: int = 0
    summary_output_tokens: int = 0
    summary_cost_usd: float = 0.0
    summary_error: str | None = None

    def summary_row(self) -> dict[str, Any] | None:
        """The row of conversation_analytics.session_summaries, or None when there is no summary to store."""
        if self.summary is None:
            return None
        s = self.summary
        return {
            "analysis_id": self.analysis_id, "organization_id": self.organization_id, "workspace_id": self.workspace_id,
            "session_id": self.session_id, "rubric_id": self.rubric_id, "rubric_version": self.rubric_version,
            "summary_prompt_hash": self.summary_prompt_hash, "model": self.summary_model, "summarizer_version": self.summary_version,
            "overall_summary": s.overall,
            "strengths": [i.model_dump() for i in s.strengths], "weaknesses": [i.model_dump() for i in s.weaknesses],
            "opportunities": [i.model_dump() for i in s.opportunities],
            "input_tokens": self.summary_input_tokens, "output_tokens": self.summary_output_tokens,
            "estimated_cost_usd": self.summary_cost_usd, "generated_at": self.completed_at.isoformat(),
        }

    def to_rows(self, run_id: str | None = None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """Rows matching conversation_analytics.session_analyses / session_criterion_results. `run_id` (a historical run) is only a label
        on the analysis: it is not part of `analysis_id`, so a retry of the same run still writes the same logical row."""
        analysis = {
            "analysis_id": self.analysis_id, "organization_id": self.organization_id,
            "workspace_id": self.workspace_id, "session_id": self.session_id,
            "rubric_id": self.rubric_id, "rubric_version": self.rubric_version,
            "analysis_mode": self.analysis_mode, "session_content_hash": self.session_content_hash,
            "analysis_status": self.score.status, "overall_score": self.score.overall_score,
            "approval_status": self.score.approval_status, "approval_reason": self.score.approval_reason, "model": self.model,
            "prompt_version": self.prompt_version, "estimated_cost_usd": self.estimated_cost_usd,
            "processing_duration_ms": int((self.completed_at - self.started_at).total_seconds() * 1000),
            "started_at": self.started_at.isoformat(), "completed_at": self.completed_at.isoformat(),
        }
        if run_id is not None:
            analysis["run_id"] = run_id
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


class _Written(BaseModel):
    """What the summary step left behind: the result, what it cost, and which summarizer and prompt made it."""
    result: SummaryResult
    usage: ProviderUsage
    model: str | None = None
    version: str | None = None
    prompt_hash: str | None = None


def results_text(active: list[Criterion], outcomes: list[CriterionOutcome], score: ScoreResult, rubric: Rubric) -> str:
    """The criteria results as the summarizer reads them: rubric data and enum answers only, never conversation text."""
    names = {c.criterion_id: c.name for c in active}
    lines = []
    for o in outcomes:
        label = o.criterion_id + (f" ({names[o.criterion_id]})" if names.get(o.criterion_id) else "")
        if o.normalized_score is None:
            lines.append(f"- {label}: {o.applicability.value}")
        else:
            share = o.weighted_score if o.weighted_score is not None else 0.0
            lines.append(f"- {label}: resposta={o.answer}; nota={o.normalized_score:g}; peso={o.weight:g}; contribuição={share:g}"
                         + ("; obrigatório" if o.required else ""))
    minimum = rubric.policy.minimum_approval_score
    lines.append(f"Nota final: {score.overall_score:g} (mínimo de aprovação {minimum:g}); aprovação: {score.approval_status}")
    return "\n".join(lines)


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
    def __init__(self, provider: AIProvider, *, mode: str, clock: Callable[[], datetime] = lambda: datetime.now(UTC),
                 recorder: SpendRecorder | None = None, summarizer: Summarizer | None = None) -> None:
        self._provider = provider
        self._summarizer = summarizer  # None: no rubric gets a general evaluation, whatever its prompt says
        self._mode = mode
        self._clock = clock
        self._recorder = recorder  # every paid call is recorded right after the provider answers, before scoring and storing

    @property
    def prompt_version(self) -> str:
        """What produced the analysis. An engine with a summarizer makes a different logical result from one without (it also writes a
        summary), so the summarizer's version is part of it, like the evidence step is part of the provider's."""
        return self._provider.prompt_version + (f";summary={self._summarizer.version}" if self._summarizer else "")

    @property
    def identity(self) -> AnalysisIdentity:
        return AnalysisIdentity(model=self._provider.model, prompt_version=self.prompt_version)

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
        content_hash = session_content_hash(messages)
        aid = analysis_id(
            organization_id=organization_id, workspace_id=workspace_id, session_id=session_id, rubric_id=rubric.rubric_id,
            rubric_version=rubric.version, content_hash=content_hash, model=self._provider.model,
            prompt_version=self.prompt_version)
        active = list(rubric.active_criteria)
        gap = evidence_gap(messages, rubric.policy)
        if gap:
            # Not enough conversation to judge: abstain deterministically, no provider call, no cost.
            response = ProviderResponse(answers=[ProviderAnswer(criterion_id=c.criterion_id, state=AnswerState.INSUFFICIENT_EVIDENCE)
                                                 for c in active])
        else:
            response = await self._provider.evaluate(conversation.text, active)
            await record_best_effort(self._recorder, spend_row(
                kind="ANALYSIS", organization_id=organization_id, workspace_id=workspace_id, session_id=session_id, subject_id=aid,
                mode=self._mode, model=self._provider.model, input_tokens=response.usage.input_tokens,
                output_tokens=response.usage.output_tokens, cost_usd=response.usage.estimated_cost_usd, now=self._clock()))
        by_id = self._index_answers(response.answers, active)
        outcomes = [self._outcome(c, by_id.get(c.criterion_id), set(conversation.message_ids)) for c in active]
        if gap:
            for o in outcomes:
                o.warnings.append(f"below minimum evidence: {gap}")
        self._apply_applicability_rules(active, outcomes)
        score = calculate_score(
            [CriterionResult(criterion_id=o.criterion_id, weight=o.weight, required=o.required,
                             score=o.normalized_score, applicability=o.applicability) for o in outcomes],
            rubric.policy.minimum_approval_score, rubric.policy.missing_evidence_policy,
        )
        total = score.applicable_weight
        for o in outcomes:
            if o.normalized_score is not None and total > 0 and score.status == "COMPLETED":
                o.weighted_score = round(o.weight * o.normalized_score / total, 4)
        written = await self._summarize(rubric, active, outcomes, score, conversation, aid, organization_id, workspace_id, session_id)
        return Evaluation(
            analysis_id=aid,
            organization_id=organization_id, workspace_id=workspace_id, session_id=session_id,
            rubric_id=rubric.rubric_id, rubric_version=rubric.version,
            rubric_snapshot_hash=rubric.snapshot_hash, session_content_hash=content_hash,
            analysis_mode=self._mode, model=self._provider.model,
            prompt_version=self.prompt_version, score=score, criteria=outcomes,
            input_tokens=response.usage.input_tokens + written.usage.input_tokens,
            output_tokens=response.usage.output_tokens + written.usage.output_tokens,
            estimated_cost_usd=round(response.usage.estimated_cost_usd + written.usage.estimated_cost_usd, 8),
            started_at=started, completed_at=self._clock(),
            summary=written.result.summary, summary_model=written.model, summary_version=written.version,
            summary_prompt_hash=written.prompt_hash, summary_input_tokens=written.usage.input_tokens,
            summary_output_tokens=written.usage.output_tokens, summary_cost_usd=round(written.usage.estimated_cost_usd, 8),
            summary_error=written.result.error,
        )

    async def _summarize(
        self, rubric: Rubric, active: list[Criterion], outcomes: list[CriterionOutcome], score: ScoreResult, conversation: Any,
        aid: str, organization_id: str, workspace_id: str, session_id: str,
    ) -> _Written:
        """The general evaluation, once the score is final. Only for a rubric that carries a prompt, a configured summarizer and an
        analysis that was completed. It cannot change anything above it and cannot lose the analysis: whatever goes wrong is an error
        code on the result."""
        if self._summarizer is None or not rubric.summary_prompt or score.status != "COMPLETED":
            return _Written(result=SummaryResult(), usage=ProviderUsage())
        prompt_hash = canonical_hash(rubric.summary_prompt)[:32]
        try:
            result = await self._summarizer.summarize(
                prompt=rubric.summary_prompt, conversation_text=conversation.text,
                results_text=results_text(active, outcomes, score, rubric), message_ids=frozenset(conversation.message_ids))
        except Exception as exc:
            log.warning("summary failed", extra={
                "event": "summary_failed", "error_type": type(exc).__name__, "rubric_id": rubric.rubric_id})
            result = SummaryResult(error=type(exc).__name__)
        usage = result.usage
        if usage.input_tokens or usage.output_tokens or usage.estimated_cost_usd:  # an answer that was received was paid for, usable or not
            await record_best_effort(self._recorder, spend_row(
                kind="SUMMARY", organization_id=organization_id, workspace_id=workspace_id, session_id=session_id, subject_id=aid,
                mode=self._mode, model=self._summarizer.model, input_tokens=usage.input_tokens, output_tokens=usage.output_tokens,
                cost_usd=usage.estimated_cost_usd, now=self._clock()))
        return _Written(result=result, usage=usage, model=self._summarizer.model, version=self._summarizer.version, prompt_hash=prompt_hash)

    @staticmethod
    def _condition_verdict(by_id: dict[str, CriterionOutcome], cond: RuleCondition) -> tuple[Applicability | None, str]:
        """None = the condition holds; otherwise the verdict it forces and why."""
        gate = by_id.get(cond.criterion_id)
        if gate is None:  # unreachable for validated rubrics (the gate must be enabled)
            return Applicability.INSUFFICIENT_EVIDENCE, f"gate {cond.criterion_id} missing"
        if gate.applicability == Applicability.NOT_APPLICABLE:
            return Applicability.NOT_APPLICABLE, f"gate {cond.criterion_id} not applicable"
        if gate.applicability != Applicability.APPLICABLE or gate.answer is None:
            return Applicability.INSUFFICIENT_EVIDENCE, f"gate {cond.criterion_id} unanswered"
        key = str(gate.answer).lower() if isinstance(gate.answer, bool) else str(gate.answer)
        if key in cond.equals:
            return None, ""
        return Applicability.NOT_APPLICABLE, f"gate {cond.criterion_id} did not match"

    @classmethod
    def _apply_applicability_rules(cls, active: list[Criterion], outcomes: list[CriterionOutcome]) -> None:
        """Deterministic rules, evaluated on the gate criteria's mapped answers (never on model confidence).

        Per condition: gate answer in `equals` -> holds; answered something else or gate not applicable -> NOT_APPLICABLE (excluded from the
        score, not zero); gate unanswered / insufficient -> INSUFFICIENT_EVIDENCE (we cannot tell whether it applies).
        `all_of` combines them: a definite NOT_APPLICABLE from any condition wins over INSUFFICIENT_EVIDENCE, which wins over "holds"."""
        by_id = {o.criterion_id: o for o in outcomes}
        for c in active:
            rule = c.applicability_rule
            if rule is None:
                continue
            verdicts = [cls._condition_verdict(by_id, cond) for cond in rule.conditions]
            failing = [v for v in verdicts if v[0] is not None]
            if not failing:
                continue
            decisive = next((v for v in failing if v[0] == Applicability.NOT_APPLICABLE), failing[0])
            verdict, note = decisive
            assert verdict is not None
            o = by_id[c.criterion_id]
            o.applicability, o.normalized_score, o.weighted_score = verdict, None, None
            o.answer, o.confidence, o.evidence_message_ids = None, None, []
            o.warnings.append(f"applicability rule: {note}")

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
