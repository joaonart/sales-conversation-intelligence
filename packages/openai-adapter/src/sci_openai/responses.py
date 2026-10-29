"""Standard LLM provider: scores through the Responses API (POST /v1/responses) with Structured Outputs.

Alternative to DecisionsProvider behind the same sci_core.provider.AIProvider contract. Differences that matter:
* Any Responses-capable model can be used, so `model` and its prices are mandatory configuration (never defaulted).
* The model answers every criterion in one strict-schema call and cites supporting message ids in the same call,
  so no separate evidence step is needed. Cited ids are untrusted: ids that are not in the conversation are dropped.
* Business scores still come only from the rubric mapping. `confidence` is informational and never feeds the score.
* Anything unusable (refusal, unknown value, out-of-vocabulary answer) becomes INSUFFICIENT_EVIDENCE, never zero.
"""
from __future__ import annotations

import json
import re
from typing import Any

from sci_core.provider import AnswerState, ProviderAnswer, ProviderResponse, ProviderUsage
from sci_core.rubric import Criterion, EvaluationType
from sci_openai.decisions import GUARD, ordered_levels
from sci_openai.errors import InvalidProviderResponse, ProviderError
from sci_openai.http import OpenAIHttp
from sci_openai.pricing import DecisionsUsage, TokenPrices

PROMPT_VERSION = "responses-v1"
_ID = re.compile(r"id=(\S+)")
_TRUE, _FALSE = "true", "false"


def response_schema(criterion_ids: list[str]) -> dict[str, Any]:
    """Strict Structured Outputs schema: every property required, additionalProperties false."""
    item = {
        "type": "object", "additionalProperties": False,
        "required": ["criterion_id", "answer", "insufficient_evidence", "confidence", "evidence_message_ids"],
        "properties": {
            "criterion_id": {"type": "string", "enum": criterion_ids},
            "answer": {"type": "string", "description": "One of the allowed answers; empty string when evidence is insufficient."},
            "insufficient_evidence": {"type": "boolean"},
            "confidence": {"type": "number", "description": "0 to 1, informational only."},
            "evidence_message_ids": {"type": "array", "items": {"type": "string"}},
        },
    }
    return {"type": "object", "additionalProperties": False, "required": ["answers"],
            "properties": {"answers": {"type": "array", "items": item}}}


def allowed_answers(c: Criterion) -> list[str]:
    if c.evaluation_type == EvaluationType.PREDICATE:
        return [_TRUE, _FALSE]
    if c.evaluation_type == EvaluationType.CHOICE:
        return sorted(c.score_mapping)
    return ordered_levels(c)  # lowest -> highest


def describe_criterion(c: Criterion) -> str:
    kind = c.evaluation_type.value.lower()
    lines = [f"- id={c.criterion_id} ({kind}): {c.instructions}"]
    for a in allowed_answers(c):
        d = c.level_descriptions.get(a)
        lines.append(f'    allowed answer "{a}"' + (f": {d}" if d else ""))
    return "\n".join(lines)


def build_request(model: str, conversation_text: str, criteria: list[Criterion], *, max_output_tokens: int,
                  safety_id: str | None = None) -> dict[str, Any]:
    if not criteria:
        raise ValueError("at least one criterion is required")
    ids = [c.criterion_id for c in criteria]
    rules = (
        f"{GUARD}\n\nAnswer every criterion below exactly once. For each, `answer` must be one of its allowed answers. "
        "If the conversation does not contain enough evidence, set insufficient_evidence=true and answer \"\". "
        "`evidence_message_ids` lists ids (the `id=` value of a message block) that support the answer; use only ids "
        "present in the conversation.\n\nCriteria:\n" + "\n".join(describe_criterion(c) for c in criteria)
    )
    body: dict[str, Any] = {
        "model": model, "store": False, "max_output_tokens": max_output_tokens,
        "input": [{"role": "developer", "content": rules}, {"role": "user", "content": conversation_text}],
        "text": {"format": {"type": "json_schema", "name": "evaluation", "strict": True, "schema": response_schema(ids)}},
    }
    if safety_id:
        body["safety_identifier"] = safety_id
    return body


class ResponsesProvider:
    """Implements sci_core.provider.AIProvider."""

    def __init__(self, http: OpenAIHttp, *, model: str, prices: TokenPrices, tenant_safety_id: str | None = None,
                 max_input_tokens: int = 200_000, max_output_tokens: int | None = None) -> None:
        if not model.strip():
            raise ValueError("model is required")
        self._http, self._prices, self._safety = http, prices, tenant_safety_id
        self._max_in, self._max_out = max_input_tokens, max_output_tokens
        self.model = model
        # Anything that can change a score is part of the version -> distinct analysis_id from the Decisions provider.
        self.prompt_version = PROMPT_VERSION

    async def evaluate(self, conversation_text: str, criteria: list[Criterion]) -> ProviderResponse:
        if max(1, len(conversation_text) // 4) > self._max_in:
            raise ProviderError("conversation exceeds adapter max_input_tokens; refusing to send")
        budget = self._max_out or max(800, 200 * len(criteria))
        body = build_request(self.model, conversation_text, criteria, max_output_tokens=budget, safety_id=self._safety)
        data = await self._http.post("/responses", body)
        answers = self.parse_answers(data, {c.criterion_id: c for c in criteria}, set(_ID.findall(conversation_text)))
        u = _usage(data)
        return ProviderResponse(answers=answers, usage=ProviderUsage(
            input_tokens=u.input_tokens, output_tokens=u.output_tokens, estimated_cost_usd=round(self._prices.cost(u), 8)))

    def parse_answers(self, data: dict[str, Any], expected: dict[str, Criterion], message_ids: set[str]) -> list[ProviderAnswer]:
        if data.get("status") == "incomplete":
            raise InvalidProviderResponse("response incomplete (output budget exhausted)")  # fail closed, never score a partial
        raw = _output_json(data)
        if raw is None:  # refusal: nothing is scoreable, nothing is zero
            return [ProviderAnswer(criterion_id=cid, state=AnswerState.INSUFFICIENT_EVIDENCE) for cid in expected]
        items = raw.get("answers") if isinstance(raw, dict) else None
        if not isinstance(items, list):
            raise InvalidProviderResponse("missing answers array")
        out: list[ProviderAnswer] = []
        seen: set[str] = set()
        for it in items:
            cid = it.get("criterion_id") if isinstance(it, dict) else None
            if cid not in expected or cid in seen:
                raise InvalidProviderResponse("answer criterion_id does not match a requested criterion")
            seen.add(cid)
            out.append(self._map(expected[cid], it, message_ids))
        return out  # criteria without an answer are treated as insufficient evidence by the engine

    @staticmethod
    def _map(c: Criterion, it: dict[str, Any], message_ids: set[str]) -> ProviderAnswer:
        insufficient = ProviderAnswer(criterion_id=c.criterion_id, state=AnswerState.INSUFFICIENT_EVIDENCE)
        raw = it.get("answer")
        if it.get("insufficient_evidence") is not False or not isinstance(raw, str):
            return insufficient
        value = raw.strip()
        conf = it.get("confidence")
        confidence = float(conf) if isinstance(conf, (int, float)) and not isinstance(conf, bool) and 0 <= conf <= 1 else None
        ev = it.get("evidence_message_ids")
        evidence = [m for m in ev if isinstance(m, str) and m in message_ids] if isinstance(ev, list) else []
        answer: str | bool
        if c.evaluation_type == EvaluationType.PREDICATE:
            if value.lower() not in (_TRUE, _FALSE):
                return insufficient
            answer = value.lower() == _TRUE
        else:
            if value not in allowed_answers(c):
                return insufficient
            answer = value
        return ProviderAnswer(criterion_id=c.criterion_id, answer=answer, confidence=confidence, evidence_message_ids=evidence)


def _output_json(data: dict[str, Any]) -> Any:
    """Parsed output_text JSON, or None on refusal."""
    for item in data.get("output") or []:
        for part in item.get("content") or []:
            if part.get("type") == "refusal":
                return None
            if part.get("type") == "output_text":
                try:
                    return json.loads(part["text"])
                except (ValueError, KeyError, TypeError) as exc:
                    raise InvalidProviderResponse("output is not valid JSON") from exc
    raise InvalidProviderResponse("no output_text in response")


def _usage(data: dict[str, Any]) -> DecisionsUsage:
    u = data.get("usage")
    if not isinstance(u, dict):
        raise InvalidProviderResponse("missing usage")  # cost must be knowable; otherwise the budget gate is blind
    d = u.get("input_tokens_details") or {}
    return DecisionsUsage(int(u.get("input_tokens", 0)), int(d.get("cached_tokens", 0)), 0, int(u.get("output_tokens", 0)))
