"""Conversation ingestion: a producer publishes a conversation to Pub/Sub; this stores it in the canonical BigQuery tables and announces it.

Order matters: the messages are stored first, then the session row (whose `updated_at` is what the analysis event announces), and only
then the analysis event is published, so the live worker never sees an event whose data is not queryable yet. Everything is idempotent
(Pub/Sub delivers at least once): a session only moves forward, a message is stored once, and the analysis event of a repeated delivery
is absorbed by the debounce. The text of a message is never logged.
"""
from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from sci_bq.source import Tenant

log = logging.getLogger("sci.ingest")

MAX_MESSAGES = 500
MAX_CONTENT_CHARS = 100_000
MAX_FUTURE = timedelta(days=1)  # a timestamp further ahead than this is a producer bug (clock, units), not a conversation


class UnauthorizedTenant(Exception):
    """The workspace is not in the ingest allowlist."""


class InvalidConversation(ValueError):
    """The payload is well-formed JSON but not an acceptable conversation (the message says why, without any message text)."""


def _aware(v: datetime | None) -> datetime | None:
    if v is not None and v.tzinfo is None:
        raise ValueError("timestamps must include a timezone")
    return v


class SessionIn(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    session_id: str = Field(min_length=1, max_length=128)
    channel: str | None = Field(default=None, max_length=64)
    customer_id: str | None = Field(default=None, max_length=128)
    seller_id: str | None = Field(default=None, max_length=128)
    status: Literal["open", "closed"] | None = None
    started_at: datetime
    updated_at: datetime
    closed_at: datetime | None = None
    metadata: dict[str, Any] | None = None

    _tz = field_validator("started_at", "updated_at", "closed_at")(_aware)

    @model_validator(mode="after")
    def _order(self) -> SessionIn:
        if self.updated_at < self.started_at:
            raise ValueError("session.updated_at is before session.started_at")
        if self.closed_at is not None and self.closed_at < self.started_at:
            raise ValueError("session.closed_at is before session.started_at")
        return self


class MessageIn(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    message_id: str = Field(min_length=1, max_length=128)
    sender_id: str | None = Field(default=None, max_length=128)
    sender_type: Literal["customer", "seller", "bot", "system"] | None = None
    message_type: str | None = Field(default=None, max_length=64)
    content: str = Field(max_length=MAX_CONTENT_CHARS)
    created_at: datetime
    sequence_number: int | None = None
    metadata: dict[str, Any] | None = None

    _tz = field_validator("created_at")(_aware)


class ConversationEvent(BaseModel):
    """Mirrors contracts/conversation-event.schema.json."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    event_id: str = Field(min_length=1, max_length=128)
    organization_id: str = Field(min_length=1, max_length=128)
    workspace_id: str = Field(min_length=1, max_length=128)
    session: SessionIn
    messages: list[MessageIn] = Field(default_factory=list, max_length=MAX_MESSAGES)

    @property
    def tenant(self) -> Tenant:
        return Tenant(self.organization_id, self.workspace_id)

    def validate_against(self, now: datetime) -> None:
        """Rules that depend on the clock or on the whole payload. Raises InvalidConversation."""
        s = self.session
        if s.updated_at > now + MAX_FUTURE or s.started_at > now + MAX_FUTURE:
            raise InvalidConversation("session timestamps are in the future")
        seen: set[str] = set()
        for m in self.messages:
            if m.message_id in seen:
                raise InvalidConversation("duplicate message_id inside the event")
            seen.add(m.message_id)
            # The analysis reads messages from the day the session started: an earlier message would be stored and then never read.
            if m.created_at.date() < s.started_at.date():
                raise InvalidConversation("a message is dated before the day the session started")
            if m.created_at > now + MAX_FUTURE:
                raise InvalidConversation("a message is dated in the future")


class SourceWriter(Protocol):
    async def write_messages(self, tenant: Tenant, session_id: str, messages: Sequence[dict[str, Any]]) -> None: ...
    async def write_session(self, tenant: Tenant, session: dict[str, Any]) -> bool:
        """True when the stored session changed (it was new or `updated_at` moved forward)."""
        ...


class Publisher(Protocol):
    async def publish(self, topic: str, payload: dict[str, Any], attributes: dict[str, str] | None = None) -> str: ...


@dataclass(frozen=True)
class IngestResult:
    messages: int
    session_changed: bool
    announced: bool


class IngestProcessor:
    def __init__(self, *, tenants: frozenset[tuple[str, str]], writer: SourceWriter, publisher: Publisher, events_topic: str,
                 clock: Any = lambda: datetime.now(UTC)) -> None:
        self._tenants, self._writer, self._pub, self._topic, self._clock = tenants, writer, publisher, events_topic, clock

    def authorize(self, event: ConversationEvent) -> None:
        if (event.organization_id, event.workspace_id) not in self._tenants:
            raise UnauthorizedTenant("workspace not enabled for ingestion")

    async def process(self, event: ConversationEvent) -> IngestResult:
        self.authorize(event)
        event.validate_against(self._clock())
        tenant, s = event.tenant, event.session
        if event.messages:
            await self._writer.write_messages(tenant, s.session_id, [_message_row(event, m) for m in event.messages])
        changed = await self._writer.write_session(tenant, _session_row(event))
        # Announce even when nothing changed: the previous delivery may have stored everything and then failed before publishing.
        # The analysis event carries the same id and the same source_updated_at, so the worker's debounce absorbs the repeat.
        await self._pub.publish(self._topic, {
            "event_id": event.event_id, "organization_id": event.organization_id, "workspace_id": event.workspace_id,
            "session_id": s.session_id, "source_updated_at": s.updated_at.isoformat(), "source_version": None,
        }, {"origin": "ingest"})
        log.info("conversation ingested", extra={
            "event": "conversation_ingested", "event_id": event.event_id, "organization_id": event.organization_id,
            "workspace_id": event.workspace_id, "session_id": s.session_id, "messages": len(event.messages), "session_changed": changed})
        return IngestResult(len(event.messages), changed, True)


def _iso(v: datetime | None) -> str | None:
    return v.astimezone(UTC).isoformat() if v else None


def _session_row(e: ConversationEvent) -> dict[str, Any]:
    s = e.session
    return {
        "organization_id": e.organization_id, "workspace_id": e.workspace_id, "session_id": s.session_id, "channel": s.channel,
        "customer_id": s.customer_id, "seller_id": s.seller_id, "status": s.status, "started_at": _iso(s.started_at),
        "updated_at": _iso(s.updated_at), "closed_at": _iso(s.closed_at), "metadata": s.metadata,
    }


def _message_row(e: ConversationEvent, m: MessageIn) -> dict[str, Any]:
    return {
        "organization_id": e.organization_id, "workspace_id": e.workspace_id, "session_id": e.session.session_id,
        "message_id": m.message_id, "sender_id": m.sender_id, "sender_type": m.sender_type, "message_type": m.message_type,
        "content": m.content,
        "created_at": _iso(m.created_at), "sequence_number": m.sequence_number, "metadata": m.metadata,
    }
