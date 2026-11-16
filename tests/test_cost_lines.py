"""Every paid call is its own line of the spend ledger, named for the step and the model that was paid, and the lines add up to the total of the analysis:
the analysis, the evidence call (a second call, to another model) and the general evaluation (a third)."""
import json
from datetime import UTC, datetime

import pytest

from sci_core.engine import EvaluationEngine
from sci_core.provider import ProviderAnswer, ProviderResponse, ProviderUsage
from sci_core.rubric import Rubric
from sci_core.summary import Summary, SummaryResult

NOW = datetime(2026, 11, 16, tzinfo=UTC)
ANSWERS = [ProviderAnswer(criterion_id="greeting", answer=True, evidence_message_ids=["m2"]),
           ProviderAnswer(criterion_id="needs", answer="partial", evidence_message_ids=["m1"])]


class Provider:
    """A Decisions-like provider: `usage` is the WHOLE response (analysis + evidence), `evidence_usage` the evidence call's part of it."""

    prompt_version = "p1"

    def __init__(self, *, model="gpt-6-luna", evidence=True, response_model_as_evidence="gpt-4o-mini"):
        self.model, self.evidence, self.evidence_model = model, evidence, response_model_as_evidence

    async def evaluate(self, text, criteria):
        if not self.evidence:
            return ProviderResponse(answers=ANSWERS, usage=ProviderUsage(input_tokens=1000, output_tokens=100, estimated_cost_usd=0.0003))
        return ProviderResponse(
            answers=ANSWERS, usage=ProviderUsage(input_tokens=1000 + 1500, output_tokens=100 + 120, estimated_cost_usd=0.0003 + 0.0002),
            evidence_usage=ProviderUsage(input_tokens=1500, output_tokens=120, estimated_cost_usd=0.0002), evidence_model=self.evidence_model)


class Summarizer:
    model, version = "gpt-4o-mini", "s1"

    async def summarize(self, *, prompt, conversation_text, results_text, message_ids):
        return SummaryResult(summary=Summary(overall="Boa conversa."), usage=ProviderUsage(input_tokens=1800, output_tokens=350, estimated_cost_usd=0.0005))


class Ledger:
    def __init__(self):
        self.rows = []

    async def record(self, row):
        self.rows.append(row)


async def run(rubric_json, session, *, provider=None, summarizer=None):
    ledger = Ledger()
    rubric = Rubric.model_validate({**rubric_json, "summary_prompt": "Escreva a avaliação geral." if summarizer else None})
    engine = EvaluationEngine(provider or Provider(), mode="historical", clock=lambda: NOW, recorder=ledger, summarizer=summarizer)
    ev = await engine.evaluate(organization_id="demo", workspace_id="default", session_id="s001", messages=session["messages"], rubric=rubric)
    return ev, ledger.rows


def by_kind(rows):
    return {r["kind"]: r for r in rows}


async def test_the_evidence_call_is_its_own_line_to_its_own_model_and_the_analysis_line_is_what_is_left(rubric_json, session):
    ev, rows = await run(rubric_json, session)
    assert [r["kind"] for r in rows] == ["ANALYSIS", "EVIDENCE"]
    analysis, evidence = rows
    assert (analysis["model"], analysis["input_tokens"], analysis["output_tokens"], analysis["cost_usd"]) == ("gpt-6-luna", 1000, 100, 0.0003)
    assert (evidence["model"], evidence["input_tokens"], evidence["output_tokens"], evidence["cost_usd"]) == ("gpt-4o-mini", 1500, 120, 0.0002)
    assert {r["subject_id"] for r in rows} == {ev.analysis_id}  # both belong to the same analysis
    assert evidence["spend_id"].startswith("evidence-")


async def test_with_the_general_evaluation_there_are_three_lines_and_they_add_up_to_the_analysis_total(rubric_json, session):
    ev, rows = await run(rubric_json, session, summarizer=Summarizer())
    assert [r["kind"] for r in rows] == ["ANALYSIS", "EVIDENCE", "SUMMARY"]
    assert by_kind(rows)["SUMMARY"]["model"] == "gpt-4o-mini" and by_kind(rows)["SUMMARY"]["cost_usd"] == 0.0005
    assert round(sum(r["cost_usd"] for r in rows), 8) == ev.estimated_cost_usd == pytest.approx(0.001)  # no cost is lost and none is counted twice
    assert sum(r["input_tokens"] for r in rows) == ev.input_tokens and sum(r["output_tokens"] for r in rows) == ev.output_tokens


async def test_without_an_evidence_call_there_is_no_evidence_line_and_the_analysis_line_is_the_whole_response(rubric_json, session):
    ev, rows = await run(rubric_json, session, provider=Provider(evidence=False), summarizer=Summarizer())
    assert [r["kind"] for r in rows] == ["ANALYSIS", "SUMMARY"]
    assert by_kind(rows)["ANALYSIS"]["cost_usd"] == 0.0003
    assert round(sum(r["cost_usd"] for r in rows), 8) == ev.estimated_cost_usd


async def test_an_evidence_call_that_was_paid_but_gave_nothing_usable_is_still_a_line(rubric_json, session):
    """The extractor reports its cost even when its answer could not be used ("a response that was received is charged")."""
    ev, rows = await run(rubric_json, session)
    assert by_kind(rows)["EVIDENCE"]["cost_usd"] > 0
    assert ev.estimated_cost_usd == pytest.approx(0.0005)


async def test_the_ledger_lines_never_carry_content(rubric_json, session):
    _, rows = await run(rubric_json, session, summarizer=Summarizer())
    for row in rows:
        assert set(row) == {"spend_id", "organization_id", "workspace_id", "session_id", "kind", "subject_id", "mode", "model", "input_tokens",
                            "output_tokens", "cost_usd", "occurred_at"}
        assert "Boa conversa" not in json.dumps(row)
