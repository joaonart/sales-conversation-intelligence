from decimal import Decimal

import pytest
from pydantic import ValidationError

from sci_core.loader import RubricLoader
from sci_core.rubric import Criterion, Rubric, RubricError, RubricStatus


def crit(**kw):
    base = dict(criterion_id="a", instructions="x", evaluation_type="SCORE", weight=1, score_mapping={"lo": 0, "hi": 100})
    return {**base, **kw}


def rubric(**kw):
    base = dict(organization_id="o", workspace_id="w", rubric_id="r", version=1, status="PUBLISHED",
                criteria=[crit()])
    return Rubric(**{**base, **kw})


def test_fixture_loads(rubric_json):
    r = Rubric.model_validate(rubric_json)
    assert [c.criterion_id for c in r.active_criteria] == ["greeting", "needs"]


def test_from_bigquery_rows():
    r = Rubric.from_rows(
        {"organization_id": "o", "workspace_id": "w", "rubric_id": "r", "version": 2, "status": "PUBLISHED"},
        [{"criterion_id": "a", "evaluation_instructions": "q", "evaluation_type": "PREDICATE",
          "weight": Decimal("10.5"), "required": True, "enabled": True, "score_mapping": '{"true":100,"false":0}',
          "display_order": 1}],
        {"minimum_approval_score": Decimal("70"), "missing_evidence_policy": "EXCLUDE_OPTIONAL"},
    )
    assert r.criteria[0].weight == 10.5 and r.policy.minimum_approval_score == 70


def test_mapping_must_match_declared_choices():
    with pytest.raises(RubricError):
        Rubric.from_rows({"organization_id": "o", "workspace_id": "w", "rubric_id": "r", "version": 1, "status": "PUBLISHED"},
                         [{"criterion_id": "a", "evaluation_instructions": "q", "evaluation_type": "CHOICE", "weight": 1,
                           "score_mapping": {"x": 1}, "choices": ["x", "y"]}])


def test_predicate_mapping_keys():
    with pytest.raises(ValidationError):
        Criterion(**crit(evaluation_type="PREDICATE", score_mapping={"yes": 100, "no": 0}))


def test_mapped_score_range():
    with pytest.raises(ValidationError):
        Criterion(**crit(score_mapping={"x": 101}))


def test_duplicate_ids_and_no_active():
    with pytest.raises(ValidationError):
        rubric(criteria=[crit(), crit()])
    with pytest.raises(ValidationError):
        rubric(criteria=[crit(enabled=False)])


def test_required_zero_weight_rejected():
    with pytest.raises(ValidationError):
        Criterion(**crit(required=True, weight=0))


def test_disabled_excluded_and_snapshot_stable():
    r = rubric(criteria=[crit(), crit(criterion_id="b", enabled=False)])
    assert [c.criterion_id for c in r.active_criteria] == ["a"]
    assert r.snapshot_hash == rubric(criteria=[crit(), crit(criterion_id="b", enabled=False)]).snapshot_hash
    assert r.snapshot_hash != rubric(criteria=[crit(weight=2)]).snapshot_hash


def test_map_answer_unknown_raises():
    with pytest.raises(RubricError):
        Criterion(**crit()).map_answer("mid")


class Repo:
    def __init__(self, rubric):
        self.rubric, self.calls = rubric, 0

    async def fetch(self, o, w, r, v):
        self.calls += 1
        return self.rubric


async def test_loader_caches_pinned_forever():
    repo = Repo(rubric())
    loader = RubricLoader(repo)
    await loader.load("o", "w", "r", 1)
    await loader.load("o", "w", "r", 1)
    assert repo.calls == 1


async def test_loader_latest_ttl():
    now = [0.0]
    repo = Repo(rubric())
    loader = RubricLoader(repo, latest_ttl_seconds=60, clock=lambda: now[0])
    await loader.load("o", "w", "r")
    now[0] = 30
    await loader.load("o", "w", "r")
    assert repo.calls == 1
    now[0] = 90
    await loader.load("o", "w", "r")
    assert repo.calls == 2


async def test_loader_rejects_unpublished_and_cross_tenant():
    with pytest.raises(RubricError):
        await RubricLoader(Repo(rubric(status=RubricStatus.DRAFT))).load("o", "w", "r", 1)
    with pytest.raises(RubricError):
        await RubricLoader(Repo(rubric(organization_id="other"))).load("o", "w", "r", 1)
    with pytest.raises(RubricError):
        await RubricLoader(Repo(None)).load("o", "w", "r", 1)
