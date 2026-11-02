"""Sends conversations to the Sales Conversation Intelligence platform: validates each event, then publishes it to a Google Pub/Sub topic.

A small, complete reference for whoever integrates a system with the platform. Use it as a command line to try the integration, or import `Sender` in
your own application (see README.pt-BR.md). It needs Python 3.9+ and, to really publish, `google-cloud-pubsub` (see requirements.txt).

    python producer.py events/*.json                # validates only: nothing is sent
    python producer.py events/*.json --publish      # validates and sends (needs SCI_PROJECT, SCI_TOPIC and the key)
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

SCHEMA_PATH = Path(__file__).parent / "schema" / "conversation-event.schema.json"
PUBSUB_SCOPE = "https://www.googleapis.com/auth/pubsub"
MAX_MESSAGES = 500
MAX_FUTURE = timedelta(days=1)
RETRYABLE_HTTP = {408, 429, 500, 502, 503, 504}  # transient: try again. Everything else (403 wrong key, 404 wrong topic, 400...) will not fix itself


class InvalidEvent(ValueError):
    """The event breaks the contract. `errors` lists every problem (never the message text)."""

    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


class PublishFailed(RuntimeError):
    """The event could not be published (after the retries, or because retrying cannot help)."""


# ---------------------------------------------------------------- validation
def _parse_time(value: Any, where: str, errors: list[str]) -> datetime | None:
    """ISO 8601 WITH a timezone, like 2026-11-02T14:00:05Z or 2026-11-02T11:00:05-03:00."""
    if not isinstance(value, str):
        errors.append(f"{where}: must be a text in ISO 8601")
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        errors.append(f"{where}: not a valid ISO 8601 date and time")
        return None
    if parsed.tzinfo is None:
        errors.append(f"{where}: must include a timezone (use Z or an offset)")
        return None
    return parsed


def validate_event(event: Mapping[str, Any], *, now: datetime | None = None, schema: Mapping[str, Any] | None = None) -> None:
    """Raises InvalidEvent unless the event follows the contract AND the rules the platform checks when it receives it.

    The JSON Schema covers the shape (fields, types, sizes). The rest cannot be written in a schema, so it is checked here: timezones, the order of the
    dates, a message never before the day the session started, nothing in the future, and a message_id that appears once.
    """
    import jsonschema

    errors: list[str] = []
    schema = schema or json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    for e in sorted(jsonschema.Draft202012Validator(schema).iter_errors(event), key=lambda x: list(x.absolute_path)):
        where = ".".join(str(p) for p in e.absolute_path) or "event"
        errors.append(f"{where}: {e.message[:200]}" if e.validator != "additionalProperties" else f"{where}: {e.message}")
    if errors:  # the shape is wrong: the rules below would only repeat the same problems
        raise InvalidEvent(errors)

    now = now or datetime.now(UTC)
    session = event["session"]
    started = _parse_time(session["started_at"], "session.started_at", errors)
    updated = _parse_time(session["updated_at"], "session.updated_at", errors)
    closed = _parse_time(session.get("closed_at"), "session.closed_at", errors) if session.get("closed_at") is not None else None
    if started and updated and updated < started:
        errors.append("session.updated_at is before session.started_at (it must grow with every change)")
    if started and closed and closed < started:
        errors.append("session.closed_at is before session.started_at")
    for name, value in (("session.started_at", started), ("session.updated_at", updated)):
        if value and value > now + MAX_FUTURE:
            errors.append(f"{name} is in the future")
    seen: set[str] = set()
    for i, m in enumerate(event.get("messages", [])):
        where = f"messages[{i}]"
        if m["message_id"] in seen:
            errors.append(f"{where}.message_id appears twice in the event")
        seen.add(m["message_id"])
        created = _parse_time(m["created_at"], f"{where}.created_at", errors)
        if created and started and created.astimezone(UTC).date() < started.astimezone(UTC).date():
            errors.append(f"{where}.created_at is before the day the session started")
        if created and created > now + MAX_FUTURE:
            errors.append(f"{where}.created_at is in the future")
    if len(event.get("messages", [])) > MAX_MESSAGES:
        errors.append(f"more than {MAX_MESSAGES} messages: send the conversation in several events")
    if errors:
        raise InvalidEvent(errors)


# ---------------------------------------------------------------- credentials and publisher
class Publisher(Protocol):
    def publish(self, topic: str, data: bytes) -> str:
        """Publishes and returns the id Pub/Sub gave the message. Raises when it was not accepted."""
        ...


def load_credentials(env: Mapping[str, str] | None = None) -> Any:
    """The producer's key, from SCI_PUBSUB_KEY_JSON (the JSON text, e.g. read from AWS Secrets Manager) or SCI_PUBSUB_KEY_FILE (a path).

    Neither set: returns None and Google's default credentials apply (a producer that runs on Google Cloud needs no key at all)."""
    from google.oauth2 import service_account

    env = os.environ if env is None else env
    if env.get("SCI_PUBSUB_KEY_JSON"):
        try:
            info = json.loads(env["SCI_PUBSUB_KEY_JSON"])
        except json.JSONDecodeError as exc:  # never include the text: it is a secret
            raise SystemExit("SCI_PUBSUB_KEY_JSON is not valid JSON") from exc
        return service_account.Credentials.from_service_account_info(info, scopes=[PUBSUB_SCOPE])
    if env.get("SCI_PUBSUB_KEY_FILE"):
        return service_account.Credentials.from_service_account_file(env["SCI_PUBSUB_KEY_FILE"], scopes=[PUBSUB_SCOPE])
    return None


class PubSubPublisher:
    """The real publisher: one client for the whole life of the application (create it once and reuse it)."""

    def __init__(self, credentials: Any = None, timeout: float = 30.0) -> None:
        from google.cloud import pubsub_v1

        self._client = pubsub_v1.PublisherClient(credentials=credentials)
        self._timeout = timeout

    def publish(self, topic: str, data: bytes) -> str:
        return str(self._client.publish(topic, data).result(timeout=self._timeout))


# ---------------------------------------------------------------- sending
def is_retryable(exc: BaseException) -> bool:
    """A timeout, a dropped connection or a transient Google error (HTTP 408, 429, 5xx) is worth another try; a wrong key or topic is not."""
    if isinstance(exc, (TimeoutError, ConnectionError)):
        return True
    return getattr(exc, "code", None) in RETRYABLE_HTTP


class Sender:
    """Validates and publishes events, retrying transient failures with exponential backoff and jitter.

    Sending the same event again is safe: the platform stores each message once and a session only moves forward, so a retry never duplicates anything.
    """

    def __init__(self, publisher: Publisher, topic: str, *, retries: int = 5, base_delay: float = 1.0, max_delay: float = 30.0,
                 sleep: Callable[[float], None] = time.sleep, jitter: Callable[[], float] = random.random) -> None:
        self._publisher, self._topic, self._retries = publisher, topic, retries
        self._base, self._max, self._sleep, self._jitter = base_delay, max_delay, sleep, jitter

    def delay(self, attempt: int) -> float:
        """1 s, 2 s, 4 s... up to max_delay, plus up to 25% of random jitter so many senders do not retry at the same instant."""
        base = min(self._max, self._base * (2 ** attempt))
        return base + base * 0.25 * self._jitter()

    def send(self, event: Mapping[str, Any]) -> str:
        validate_event(event)
        data = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        for attempt in range(self._retries + 1):
            try:
                return self._publisher.publish(self._topic, data)
            except Exception as exc:  # noqa: BLE001  (every failure is classified below)
                if not is_retryable(exc):
                    raise PublishFailed(f"not accepted ({type(exc).__name__}); retrying will not fix it: check the key, the topic and the permissions") from exc
                if attempt == self._retries:
                    raise PublishFailed(f"still failing after {self._retries} retries ({type(exc).__name__})") from exc
                self._sleep(self.delay(attempt))
        raise AssertionError("unreachable")  # pragma: no cover


def topic_path(project: str, topic: str) -> str:
    return topic if topic.startswith("projects/") else f"projects/{project}/topics/{topic}"


# ---------------------------------------------------------------- command line
def main(argv: list[str] | None = None, *, env: Mapping[str, str] | None = None,
         make_publisher: Callable[[Any], Publisher] | None = None, out: Any = None) -> int:
    out = sys.stdout if out is None else out
    env = os.environ if env is None else env
    p = argparse.ArgumentParser(description="Validates conversation events and (with --publish) sends them to the platform's Pub/Sub topic.")
    p.add_argument("files", nargs="+", type=Path, help="JSON files, one event each, sent in the order given")
    p.add_argument("--publish", action="store_true", help="really send. Without it nothing leaves this machine: the events are only validated")
    p.add_argument("--project", default=env.get("SCI_PROJECT"))
    p.add_argument("--topic", default=env.get("SCI_TOPIC"))
    a = p.parse_args(argv)

    events = []
    for f in a.files:  # validate EVERYTHING first: nothing is sent if any file is wrong
        try:
            event = json.loads(f.read_text(encoding="utf-8"))
            validate_event(event)
        except (OSError, json.JSONDecodeError) as exc:
            print(f"{f}: cannot be read as JSON ({type(exc).__name__})", file=out)
            return 2
        except InvalidEvent as exc:
            print(f"{f}: INVALID", file=out)
            for line in exc.errors:
                print(f"  - {line}", file=out)
            return 2
        events.append((f, event))
        print(f"{f}: valid · event {event['event_id']} · session {event['session']['session_id']} · {len(event['messages'])} message(s)", file=out)

    if not a.publish:
        print("Nothing was sent (add --publish to send).", file=out)
        return 0
    if not a.project or not a.topic:
        print("Set SCI_PROJECT and SCI_TOPIC (or --project and --topic).", file=out)
        return 2
    topic = topic_path(a.project, a.topic)
    publisher = (make_publisher or (lambda c: PubSubPublisher(c)))(load_credentials(env))
    sender = Sender(publisher, topic)
    for f, event in events:
        try:
            message_id = sender.send(event)
        except PublishFailed as exc:
            print(f"{f}: NOT SENT: {exc}", file=out)
            return 1
        print(f"{f}: sent · Pub/Sub message {message_id}", file=out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
