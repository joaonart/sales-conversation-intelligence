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
