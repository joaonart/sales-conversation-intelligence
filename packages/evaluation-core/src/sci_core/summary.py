"""The general evaluation of a conversation: a written summary (positives, negatives, opportunities) built from the criteria results and the
conversation, driven by a prompt the rubric carries.

It is NEVER an input of the score: the grade, the approval and every criterion are already final when the summary is written, and a summary
that fails or is refused changes nothing about them. Like the evidence step, it is a nicety on top of an analysis that was already paid
for, so a failure comes back as `SummaryResult.error` (a type, never text) instead of an exception.
"""
from __future__ import annotations

from typing import Protocol

from pydantic import BaseModel, Field

from sci_core.provider import ProviderUsage
from sci_core.rubric import MAX_SUMMARY_PROMPT_CHARS  # noqa: F401  (the limit of the rubric's prompt lives with the rubric)

MAX_ITEMS_PER_LIST = 6
MAX_OVERALL_CHARS = 1200
MAX_ITEM_CHARS = 400


class SummaryItem(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_ITEM_CHARS)
    message_ids: list[str] = Field(default_factory=list)  # evidence, always ids that exist in the session


class Summary(BaseModel):
    overall: str = Field(min_length=1, max_length=MAX_OVERALL_CHARS)
    strengths: list[SummaryItem] = Field(default_factory=list, max_length=MAX_ITEMS_PER_LIST)
    weaknesses: list[SummaryItem] = Field(default_factory=list, max_length=MAX_ITEMS_PER_LIST)
    opportunities: list[SummaryItem] = Field(default_factory=list, max_length=MAX_ITEMS_PER_LIST)


class SummaryResult(BaseModel):
    summary: Summary | None = None
    usage: ProviderUsage = ProviderUsage()  # what the call cost, even when its answer could not be used
    error: str | None = None  # the type of the error when there is no summary


class Summarizer(Protocol):
    model: str
    version: str  # the wrapper and schema version; it is part of the identity of an analysis that carries a summary

    async def summarize(
        self, *, prompt: str, conversation_text: str, results_text: str, message_ids: frozenset[str]
    ) -> SummaryResult:
        """`prompt`: the rubric's own text. `conversation_text`: masked, untrusted. `results_text`: the criteria results as the engine
        rendered them. `message_ids`: the only ids that may be cited."""
        ...
