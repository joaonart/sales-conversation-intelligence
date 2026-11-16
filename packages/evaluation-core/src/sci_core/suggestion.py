"""Suggestions for the prompt of an agent, written from NUMBERS about analyses that already exist (never from conversation text).

Like the general evaluation it is a nicety on top of work that was already done: nothing it writes can reach a score, and a call that
fails, is refused or cannot be used comes back as `SuggestionResult.error` (a type, never text) together with what the call cost, so a
charge is never lost. The numbers it is given are the aggregate the person saw and approved the cost on (console, "Melhorar prompt").
"""
from __future__ import annotations

from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field

from sci_core.provider import ProviderUsage

# What a call may be given and may write. The console reads the same numbers (scripts/gen_model_catalog.py puts them in its catalog), so its
# estimate and this worker's pre-flight size the call identically.
SYSTEM_TOKENS = 900  # the fixed rules
OUT_TOKENS_PER_CRITERION = 450  # the most one criterion's block may take
OUT_TOKENS_OVERALL = 400  # the overall paragraph and the priorities
MAX_PRIORITIES = 5
MAX_CHANGES_PER_CRITERION = 4
MAX_OVERALL_CHARS = 1200
MAX_DIAGNOSIS_CHARS = 600
MAX_CHANGE_CHARS = 500

ChangeKind = Literal["ADD", "CHANGE", "REMOVE"]


def max_output_tokens(criteria: int) -> int:
    """The most the call may write for a rubric of `criteria` criteria: the cap sent to the provider and the worst case the cost is gated
    on."""
    return criteria * OUT_TOKENS_PER_CRITERION + OUT_TOKENS_OVERALL


class Change(BaseModel):
    kind: ChangeKind
    text: str = Field(min_length=1, max_length=MAX_CHANGE_CHARS)


class CriterionSuggestion(BaseModel):
    criterion_id: str
    diagnosis: str = Field(min_length=1, max_length=MAX_DIAGNOSIS_CHARS)
    changes: list[Change] = Field(default_factory=list, max_length=MAX_CHANGES_PER_CRITERION)


class Suggestions(BaseModel):
    overall: str = Field(min_length=1, max_length=MAX_OVERALL_CHARS)
    priorities: list[str] = Field(default_factory=list, max_length=MAX_PRIORITIES)  # criterion ids, the one that pays most first
    criteria: list[CriterionSuggestion] = Field(default_factory=list)


class SuggestionResult(BaseModel):
    suggestions: Suggestions | None = None
    usage: ProviderUsage = ProviderUsage()  # what the call cost, even when its answer could not be used
    error: str | None = None  # the type of the error when there are no suggestions


class Suggester(Protocol):
    model: str
    version: str  # the wrapper, rules and schema version: stored with the result, so a result says what produced it

    async def suggest(self, *, prompt: str, aggregate: dict[str, Any]) -> SuggestionResult:
        """`prompt`: the agent's prompt (untrusted, masked before it is sent). `aggregate`: the numbers, as the console stored them."""
        ...
