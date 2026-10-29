import json
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent.parent / "fixtures"


@pytest.fixture
def session() -> dict:
    return json.loads((FIXTURES / "session.json").read_text())


@pytest.fixture
def rubric_json() -> dict:
    r = json.loads((FIXTURES / "rubric.json").read_text())
    r["policy"] = {**r["policy"], "min_messages": 0}  # most tests use tiny sessions; the evidence gate has its own tests
    return r
