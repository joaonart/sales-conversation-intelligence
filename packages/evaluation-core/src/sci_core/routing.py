"""Session router: decides which rubric a conversation should be analysed with, before any rubric is paid for.

Why: every analysis asks every criterion of a rubric in one provider call. A support conversation analysed with a sales rubric costs a full
call and ends as NOT_EVALUABLE. The router spends one very small call (head of the conversation, one CHOICE question) to send each
session to the rubric that fits it, or to no rubric at all.

* The classification is a normal provider CHOICE question, so any `AIProvider` works and no adapter change is needed.
* The answer only selects a route. It never feeds a score. Anything unusable (insufficient evidence, answer outside the routes) goes to the
  configured fallback route, never to an arbitrary rubric.
* With a single route there is nothing to decide: no provider call, no cost.
* The conversation text is untrusted evidence; it is built by `build_conversation` (masked, delimiters neutralised) like for any analysis.
"""
from __future__ import annotations

import re
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from sci_core.context import build_conversation
from sci_core.hashing import canonical_hash
from sci_core.provider import AIProvider, AnalysisIdentity, AnswerState
from sci_core.rubric import Criterion, EvaluationType

ROUTER_PROMPT_VERSION = "router-v1"
ROUTE_CRITERION_ID = "route"
MAX_ROUTES = 12
_KEY = re.compile(r"^[a-z][a-z0-9_]{0,31}$")

QUESTION = (
    "Qual é o tipo desta conversa? Responda com exatamente uma das opções. "
    "Se não houver conteúdo suficiente para decidir, diga que não há evidência suficiente."
)


class RoutingError(ValueError):
    """Routing configuration is malformed."""


class Route(BaseModel):
    """One kind of conversation. `rubric_id = None` means "analyse with nothing": the session is skipped at no further cost."""

    model_config = ConfigDict(frozen=True)

    key: str
    description: str = Field(min_length=1, max_length=400)
    rubric_id: str | None = Field(default=None, min_length=1)
    rubric_version: int | None = Field(default=None, ge=1)  # None -> latest published at run time

    @model_validator(mode="after")
    def check(self) -> Route:
        if not _KEY.match(self.key):
            raise ValueError(f"route key {self.key!r} must match {_KEY.pattern}")
        if self.rubric_id is None and self.rubric_version is not None:
            raise ValueError(f"route {self.key}: rubric_version without rubric_id")
        return self


class RoutingConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    routes: tuple[Route, ...] = Field(min_length=1, max_length=MAX_ROUTES)
    fallback: str  # the route used when the classification is unusable

    @model_validator(mode="after")
    def check(self) -> RoutingConfig:
        keys = [r.key for r in self.routes]
        if len(set(keys)) != len(keys):
            raise ValueError("duplicate route key")
        if self.fallback not in keys:
            raise ValueError(f"fallback {self.fallback!r} is not one of the routes")
        return self

    @classmethod
    def parse(cls, raw: Any) -> RoutingConfig:
        try:
            return cls.model_validate(raw)
        except ValueError as exc:
            raise RoutingError(str(exc)) from exc

    def route(self, key: str) -> Route:
        return next(r for r in self.routes if r.key == key)

    @property
    def config_hash(self) -> str:
        """Part of the router identity: editing a route description or target invalidates earlier decisions."""
        return canonical_hash([[r.key, r.description, r.rubric_id, r.rubric_version] for r in self.routes] + [self.fallback])

    @property
    def rubric_ids(self) -> list[str]:
        return sorted({r.rubric_id for r in self.routes if r.rubric_id})


class RouteState(StrEnum):
    CLASSIFIED = "CLASSIFIED"  # the provider chose a route
    FALLBACK = "FALLBACK"  # unusable answer: the fallback route was applied
    SINGLE = "SINGLE"  # only one route configured: nothing to decide, no provider call


class RouteDecision(BaseModel):
    model_config = ConfigDict(frozen=True)

    route_key: str
    rubric_id: str | None
    rubric_version: int | None
    state: RouteState
    confidence: float | None = None  # informational only
    input_tokens: int = 0
    output_tokens: int = 0
    estimated_cost_usd: float = 0.0


def head_of_conversation(messages: list[dict[str, Any]], max_tokens: int) -> list[dict[str, Any]]:
    """The first messages that fit `max_tokens` (at least one). The opening is what tells a purchase from a support request."""
    ordered = sorted(messages, key=lambda m: (m.get("sequence_number") or 0, m["message_id"]))
    kept: list[dict[str, Any]] = []
    for m in ordered:
        if kept and build_conversation([*kept, m]).approx_tokens > max_tokens:
            break
        kept.append(m)
    return kept


class SessionRouter:
    def __init__(self, provider: AIProvider, config: RoutingConfig, *, max_input_tokens: int = 1200) -> None:
        if max_input_tokens < 100:
            raise ValueError("max_input_tokens too small to classify anything")
        self._ai, self._cfg, self._max_in = provider, config, max_input_tokens
        self._criterion = Criterion(
            criterion_id=ROUTE_CRITERION_ID, instructions=QUESTION, evaluation_type=EvaluationType.CHOICE, weight=1,
            score_mapping={r.key: 0 for r in config.routes}, level_descriptions={r.key: r.description for r in config.routes})

    @property
    def config(self) -> RoutingConfig:
        return self._cfg

    @property
    def needs_ai(self) -> bool:
        return len(self._cfg.routes) > 1

    @property
    def identity(self) -> AnalysisIdentity:
        """Model + prompt + route definitions: a decision made under another identity is a different logical result."""
        return AnalysisIdentity(model=self._ai.model,
                                prompt_version=f"{self._ai.prompt_version}|{ROUTER_PROMPT_VERSION}|{self._cfg.config_hash[:12]}")

    @property
    def overhead_tokens(self) -> int:
        """Question + route descriptions sent with every classification (rough, for estimates only)."""
        return max(1, (len(QUESTION) + sum(len(r.description) + len(r.key) + 8 for r in self._cfg.routes)) // 4) + 40

    def estimate_input_tokens(self, messages: list[dict[str, Any]]) -> int:
        if not self.needs_ai:
            return 0
        return build_conversation(head_of_conversation(messages, self._max_in)).approx_tokens + self.overhead_tokens

    def _decision(self, key: str, state: RouteState, **extra: Any) -> RouteDecision:
        r = self._cfg.route(key)
        return RouteDecision(route_key=key, rubric_id=r.rubric_id, rubric_version=r.rubric_version, state=state, **extra)

    async def classify(self, messages: list[dict[str, Any]]) -> RouteDecision:
        if not self.needs_ai:
            return self._decision(self._cfg.routes[0].key, RouteState.SINGLE)
        text = build_conversation(head_of_conversation(messages, self._max_in)).text
        resp = await self._ai.evaluate(text, [self._criterion])
        usage = {"input_tokens": resp.usage.input_tokens, "output_tokens": resp.usage.output_tokens,
                 "estimated_cost_usd": resp.usage.estimated_cost_usd}
        answers = [a for a in resp.answers if a.criterion_id == ROUTE_CRITERION_ID]
        answer = answers[0] if len(answers) == 1 else None
        chosen = answer.answer if answer and answer.state == AnswerState.ANSWERED else None
        if isinstance(chosen, str) and chosen in self._criterion.score_mapping:
            return self._decision(chosen, RouteState.CLASSIFIED, confidence=answer.confidence if answer else None, **usage)
        return self._decision(self._cfg.fallback, RouteState.FALLBACK, **usage)
