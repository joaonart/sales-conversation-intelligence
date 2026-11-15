"""A session analysed live and one analysed on demand must get the same things: the same evidence, the same general evaluation, the same identity
(model + prompt version, which is also the dedupe key) and a ceiling that covers the same paid calls. This file holds the two paths together:
a feature added to one and forgotten in the other fails here."""
import re
from pathlib import Path

import pytest

from sci_bq.source import Tenant
from sci_console_executor.jobs import ExecutorJobs
from sci_console_executor.main import parse as parse_executor_args
from sci_console_executor.requests import Params, RunRequest
from sci_core.budget import PriceBook
from sci_openai.pricing import LUNA_STANDARD_SHORT
from sci_workers.historical_main import parse as parse_historical_args
from sci_workers.live_ai import build_live_ai

ROOT = Path(__file__).resolve().parent.parent
PLATFORM = ROOT / "infra" / "terraform" / "modules" / "platform"
KEY = "sk-test-not-a-real-key"
LIVE_ON = {"AI_ENABLED": "true", "OPENAI_API_KEY": KEY, "LIVE_MONTHLY_BUDGET_USD": "5"}
REQUIRED = {"prices_in": 1.0, "prices_out": 1.0}


def on_demand(provider: str = "decisions", model: str | None = None, *, evidence: str | None, summary: str | None) -> ExecutorJobs:
    """The executor's jobs as main.py builds them for the same settings (no BigQuery: only the pure parts are exercised)."""
    jobs = object.__new__(ExecutorJobs)
    jobs._key = lambda: KEY
    jobs._spend = None
    jobs._provider, jobs._model, jobs._prices, jobs._book = provider, model, LUNA_STANDARD_SHORT, PriceBook(0.125, 0.5)
    jobs._evidence_model, jobs._summary_model = evidence, summary
    return jobs


def live_env(*, evidence: str | None, summary: str | None, provider: str = "decisions", model: str = "") -> dict[str, str]:
    env = {**LIVE_ON, "LIVE_PROVIDER": provider}
    if model:
        env["LIVE_MODEL"] = model
    if evidence:
        env["LIVE_EVIDENCE_MODEL"] = evidence
    if summary:
        env["LIVE_SUMMARY_MODEL"] = summary
    return env


def request(provider: str | None = None, model: str | None = None) -> RunRequest:
    return RunRequest(request_id="r", tenant=Tenant("o", "w"), kind="SESSION_ANALYSIS", max_cost_usd=0.1, requested_by="a@x.com", params=Params(provider=provider, model=model))


SETTINGS = [
    pytest.param(None, None, id="neither"),
    pytest.param("gpt-4o-mini", None, id="evidence only"),
    pytest.param(None, "gpt-4o-mini", id="summary only"),
    pytest.param("gpt-4o-mini", "gpt-4o-mini", id="both (the dev setting)"),
]


@pytest.mark.parametrize(("evidence", "summary"), SETTINGS)
def test_the_same_settings_give_the_same_analysis_identity_live_and_on_demand(evidence, summary):
    live = build_live_ai(live_env(evidence=evidence, summary=summary), routing=False)
    assert live is not None
    jobs = on_demand(evidence=evidence, summary=summary)
    provider, model, prices, _ = jobs._choice(request())
    engine = jobs._engine(provider, model, prices)
    assert engine.identity == live.engine.identity  # model + prompt version: also the dedupe key, so the two paths do not repeat each other's work
    assert (";evidence=" in engine.prompt_version) == bool(evidence)
    assert (";summary=" in engine.prompt_version) == bool(summary)


@pytest.mark.parametrize(("evidence", "summary"), SETTINGS)
def test_the_same_settings_give_the_same_ceiling_live_and_on_demand(evidence, summary):
    live = build_live_ai(live_env(evidence=evidence, summary=summary), routing=False)
    assert live is not None
    _, _, _, book = on_demand(evidence=evidence, summary=summary)._choice(request())
    assert (book.input_per_million, book.output_per_million) == (live.prices.input_per_million, live.prices.output_per_million)


def test_with_the_responses_api_the_evidence_step_never_applies_on_either_path_but_the_summary_does():
    live = build_live_ai(live_env(evidence=None, summary="gpt-4o-mini", provider="responses", model="gpt-4o"), routing=False)
    assert live is not None
    jobs = on_demand(evidence="gpt-4o-mini", summary="gpt-4o-mini")  # an executor with evidence on, asked for a Responses analysis in the console
    provider, model, prices, book = jobs._choice(request("responses", "gpt-4o"))
    engine = jobs._engine(provider, model, prices)
    assert engine.identity == live.engine.identity
    assert ";evidence=" not in engine.prompt_version and ";summary=" in engine.prompt_version
    assert (book.input_per_million, book.output_per_million) == (live.prices.input_per_million, live.prices.output_per_million)


HISTORICAL = ["preflight", "--org", "o", "--workspace", "w", "--rubric-id", "r", "--rubric-version", "1", "--start", "2026-10-01", "--end", "2026-10-31",
              "--max-cost-usd", "0.1", "--max-sessions", "10", "--project", "p", "--input-price-per-million", "0.125", "--output-price-per-million", "0.5"]


def test_the_executor_and_the_historical_command_take_the_same_ai_steps_as_the_live_service():
    base = ["once", "--project", "p", "--tenant", "o/w", "--input-price-per-million", "0.125", "--output-price-per-million", "0.5"]
    ex = parse_executor_args([*base, "--evidence-model", "gpt-4o-mini", "--summary-model", "gpt-4o-mini"])
    assert (ex.evidence_model, ex.summary_model) == ("gpt-4o-mini", "gpt-4o-mini")
    hist = parse_historical_args([*HISTORICAL, "--evidence-model", "gpt-4o-mini", "--summary-model", "gpt-4o-mini"])
    assert (hist.evidence_model, hist.summary_model) == ("gpt-4o-mini", "gpt-4o-mini")
    with pytest.raises(SystemExit):  # a model outside the closed catalog is refused at start, like in the live service
        parse_historical_args([*HISTORICAL, "--evidence-model", "gpt-nope"])


def test_the_environment_names_follow_each_other_in_terraform():
    run, ex = (PLATFORM / "run.tf").read_text(), (PLATFORM / "executor.tf").read_text()
    live_models = set(re.findall(r"\b(LIVE_[A-Z]+_MODEL)\s*=", run)) - {"LIVE_MODEL"}
    executor_models = set(re.findall(r"\b(EXECUTOR_[A-Z]+_MODEL)\s*=", ex))
    assert live_models == {"LIVE_EVIDENCE_MODEL", "LIVE_SUMMARY_MODEL"}
    # every extra AI step of the live service has its twin in the executor's environment (and the other way round)
    assert {m.replace("LIVE_", "EXECUTOR_") for m in live_models} == executor_models


def test_every_ai_step_variable_of_the_live_service_has_a_twin_for_the_executor_and_the_environments_pass_both_through():
    variables = (PLATFORM / "variables.tf").read_text()
    dev_main = (ROOT / "infra" / "terraform" / "environments" / "dev" / "main.tf").read_text()
    dev_vars = (ROOT / "infra" / "terraform" / "environments" / "dev" / "variables.tf").read_text()
    for step in ("evidence", "summary"):
        for var in (f"live_{step}_model", f"executor_{step}_model"):
            assert f'variable "{var}"' in variables, var
            assert f'variable "{var}"' in dev_vars, var
            assert f"{var} " in dev_main and f"= var.{var}" in dev_main, var


DEV = ROOT / "infra" / "terraform" / "environments" / "dev"


def tfvar(name: str) -> str:
    text = (DEV / "terraform.tfvars").read_text()
    hit = re.search(rf'^{name}\s*=\s*"([^"]*)"', text, re.M)
    return hit.group(1) if hit else ""


@pytest.mark.skipif(not (DEV / "terraform.tfvars").exists(), reason="terraform.tfvars holds real ids and is not versioned: this runs where it exists (a developer's machine)")
@pytest.mark.parametrize("step", ["evidence", "summary"])
def test_in_dev_the_executor_has_every_ai_step_the_live_service_has(step):
    """The dev environment is where both run: the same step on in one and off in the other is exactly the gap this file exists to close."""
    assert tfvar(f"executor_{step}_model") == tfvar(f"live_{step}_model")
    assert tfvar(f"live_{step}_model") != "", f"live_{step}_model is off in dev: turn it on in both or document why not"


@pytest.mark.parametrize("step", ["evidence", "summary"])
def test_the_versioned_example_tells_to_set_both_steps_of_the_pair(step):
    example = (DEV / "terraform.tfvars.example").read_text()
    assert f"live_{step}_model" in example and f"executor_{step}_model" in example
