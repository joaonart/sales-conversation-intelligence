import json

import httpx
import pytest

from sci_core.provider import AnswerState
from sci_core.rubric import Criterion
from sci_openai.errors import InvalidProviderResponse, ProviderError
from sci_openai.http import OpenAIHttp
from sci_openai.pricing import TokenPrices
from sci_openai.responses import ResponsesProvider, build_request, response_schema

PRED = Criterion(criterion_id="greeting", instructions="Greeted?", evaluation_type="PREDICATE", weight=1,
                 score_mapping={"true": 100, "false": 0})
CHOICE = Criterion(criterion_id="tone", instructions="Tone?", evaluation_type="CHOICE", weight=1,
                   score_mapping={"warm": 100, "cold": 0})
SCORE = Criterion(criterion_id="needs", instructions="Needs?", evaluation_type="SCORE", weight=1,
                  score_mapping={"none": 0, "partial": 50, "complete": 100})
TEXT = "<<<MESSAGE id=m1 role=customer\nOlá\nMESSAGE>>>\n<<<MESSAGE id=m2 role=seller\nOi!\nMESSAGE>>>"
PRICES = TokenPrices(input=1.0, cached_input=0.1, cache_write=1.0, output=4.0)
USAGE = {"input_tokens": 1000, "input_tokens_details": {"cached_tokens": 200}, "output_tokens": 100}


def item(cid, answer="", insufficient=False, confidence=0.9, ev=()):
    return {"criterion_id": cid, "answer": answer, "insufficient_evidence": insufficient,
            "confidence": confidence, "evidence_message_ids": list(ev)}


def reply(*items, usage=USAGE, status="completed"):
    text = json.dumps({"answers": list(items)})
    return {"status": status, "output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}], "usage": usage}


def provider(handler, **kw):
    http = OpenAIHttp(lambda: "sk-test", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    return ResponsesProvider(http, model="some-model", prices=PRICES, **kw)


async def run(data, criteria=(PRED, CHOICE, SCORE), **kw):
    return await provider(lambda req: httpx.Response(200, json=data), **kw).evaluate(TEXT, list(criteria))


def test_request_is_strict_schema_with_untrusted_conversation_isolated():
    body = build_request("some-model", TEXT, [PRED, CHOICE, SCORE], max_output_tokens=800, safety_id="t-1")
    assert body["model"] == "some-model" and body["store"] is False and body["safety_identifier"] == "t-1"
    fmt = body["text"]["format"]
    assert fmt["strict"] is True and fmt["schema"] == response_schema(["greeting", "tone", "needs"])
    dev, user = body["input"]
    assert dev["role"] == "developer" and user == {"role": "user", "content": TEXT}
    assert TEXT not in dev["content"] and "warm" in dev["content"] and '"partial"' in dev["content"]
    assert dev["content"].index('"none"') < dev["content"].index('"partial"') < dev["content"].index('"complete"')


def test_schema_is_strict_compatible():
    s = response_schema(["a"])
    item_schema = s["properties"]["answers"]["items"]
    assert s["additionalProperties"] is False and item_schema["additionalProperties"] is False
    assert set(item_schema["required"]) == set(item_schema["properties"])


async def test_maps_answers_cost_and_validates_evidence_ids():
    r = await run(reply(item("greeting", "TRUE", ev=["m1", "forged"]), item("tone", "cold"), item("needs", "partial")))
    a = {x.criterion_id: x for x in r.answers}
    assert a["greeting"].answer is True and a["greeting"].evidence_message_ids == ["m1"]  # forged id dropped
    assert a["tone"].answer == "cold" and a["needs"].answer == "partial"
    # (800 uncached*1.0 + 200 cached*0.1 + 100 out*4.0) / 1e6
    assert r.usage.estimated_cost_usd == pytest.approx(0.00122) and (r.usage.input_tokens, r.usage.output_tokens) == (1000, 100)


async def test_unusable_answers_are_insufficient_never_zero():
    r = await run(reply(item("greeting", "maybe"), item("tone", "lukewarm"), item("needs", "", insufficient=True)))
    assert [x.state for x in r.answers] == [AnswerState.INSUFFICIENT_EVIDENCE] * 3
    assert all(x.answer is None for x in r.answers)


async def test_refusal_makes_everything_insufficient():
    data = {"status": "completed", "usage": USAGE, "output": [{"content": [{"type": "refusal", "refusal": "no"}]}]}
    r = await run(data)
    assert len(r.answers) == 3 and all(x.state == AnswerState.INSUFFICIENT_EVIDENCE for x in r.answers)


async def test_out_of_range_confidence_is_dropped_not_trusted():
    r = await run(reply(item("greeting", "true", confidence=7)), criteria=[PRED])
    assert r.answers[0].confidence is None and r.answers[0].answer is True


@pytest.mark.parametrize("data", [
    reply(item("greeting", "true"), item("greeting", "true")),  # duplicate
    reply(item("nope", "true")),  # unknown criterion
    reply(item("greeting", "true"), status="incomplete"),  # partial output must never be scored
    {"status": "completed", "output": [], "usage": USAGE},  # no output_text
    {"status": "completed", "output": [{"content": [{"type": "output_text", "text": "not json"}]}], "usage": USAGE},
    {k: v for k, v in reply(item("greeting", "true")).items() if k != "usage"},  # blind budget
])
async def test_malformed_responses_fail_closed(data):
    with pytest.raises(InvalidProviderResponse):
        await run(data, criteria=[PRED])


async def test_oversized_conversation_is_refused_before_any_request():
    def boom(req):
        raise AssertionError("must not call the API")

    with pytest.raises(ProviderError):
        await provider(boom, max_input_tokens=10).evaluate("x" * 1000, [PRED])


def test_identity_differs_from_decisions_and_requires_model():
    from sci_openai.decisions import DecisionsProvider
    from sci_openai.pricing import LUNA_STANDARD_SHORT

    http = OpenAIHttp(lambda: "k")
    p, d = ResponsesProvider(http, model="m", prices=PRICES), DecisionsProvider(http, LUNA_STANDARD_SHORT)
    assert (p.model, p.prompt_version) != (d.model, d.prompt_version)
    with pytest.raises(ValueError):
        ResponsesProvider(http, model=" ", prices=PRICES)
