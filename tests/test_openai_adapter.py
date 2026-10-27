import json

import httpx
import pytest

from sci_core.engine import EvaluationEngine
from sci_core.provider import AnswerState
from sci_core.rubric import Criterion, Rubric
from sci_openai.decisions import DecisionsProvider, build_request, ordered_levels, safety_identifier
from sci_openai.errors import CircuitOpen, InvalidProviderResponse, ProviderRequestError, QuotaExceeded, TransientProviderError
from sci_openai.evidence import ResponsesEvidenceExtractor, evidence_schema
from sci_openai.http import CircuitBreaker, OpenAIHttp, RetryPolicy
from sci_openai.pricing import LUNA_STANDARD_SHORT, DecisionsUsage, TokenPrices

PRED = Criterion(criterion_id="greeting", instructions="greeted?", evaluation_type="PREDICATE", weight=10,
                 score_mapping={"true": 100, "false": 0})
SCORE = Criterion(criterion_id="needs", instructions="needs?", evaluation_type="SCORE", weight=25,
                  score_mapping={"none": 0, "partial": 50, "complete": 100})
CHOICE = Criterion(criterion_id="tone", instructions="tone?", evaluation_type="CHOICE", weight=5,
                   score_mapping={"warm": 100, "cold": 0})
TEXT = "<<<MESSAGE id=m1 role=customer\nOlá\nMESSAGE>>>\n<<<MESSAGE id=m2 role=seller\nOi!\nMESSAGE>>>"
USAGE = {"input_tokens": 1000, "input_tokens_details": {"cached_tokens": 200, "cache_write_tokens": 100},
         "output_tokens": 30, "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 1030}


def decision(*answers, usage=USAGE):
    return {"model": "gpt-6-luna", "answers": list(answers), "usage": usage}


def make_http(handler, **kw):
    sleeps, now = [], [0.0]

    async def sleep(s):
        sleeps.append(s)
        now[0] += s  # sleeping advances the fake clock

    http = OpenAIHttp(lambda: "sk-test", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
                      sleep=sleep, rng=lambda: 0.0, clock=lambda: now[0], **kw)
    return http, sleeps


# ---------- request building ----------
def test_request_shape_matches_documented_contract():
    body = build_request(TEXT, [PRED, SCORE, CHOICE], safety_id="t-1")
    assert body["model"] == "gpt-6-luna" and body["safety_identifier"] == "t-1"
    assert body["input"][0]["role"] == "developer" and body["input"][1] == {"role": "user", "content": TEXT}
    q = {x["name"]: x for x in body["questions"]}
    assert q["greeting"]["type"] == "predicate" and "choices" not in q["greeting"]
    assert q["tone"]["choices"] == [{"value": "cold"}, {"value": "warm"}]
    assert q["needs"]["levels"] == [{"label": "none"}, {"label": "partial"}, {"label": "complete"}]  # lowest -> highest


def test_levels_ordered_by_mapped_value_not_dict_order():
    shuffled = Criterion(criterion_id="x", instructions="i", evaluation_type="SCORE", weight=1,
                         score_mapping={"complete": 100, "none": 0, "partial": 50})
    assert ordered_levels(shuffled) == ["none", "partial", "complete"]


def test_question_count_bounds_and_safety_id_is_opaque():
    with pytest.raises(ValueError):
        build_request(TEXT, [])
    assert "org" not in safety_identifier("org", "ws") and safety_identifier("org", "ws") == safety_identifier("org", "ws")
    assert safety_identifier("org", "ws") != safety_identifier("org", "ws2")


# ---------- response mapping ----------
def provider(http, **kw):
    return DecisionsProvider(http, LUNA_STANDARD_SHORT, **kw)


async def run(answers, criteria=(PRED, SCORE, CHOICE), usage=USAGE, **kw):
    def handler(req):
        return httpx.Response(200, json=decision(*answers, usage=usage))
    http, _ = make_http(handler)
    return await provider(http, **kw).evaluate(TEXT, list(criteria))


def probs(n, base=0):
    return [{"value": i + base, "label": str(i), "probability": 1 / n} for i in range(n)]


async def test_maps_all_types_deterministically():
    r = await run([
        {"type": "predicate", "name": "greeting", "probability": 0.93},
        {"type": "score", "name": "needs", "score": 1.4, "confidence": 0.2, "probabilities": probs(3)},
        {"type": "choice", "name": "tone", "choice": "warm", "confidence": 0.9, "probabilities": []},
    ])
    got = {a.criterion_id: a for a in r.answers}
    assert got["greeting"].answer is True and got["needs"].answer == "partial" and got["tone"].answer == "warm"
    assert all(a.evidence_message_ids == [] for a in r.answers)  # Decisions returns no citations


async def test_predicate_threshold_boundary_and_abstain_band():
    r = await run([{"type": "predicate", "name": "greeting", "probability": 0.5}], [PRED])
    assert r.answers[0].answer is True  # >= threshold
    r = await run([{"type": "predicate", "name": "greeting", "probability": 0.49}], [PRED])
    assert r.answers[0].answer is False
    r = await run([{"type": "predicate", "name": "greeting", "probability": 0.55}], [PRED], min_decision_margin=0.1)
    assert r.answers[0].state == AnswerState.INSUFFICIENT_EVIDENCE


@pytest.mark.parametrize("base,score,expected", [(0, 0.49, "none"), (0, 0.5, "partial"), (0, 2.4, "complete"), (1, 1.2, "none"), (1, 2.6, "complete")])
async def test_score_rounding_handles_zero_and_one_based_indices(base, score, expected):
    r = await run([{"type": "score", "name": "needs", "score": score, "confidence": 1, "probabilities": probs(3, base)}], [SCORE])
    assert r.answers[0].answer == expected


async def test_ambiguous_or_out_of_range_score_abstains_instead_of_guessing():
    for a in ({"type": "score", "name": "needs", "score": 1.0, "probabilities": [{"value": 5, "probability": 1}]},
              {"type": "score", "name": "needs", "score": 9.0, "probabilities": probs(3)},
              {"type": "score", "name": "needs", "probabilities": probs(3)}):
        r = await run([a], [SCORE])
        assert r.answers[0].state == AnswerState.INSUFFICIENT_EVIDENCE


async def test_refusal_is_insufficient_not_zero_and_others_still_answer():
    r = await run([{"type": "refusal", "name": "greeting"}, {"type": "choice", "name": "tone", "choice": "warm", "confidence": 0.9}], [PRED, CHOICE])
    assert r.answers[1].answer == "warm"
    assert r.answers[0].state == AnswerState.INSUFFICIENT_EVIDENCE


async def test_invalid_responses_rejected():
    for bad in ([{"type": "predicate", "name": "unknown", "probability": 0.9}],
                [{"type": "predicate", "name": "greeting", "probability": 1.7}],
                [{"type": "choice", "name": "greeting", "choice": "x"}],
                [{"type": "predicate", "name": "greeting", "probability": 0.9}, {"type": "predicate", "name": "greeting", "probability": 0.9}]):
        with pytest.raises(InvalidProviderResponse):
            await run(bad, [PRED])
    with pytest.raises(InvalidProviderResponse):
        await run([{"type": "predicate", "name": "greeting", "probability": 0.9}], [PRED], usage=None)  # cost must be knowable


async def test_cost_from_usage_and_chunking(monkeypatch):
    r = await run([{"type": "predicate", "name": "greeting", "probability": 0.9}], [PRED])
    # 700 uncached*0.10 + 200 cached*0.01 + 100 write*0.125 + 30 out*0.50 (per 1M)
    assert r.usage.estimated_cost_usd == pytest.approx((70 + 2 + 12.5 + 15) / 1e6, rel=1e-6)
    assert (r.usage.input_tokens, r.usage.output_tokens) == (1000, 30)
    many = [Criterion(criterion_id=f"c{i}", instructions="i", evaluation_type="PREDICATE", weight=1, score_mapping={"true": 100, "false": 0})
            for i in range(401)]
    calls = []

    def handler(req):
        qs = json.loads(req.content)["questions"]
        calls.append(len(qs))
        return httpx.Response(200, json=decision(*[{"type": "predicate", "name": q["name"], "probability": 0.9} for q in qs]))
    http, _ = make_http(handler)
    resp = await provider(http).evaluate(TEXT, many)
    assert calls == [400, 1] and len(resp.answers) == 401 and resp.usage.input_tokens == 2000


def test_price_book_is_worst_case_and_residency_uplift():
    p = TokenPrices(0.10, 0.01, 0.125, 0.50, multiplier=1.1)
    assert p.worst_case_price_book().input_per_million == pytest.approx(0.1375)
    assert p.cost(DecisionsUsage(input_tokens=1_000_000)) == pytest.approx(0.11)


async def test_oversized_conversation_never_sent():
    called = []
    http, _ = make_http(lambda r: called.append(1) or httpx.Response(200, json=decision()))
    with pytest.raises(Exception, match="max_input_tokens"):
        await provider(http, max_input_tokens=10).evaluate("x" * 1000, [PRED])
    assert not called
    with pytest.raises(ValueError):
        provider(http, max_input_tokens=300_000)


async def test_prompt_version_changes_with_config():
    http, _ = make_http(lambda r: httpx.Response(200))
    assert provider(http).prompt_version != provider(http, predicate_threshold=0.6).prompt_version


async def test_end_to_end_with_engine_matches_manual_score(rubric_json):
    answers = [{"type": "predicate", "name": "greeting", "probability": 0.9},
               {"type": "score", "name": "needs", "score": 2.0, "confidence": 0.4, "probabilities": probs(3)}]
    http, _ = make_http(lambda r: httpx.Response(200, json=decision(*answers)))
    engine = EvaluationEngine(provider(http), mode="live")
    msgs = [{"message_id": "m1", "sequence_number": 1, "sender_type": "customer", "content": "Olá"}]
    ev = await engine.evaluate(organization_id="demo", workspace_id="default", session_id="s", messages=msgs,
                               rubric=Rubric.model_validate(rubric_json))
    assert ev.score.overall_score == 100 and ev.model == "gpt-6-luna" and ev.estimated_cost_usd > 0


# ---------- HTTP resilience ----------
async def test_retries_429_honouring_retry_after_then_succeeds():
    n = {"i": 0}

    def handler(req):
        n["i"] += 1
        return httpx.Response(429, headers={"Retry-After": "7"}, json={"error": {"code": "rate_limit_exceeded"}}) if n["i"] < 3 \
            else httpx.Response(200, json={"ok": True})
    http, sleeps = make_http(handler)
    assert await http.post("/x", {}) == {"ok": True}
    assert len(sleeps) == 2 and all(s >= 7 for s in sleeps)


async def test_exponential_backoff_without_retry_after_and_cap():
    http, sleeps = make_http(lambda r: httpx.Response(503, json={}), retry=RetryPolicy(max_attempts=4, base_delay=1, max_delay=3))
    with pytest.raises(TransientProviderError):
        await http.post("/x", {})
    assert sleeps == [1, 2, 3]


async def test_total_timeout_caps_retry_time():
    http, sleeps = make_http(lambda r: httpx.Response(503, json={}), retry=RetryPolicy(max_attempts=10, base_delay=40, max_delay=40, total_timeout=60))
    with pytest.raises(TransientProviderError):
        await http.post("/x", {})
    assert sleeps == [40]


@pytest.mark.parametrize("status,code,exc", [(429, "insufficient_quota", QuotaExceeded), (400, "invalid_request_error", ProviderRequestError),
                                              (401, "invalid_api_key", ProviderRequestError), (403, None, ProviderRequestError)])
async def test_non_retryable_errors_fail_fast(status, code, exc):
    calls = []
    http, sleeps = make_http(lambda r: calls.append(1) or httpx.Response(status, json={"error": {"code": code}}))
    with pytest.raises(exc):
        await http.post("/x", {})
    assert len(calls) == 1 and not sleeps


async def test_timeouts_are_retried():
    n = {"i": 0}

    def handler(req):
        n["i"] += 1
        if n["i"] == 1:
            raise httpx.ReadTimeout("slow")
        return httpx.Response(200, json={"ok": 1})
    http, _ = make_http(handler)
    assert await http.post("/x", {}) == {"ok": 1}


async def test_circuit_breaker_opens_then_recovers():
    now = [0.0]
    ok = {"v": False}
    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(200, json={"ok": 1}) if ok["v"] else httpx.Response(500, json={})
    http, _ = make_http(handler, retry=RetryPolicy(max_attempts=1), breaker=CircuitBreaker(2, 30, clock=lambda: now[0]))
    for _ in range(2):
        with pytest.raises(TransientProviderError):
            await http.post("/x", {})
    with pytest.raises(CircuitOpen):
        await http.post("/x", {})
    assert len(calls) == 2  # open circuit makes no call
    now[0], ok["v"] = 31, True
    assert await http.post("/x", {}) == {"ok": 1}


async def test_api_key_header_and_no_secret_in_errors():
    seen = {}

    def handler(req):
        seen["auth"] = req.headers["authorization"]
        return httpx.Response(400, json={"error": {"code": "bad", "message": "echo: Olá segredo-do-cliente"}})
    http, _ = make_http(handler)
    with pytest.raises(ProviderRequestError) as e:
        await http.post("/x", {"input": "segredo-do-cliente"})
    assert seen["auth"] == "Bearer sk-test" and "segredo" not in str(e.value) and "sk-test" not in str(e.value)


# ---------- evidence (Responses API) ----------
def responses_payload(text, **extra):
    return {"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}],
            "usage": {"input_tokens": 500, "output_tokens": 40}, **extra}


async def test_evidence_extraction_filters_invented_ids_and_adds_cost():
    bodies = []

    def handler(req):
        bodies.append((req.url.path, json.loads(req.content)))
        if req.url.path.endswith("/decisions"):
            return httpx.Response(200, json=decision({"type": "predicate", "name": "greeting", "probability": 0.9}))
        return httpx.Response(200, json=responses_payload(json.dumps({"evidence": [{"criterion_id": "greeting", "message_ids": ["m2", "ghost"]}]})))
    http, _ = make_http(handler)
    ext = ResponsesEvidenceExtractor(http, model="small-model", input_price_per_million=0.05, output_price_per_million=0.4)
    r = await provider(http, evidence=ext).evaluate(TEXT, [PRED])
    assert r.answers[0].evidence_message_ids == ["m2"]  # "ghost" is not in the conversation
    path, body = bodies[1]
    assert path.endswith("/responses") and body["store"] is False and body["text"]["format"]["strict"] is True
    assert body["text"]["format"]["schema"]["additionalProperties"] is False
    base = LUNA_STANDARD_SHORT.cost(DecisionsUsage(1000, 200, 100, 30))
    assert r.usage.estimated_cost_usd == pytest.approx(base + (500 * 0.05 + 40 * 0.4) / 1e6, rel=1e-6)
    assert "evidence=" in provider(http, evidence=ext).prompt_version


async def test_evidence_failure_modes():
    def make(payload):
        http, _ = make_http(lambda r: httpx.Response(200, json=payload))
        return ResponsesEvidenceExtractor(http, model="m", input_price_per_million=0, output_price_per_million=0)
    from sci_core.provider import ProviderAnswer
    ans = [ProviderAnswer(criterion_id="greeting", answer=True)]
    out, _ = await make({"status": "completed", "output": [{"content": [{"type": "refusal", "refusal": "no"}]}]}).attach(TEXT, [PRED], ans)
    assert out[0].evidence_message_ids == []
    with pytest.raises(InvalidProviderResponse):
        await make({"status": "incomplete", "output": []}).attach(TEXT, [PRED], ans)
    with pytest.raises(InvalidProviderResponse):
        await make(responses_payload("not json")).attach(TEXT, [PRED], ans)
    unanswered = [ProviderAnswer(criterion_id="greeting", state=AnswerState.NOT_APPLICABLE)]
    out, usage = await make({}).attach(TEXT, [PRED], unanswered)  # nothing to cite -> no call
    assert out == unanswered and usage.cost_usd == 0


def test_evidence_schema_is_strict_compatible():
    s = evidence_schema(["a", "b"])
    assert s["required"] == ["evidence"] and s["properties"]["evidence"]["items"]["additionalProperties"] is False
