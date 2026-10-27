import json
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent.parent / "fixtures"


@pytest.fixture
def session() -> dict:
    return json.loads((FIXTURES / "session.json").read_text())


@pytest.fixture
def rubric_json() -> dict:
    return json.loads((FIXTURES / "rubric.json").read_text())
