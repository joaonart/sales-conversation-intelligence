"""Structured, metadata-only logging (Cloud Logging JSON) with trace correlation.

Privacy by construction: only allowlisted fields are ever emitted. Free-form text (messages, prompts, exception
messages, tracebacks with values) cannot reach the log line, whatever a caller passes in `extra`.
"""
from __future__ import annotations

import contextvars
import json
import logging
import sys
import time
import traceback
from datetime import UTC, datetime
from typing import Any

ALLOWED_FIELDS = frozenset({
    "event", "outcome", "mode", "event_id", "run_id", "session_id", "organization_id", "workspace_id", "rubric_id",
    "rubric_version", "latency_ms", "cost_usd", "input_tokens", "output_tokens", "error_type", "status", "attempt",
    "sessions", "processed", "failed", "skipped", "new_task", "path", "model",
})
_RESERVED = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {"message", "asctime"}
trace_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("sci_trace_id", default=None)

_SEVERITY = {"DEBUG": "DEBUG", "INFO": "INFO", "WARNING": "WARNING", "ERROR": "ERROR", "CRITICAL": "CRITICAL"}


def parse_trace_header(header: str | None, project: str | None) -> str | None:
    """`X-Cloud-Trace-Context: TRACE_ID/SPAN_ID;o=1` -> projects/<p>/traces/<TRACE_ID>."""
    if not header or not project:
        return None
    tid = header.split("/", 1)[0].strip()
    return f"projects/{project}/traces/{tid}" if len(tid) == 32 and all(c in "0123456789abcdefABCDEF" for c in tid) else None


def safe_stack(exc: BaseException | None, limit: int = 6) -> list[str]:
    """Frames only (file:line function): no exception text, no source lines, no local values."""
    if exc is None:
        return []
    return [f"{f.filename.rsplit('/', 1)[-1]}:{f.lineno} {f.name}" for f in traceback.extract_tb(exc.__traceback__)[-limit:]]


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "severity": _SEVERITY.get(record.levelname, "DEFAULT"),
            "message": record.getMessage() if not record.args else str(record.msg),  # static message only
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "logger": record.name,
        }
        for key, value in record.__dict__.items():
            if key in _RESERVED or key not in ALLOWED_FIELDS:
                continue
            payload[key] = value if isinstance(value, (int, float, bool)) or value is None else str(value)[:200]
        if record.exc_info and record.exc_info[1] is not None:
            payload["error_type"] = type(record.exc_info[1]).__name__
            payload["stack"] = safe_stack(record.exc_info[1])
        tid = trace_id.get()
        if tid:
            payload["logging.googleapis.com/trace"] = tid
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging(level: int = logging.INFO, stream: Any = None) -> None:
    """Idempotent: replaces handlers on the root logger with one JSON handler."""
    handler = logging.StreamHandler(stream or sys.stdout)
    handler.setFormatter(JsonFormatter())
    handler.set_name("sci-json")
    root = logging.getLogger()
    root.handlers = [h for h in root.handlers if h.get_name() != "sci-json"] + [handler]
    root.setLevel(level)


class Stopwatch:
    def __init__(self, clock: Any = time.monotonic) -> None:
        self._clock, self._start = clock, clock()

    @property
    def ms(self) -> int:
        return int((self._clock() - self._start) * 1000)
