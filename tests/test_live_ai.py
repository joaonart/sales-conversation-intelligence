"""The live worker's AI wiring: off by default, closed model list, mandatory monthly budget, never a key in a message."""
import pytest

from sci_core.engine import EvaluationEngine
from sci_openai.catalog import find
from sci_workers.live_ai import LiveAIConfigError, build_live_ai

KEY = "sk-test-not-a-real-key"
ON = {"AI_ENABLED": "true", "OPENAI_API_KEY": KEY, "LIVE_MONTHLY_BUDGET_USD": "5"}


def test_ai_is_off_unless_explicitly_enabled():
    for env in ({}, {"AI_ENABLED": "false"}, {"AI_ENABLED": "TRUE"}, {"AI_ENABLED": "1"}, {"OPENAI_API_KEY": KEY, "LIVE_MONTHLY_BUDGET_USD": "5"}):
        assert build_live_ai(env, routing=False) is None, env  # nothing is built, nothing can be called


def test_enabled_uses_the_catalog_default_and_its_worst_case_prices():
    ai = build_live_ai(ON, routing=False)
    assert ai is not None
    assert (ai.provider, ai.model) == ("decisions", "gpt-6-luna")
    assert isinstance(ai.engine, EvaluationEngine) and ai.router_provider is None
    assert (ai.prices.input_per_million, ai.prices.output_per_million) == (0.125, 0.5)  # the dearest input rate: the budget gate is conservative
    assert ai.monthly_budget_usd == 5.0


def test_a_responses_model_from_the_catalog_gets_its_own_prices_and_identity():
    ai = build_live_ai({**ON, "LIVE_PROVIDER": "responses", "LIVE_MODEL": "gpt-4o"}, routing=False)
    assert ai is not None and (ai.provider, ai.model) == ("responses", "gpt-4o")
    entry = find("responses", "gpt-4o")
    assert ai.prices.input_per_million == entry.prices.worst_case_price_book().input_per_million == 2.5
    assert ai.engine.identity.model == "gpt-4o"


def test_routing_adds_a_router_that_uses_the_same_provider_and_model():
    with_router = build_live_ai({**ON, "LIVE_PROVIDER": "responses", "LIVE_MODEL": "gpt-4o"}, routing=True)
    assert with_router is not None and with_router.router_provider is not None
    assert with_router.router_provider.model == "gpt-4o"
    assert build_live_ai(ON, routing=False).router_provider is None  # type: ignore[union-attr]


@pytest.mark.parametrize(
    "over, why",
    [
        ({"LIVE_PROVIDER": "responses"}, "a Responses model must be named"),
        ({"LIVE_PROVIDER": "responses", "LIVE_MODEL": "gpt-5.5-pro"}, "real model, not in the closed list"),
        ({"LIVE_PROVIDER": "decisions", "LIVE_MODEL": "gpt-4o"}, "a model of the other API"),
        ({"LIVE_PROVIDER": "completions", "LIVE_MODEL": "gpt-4o"}, "unknown API"),
        ({"LIVE_MONTHLY_BUDGET_USD": ""}, "no monthly cap"),
        ({"LIVE_MONTHLY_BUDGET_USD": "0"}, "a zero cap is not a cap"),
        ({"LIVE_MONTHLY_BUDGET_USD": "-3"}, "negative"),
        ({"LIVE_MONTHLY_BUDGET_USD": "abc"}, "not a number"),
        ({"OPENAI_API_KEY": ""}, "empty key"),
    ],
)
def test_a_half_configured_worker_refuses_to_start(over, why):
    with pytest.raises(LiveAIConfigError):
        build_live_ai({**ON, **over}, routing=False)


def test_a_missing_key_refuses_to_start_and_the_message_never_contains_a_key():
    env = {"AI_ENABLED": "true", "LIVE_MONTHLY_BUDGET_USD": "5"}
    with pytest.raises(LiveAIConfigError) as e:
        build_live_ai(env, routing=False)
    assert KEY not in str(e.value) and "sk-" not in str(e.value)
    with pytest.raises(LiveAIConfigError) as e2:
        build_live_ai({**ON, "LIVE_PROVIDER": "responses", "LIVE_MODEL": "nope"}, routing=False)
    assert KEY not in str(e2.value)


def test_live_main_wires_the_ai_only_through_the_gated_builder():
    from pathlib import Path

    text = (Path(__file__).parent.parent / "apps" / "workers" / "src" / "sci_workers" / "live_main.py").read_text()
    assert "engine=None" not in text and "build_live_ai(os.environ" in text
    assert "engine=ai.engine if ai else None" in text  # still None (503, backlog kept) while AI is disabled


def test_evidence_is_off_unless_a_catalog_model_is_named():
    assert build_live_ai(ON, routing=False).evidence_model is None  # type: ignore[union-attr]
    ai = build_live_ai({**ON, "LIVE_EVIDENCE_MODEL": ""}, routing=False)
    assert ai is not None and ai.evidence_model is None


def test_evidence_adds_the_second_call_to_the_identity_and_to_the_budget_rates():
    plain = build_live_ai(ON, routing=False)
    ai = build_live_ai({**ON, "LIVE_EVIDENCE_MODEL": "gpt-4o-mini"}, routing=False)
    assert plain is not None and ai is not None and ai.evidence_model == "gpt-4o-mini"
    assert ai.prices.input_per_million > plain.prices.input_per_million and ai.prices.output_per_million > plain.prices.output_per_million
    assert "evidence=responses-evidence-v2" in ai.engine.identity.prompt_version and "evidence=" not in plain.engine.identity.prompt_version  # a different analysis_id


@pytest.mark.parametrize("env", [
    {"LIVE_EVIDENCE_MODEL": "gpt-5.5-pro"},                                                        # not in the closed list
    {"LIVE_EVIDENCE_MODEL": "gpt-6-luna"},                                                          # a Decisions model cannot cite
    {"LIVE_PROVIDER": "responses", "LIVE_MODEL": "gpt-4o", "LIVE_EVIDENCE_MODEL": "gpt-4o-mini"},   # responses already returns evidence
])
def test_a_bad_evidence_choice_stops_the_worker_at_start_up_without_a_key_in_the_message(env):
    with pytest.raises(LiveAIConfigError) as e:
        build_live_ai({**ON, **env}, routing=False)
    assert KEY not in str(e.value)


def test_the_general_evaluation_is_off_unless_a_catalog_model_is_named():
    assert build_live_ai(ON, routing=False).summary_model is None  # type: ignore[union-attr]
    ai = build_live_ai({**ON, "LIVE_SUMMARY_MODEL": ""}, routing=False)
    assert ai is not None and ai.summary_model is None


def test_the_summary_adds_the_third_call_to_the_identity_and_to_the_budget_rates_and_stacks_with_evidence():
    plain = build_live_ai(ON, routing=False)
    both = build_live_ai({**ON, "LIVE_EVIDENCE_MODEL": "gpt-4o-mini", "LIVE_SUMMARY_MODEL": "gpt-4o-mini"}, routing=False)
    only_ev = build_live_ai({**ON, "LIVE_EVIDENCE_MODEL": "gpt-4o-mini"}, routing=False)
    summary_only = build_live_ai({**ON, "LIVE_SUMMARY_MODEL": "gpt-4o-mini"}, routing=False)
    assert plain and both and only_ev and summary_only and both.summary_model == "gpt-4o-mini"
    assert summary_only.prices.input_per_million > plain.prices.input_per_million and summary_only.prices.output_per_million > plain.prices.output_per_million
    assert both.prices.input_per_million > only_ev.prices.input_per_million  # the third call is priced on top of the second
    assert both.engine.identity.prompt_version.endswith(";summary=responses-summary-v1") and ";summary=" not in plain.engine.identity.prompt_version


@pytest.mark.parametrize("model", ["gpt-5.5-pro", "gpt-6-luna"])
def test_a_summary_model_outside_the_closed_list_or_unable_to_write_text_stops_the_worker_at_start_up(model):
    with pytest.raises(LiveAIConfigError) as e:
        build_live_ai({**ON, "LIVE_SUMMARY_MODEL": model}, routing=False)
    assert KEY not in str(e.value)
