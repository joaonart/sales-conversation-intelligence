"""The general evaluation (summary): the rubric carries its prompt, the engine writes it after the score, and it can never change or lose the analysis."""
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from sci_core.engine import EvaluationEngine, results_text
from sci_core.provider import ProviderAnswer, ProviderResponse, ProviderUsage
from sci_core.rubric import MAX_SUMMARY_PROMPT_CHARS, Rubric
from sci_core.summary import Summary, SummaryItem, SummaryResult

NOW = datetime(2026, 1, 1, tzinfo=UTC)
PROMPT = "Escreva a avaliação geral desta conversa de vendas."
ANSWERS = [ProviderAnswer(criterion_id="greeting", answer=True, evidence_message_ids=["m2"]),
           ProviderAnswer(criterion_id="needs", answer="partial", evidence_message_ids=["m1"])]


class FakeProvider:
    model, prompt_version = "fake-model", "p1"

    async def evaluate(self, text, criteria):
        return ProviderResponse(answers=ANSWERS, usage=ProviderUsage(input_tokens=1000, output_tokens=100, estimated_cost_usd=0.0003))


class FakeSummarizer:
    model, version = "summary-model", "s1"

    def __init__(self, result=None, raises=None):
        self.result, self.raises, self.calls = result, raises, []

    async def summarize(self, *, prompt, conversation_text, results_text, message_ids):
        self.calls.append({"prompt": prompt, "text": conversation_text, "results": results_text, "ids": message_ids})
        if self.raises:
            raise self.raises
        return self.result or SummaryResult(
            summary=Summary(overall="Boa conversa.", strengths=[SummaryItem(text="Cordial", message_ids=["m2"])],
                            weaknesses=[SummaryItem(text="Poucas perguntas", message_ids=[])], opportunities=[SummaryItem(text="Oferecer upgrade")]),
            usage=ProviderUsage(input_tokens=1800, output_tokens=350, estimated_cost_usd=0.0005))


class Ledger:
    def __init__(self):
        self.rows = []

    async def record(self, row):
        self.rows.append(row)


def rubric(rubric_json, prompt=PROMPT):
    return Rubric.model_validate({**rubric_json, "summary_prompt": prompt})


async def run(rubric_json, session, *, summarizer=None, prompt=PROMPT, answers=None):
    ledger = Ledger()
    provider = FakeProvider()
    if answers is not None:
        provider.evaluate = lambda text, criteria: _answer(answers)  # type: ignore[method-assign]
    engine = EvaluationEngine(provider, mode="live", clock=lambda: NOW, recorder=ledger, summarizer=summarizer)
    ev = await engine.evaluate(organization_id="demo", workspace_id="default", session_id="s001", messages=session["messages"],
                               rubric=rubric(rubric_json, prompt))
    return ev, ledger, engine


async def _answer(answers):
    return ProviderResponse(answers=answers, usage=ProviderUsage(input_tokens=1000, output_tokens=100, estimated_cost_usd=0.0003))


# ---- the rubric carries the prompt ----
def test_the_prompt_is_part_of_the_rubric_trimmed_and_blank_means_none(rubric_json):
    assert rubric(rubric_json, "  texto  ").summary_prompt == "texto"
    assert rubric(rubric_json, "   ").summary_prompt is None and rubric(rubric_json, None).summary_prompt is None


def test_the_prompt_has_a_limit(rubric_json):
    rubric(rubric_json, "x" * MAX_SUMMARY_PROMPT_CHARS)
    with pytest.raises(ValidationError):
        rubric(rubric_json, "x" * (MAX_SUMMARY_PROMPT_CHARS + 1))


def test_the_prompt_comes_from_the_bigquery_row_and_changes_the_snapshot_hash_only_when_there_is_one(rubric_json):
    header = {k: rubric_json[k] for k in ("organization_id", "workspace_id", "rubric_id", "version", "status")}
    crit_rows = [{"criterion_id": c["criterion_id"], "evaluation_instructions": c["instructions"], "evaluation_type": c["evaluation_type"],
                  "weight": c["weight"], "required": c.get("required", False), "enabled": True, "score_mapping": c["score_mapping"]}
                 for c in rubric_json["criteria"]]
    without = Rubric.from_rows(header, crit_rows)
    with_prompt = Rubric.from_rows({**header, "summary_prompt": PROMPT}, crit_rows)
    assert without.summary_prompt is None and with_prompt.summary_prompt == PROMPT
    assert with_prompt.snapshot_hash != without.snapshot_hash
    # a rubric with no prompt hashes exactly what it always did: the new field is not even in the hashed content
    from sci_core.hashing import canonical_hash
    assert without.snapshot_hash == canonical_hash(without.model_dump(mode="json", exclude={"name", "summary_prompt"}))
    assert "summary_prompt" in with_prompt.model_dump(mode="json")


# ---- the engine writes it after the score ----
async def test_the_summary_is_written_after_the_score_and_never_changes_it(rubric_json, session):
    plain, _, _ = await run(rubric_json, session)
    summarizer = FakeSummarizer()
    ev, ledger, _ = await run(rubric_json, session, summarizer=summarizer)
    assert ev.score == plain.score and [c.model_dump() for c in ev.criteria] == [c.model_dump() for c in plain.criteria]  # the score is the score
    assert ev.summary is not None and ev.summary.overall == "Boa conversa." and ev.summary_model == "summary-model" and ev.summary_version == "s1"
    row = ev.summary_row()
    assert row and row["analysis_id"] == ev.analysis_id and row["overall_summary"] == "Boa conversa."
    assert row["strengths"] == [{"text": "Cordial", "message_ids": ["m2"]}] and row["opportunities"][0]["message_ids"] == []
    assert row["estimated_cost_usd"] == 0.0005 and row["summary_prompt_hash"] and len(row["summary_prompt_hash"]) == 32


async def test_the_whole_analysis_cost_includes_the_summary_and_every_paid_call_is_in_the_ledger(rubric_json, session):
    ev, ledger, _ = await run(rubric_json, session, summarizer=FakeSummarizer())
    assert ev.estimated_cost_usd == pytest.approx(0.0008) and (ev.input_tokens, ev.output_tokens) == (2800, 450)
    assert [r["kind"] for r in ledger.rows] == ["ANALYSIS", "SUMMARY"]
    assert all(r["subject_id"] == ev.analysis_id for r in ledger.rows)  # both rows name the analysis, so the cap does not count it twice
    assert ledger.rows[1]["model"] == "summary-model" and ledger.rows[1]["cost_usd"] == 0.0005
    analysis, _ = ev.to_rows()
    assert analysis["estimated_cost_usd"] == pytest.approx(0.0008)


async def test_the_summarizer_gets_the_prompt_the_masked_conversation_the_results_and_the_only_ids_it_may_cite(rubric_json, session):
    s = FakeSummarizer()
    await run(rubric_json, session, summarizer=s)
    call = s.calls[0]
    assert call["prompt"] == PROMPT and "m1" in call["ids"] and isinstance(call["ids"], frozenset)
    assert "<<<MESSAGE" in call["text"] and "Nota final:" in call["results"] and "greeting" in call["results"]


async def test_an_engine_with_a_summarizer_is_a_different_logical_result(rubric_json, session):
    plain, _, plain_engine = await run(rubric_json, session)
    with_s, _, engine = await run(rubric_json, session, summarizer=FakeSummarizer())
    assert plain.prompt_version == "p1" and with_s.prompt_version == "p1;summary=s1"
    assert plain.analysis_id != with_s.analysis_id and engine.identity.prompt_version == "p1;summary=s1" and plain_engine.identity.prompt_version == "p1"


async def test_no_prompt_no_summarizer_or_an_unfinished_analysis_means_no_call(rubric_json, session):
    s = FakeSummarizer()
    ev, ledger, _ = await run(rubric_json, session, summarizer=s, prompt=None)  # a rubric that asks for none
    assert s.calls == [] and ev.summary is None and [r["kind"] for r in ledger.rows] == ["ANALYSIS"]
    ev, _, _ = await run(rubric_json, session, prompt=PROMPT)  # no summarizer configured, whatever the rubric says
    assert ev.summary is None
    held = await run(rubric_json, session, summarizer=s, answers=ANSWERS[:1])  # a missing answer: needs review, nothing to summarise
    assert held[0].score.status == "NEEDS_REVIEW" and s.calls == []


# ---- it can never lose the analysis ----
async def test_a_summarizer_that_raises_keeps_the_analysis_and_says_why(rubric_json, session):
    plain, _, _ = await run(rubric_json, session)
    ev, ledger, _ = await run(rubric_json, session, summarizer=FakeSummarizer(raises=RuntimeError("texto privado do cliente")))
    assert ev.score == plain.score and ev.summary is None and ev.summary_error == "RuntimeError" and ev.summary_row() is None
    assert "privado" not in str(ev.summary_error) and ev.estimated_cost_usd == pytest.approx(0.0003)  # nothing was charged for what never answered
    assert [r["kind"] for r in ledger.rows] == ["ANALYSIS"]


async def test_an_answer_that_could_not_be_used_is_still_paid_for(rubric_json, session):
    bad = SummaryResult(error="InvalidProviderResponse", usage=ProviderUsage(input_tokens=1800, output_tokens=40, estimated_cost_usd=0.0003))
    ev, ledger, _ = await run(rubric_json, session, summarizer=FakeSummarizer(result=bad))
    assert ev.summary is None and ev.summary_error == "InvalidProviderResponse"
    assert ev.estimated_cost_usd == pytest.approx(0.0006) and [r["kind"] for r in ledger.rows] == ["ANALYSIS", "SUMMARY"]


# ---- what the summarizer reads about the criteria ----
async def test_the_results_text_is_rubric_data_only(rubric_json, session):
    s = FakeSummarizer()
    await run(rubric_json, session, summarizer=s)
    text = s.calls[0]["results"]
    assert "resposta=partial" in text and "contribuição=" in text and "aprovação: " in text
    assert not any(m["content"] in text for m in session["messages"])  # never the conversation itself
    r = rubric(rubric_json)
    ev, _, _ = await run(rubric_json, session)
    assert results_text(list(r.active_criteria), ev.criteria, ev.score, r).count("\n") == len(ev.criteria)
