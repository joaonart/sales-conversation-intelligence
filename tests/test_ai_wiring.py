import os

import pytest

from sci_core.engine import EvaluationEngine
from sci_workers.ai import MissingApiKey, api_key_provider, build_engine


def test_key_from_env() -> None:
    assert api_key_provider({"OPENAI_API_KEY": " sk-test \n"})() == "sk-test"


def test_missing_or_empty_key_is_refused() -> None:
    with pytest.raises(MissingApiKey):
        api_key_provider({})
    with pytest.raises(MissingApiKey):
        api_key_provider({"OPENAI_API_KEY": "  "})


def test_key_file_must_be_private(tmp_path) -> None:  # type: ignore[no-untyped-def]
    f = tmp_path / "k"
    f.write_text("sk-file\n")
    os.chmod(f, 0o644)
    with pytest.raises(MissingApiKey) as err:
        api_key_provider({"OPENAI_API_KEY_FILE": str(f)})
    assert "sk-file" not in str(err.value)
    os.chmod(f, 0o600)
    assert api_key_provider({"OPENAI_API_KEY_FILE": str(f)})() == "sk-file"


def test_build_engine_does_not_read_key_eagerly() -> None:
    def boom() -> str:
        raise AssertionError("key must be read lazily, at request time")

    assert isinstance(build_engine(mode="historical", tenant_safety_id=None, key=boom), EvaluationEngine)


def test_responses_provider_requires_explicit_model_and_prices() -> None:
    from sci_openai.pricing import TokenPrices

    with pytest.raises(ValueError, match="model"):
        build_engine(mode="historical", tenant_safety_id=None, key=lambda: "k", provider="responses")
    with pytest.raises(ValueError, match="prices"):
        build_engine(mode="historical", tenant_safety_id=None, key=lambda: "k", provider="responses", model="m")
    eng = build_engine(mode="historical", tenant_safety_id=None, key=lambda: "k", provider="responses", model="m",
                       prices=TokenPrices(1.0, 0.5, 1.0, 2.0))
    dec = build_engine(mode="historical", tenant_safety_id=None, key=lambda: "k")
    assert eng.identity.model == "m" and eng.identity != dec.identity  # never the same logical result as Decisions


def test_historical_cli_provider_selection() -> None:
    from sci_workers.historical_main import parse

    base = ["preflight", "--project", "p", "--org", "o", "--workspace", "w", "--rubric-id", "r", "--rubric-version", "1",
            "--start", "2026-01-01", "--end", "2026-01-02", "--max-cost-usd", "1", "--max-sessions", "5",
            "--input-price-per-million", "1", "--output-price-per-million", "2"]
    assert parse(base).provider == "decisions"  # default keeps the validated path
    assert parse([*base, "--provider", "responses", "--responses-model", "m"]).responses_model == "m"
    with pytest.raises(SystemExit):
        parse([*base, "--provider", "responses"])  # model is mandatory
