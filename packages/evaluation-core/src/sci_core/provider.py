"""Provider-neutral AI contract. Concrete adapters (OpenAI) live in packages/openai-adapter."""
from __future__ import annotations

from enum import StrEnum
from typing import Protocol

from pydantic import BaseModel, Field

from sci_core.rubric import Criterion


class AnswerState(StrEnum):
    ANSWERED = "ANSWERED"
    NOT_APPLICABLE = "NOT_APPLICABLE"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


class ProviderAnswer(BaseModel):
    criterion_id: str
    state: AnswerState = AnswerState.ANSWERED
    answer: str | bool | None = None
    # Informational only; never feeds the score.
    confidence: float | None = Field(default=None, ge=0, le=1)
    evidence_message_ids: list[str] = Field(default_factory=list)


class ProviderUsage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    estimated_cost_usd: float = 0.0


class ProviderResponse(BaseModel):
    answers: list[ProviderAnswer]
    usage: ProviderUsage = ProviderUsage()


class AnalysisIdentity(BaseModel, frozen=True):
    """What produced an analysis: the same content analysed by another model or prompt version is a different logical result."""

    model: str = Field(min_length=1)
    prompt_version: str = Field(min_length=1)


class AIProvider(Protocol):
    model: str
    prompt_version: str

    async def evaluate(self, conversation_text: str, criteria: list[Criterion]) -> ProviderResponse: ...
