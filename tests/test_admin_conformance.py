"""The admin console re-implements mask_pii and the rubric rules in TypeScript. Both sides run these shared cases."""

import json
from pathlib import Path

import pytest

from sci_core.context import mask_pii
from sci_core.rubric import Rubric, RubricError

FIXTURE = json.loads((Path(__file__).parent.parent / "fixtures" / "admin_conformance.json").read_text())


@pytest.mark.parametrize("case", FIXTURE["mask"], ids=lambda c: c["input"][:30])
def test_mask_pii_matches_console(case):
    assert mask_pii(case["input"]) == case["expected"]


def _python_valid(criteria: list[dict]) -> bool:
    rows = [
        {
            "criterion_id": c["criterion_id"],
            "criterion_name": c["criterion_name"],
            "evaluation_instructions": c["evaluation_instructions"],
            "evaluation_type": c["evaluation_type"],
            "weight": c["weight"],
            "required": c["required"],
            "enabled": c["enabled"],
            "score_mapping": json.dumps(c["score_mapping"]),
            "score_levels": json.dumps(c["level_descriptions"]) if c["level_descriptions"] else None,
            "applicability_rule": json.dumps({"type": "depends_on", **c["applicability_rule"]}) if c.get("applicability_rule") else None,
            "display_order": c["display_order"],
        }
        for c in criteria
    ]
    try:
        Rubric.from_rows({"organization_id": "o", "workspace_id": "w", "rubric_id": "r", "version": 1, "status": "DRAFT"}, rows, None)
    except (ValueError, RubricError):
        return False
    return True


@pytest.mark.parametrize("case", FIXTURE["criteria"], ids=lambda c: c["name"])
def test_rubric_validity_matches_console(case):
    assert _python_valid(case["criteria"]) is case["valid"]
