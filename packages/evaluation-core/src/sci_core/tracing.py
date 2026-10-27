"""Optional tracing. Uses the OpenTelemetry API only; without an SDK/exporter configured at deploy time the
spans are no-ops (zero cost). Attributes are allowlisted exactly like log fields."""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from sci_core.obs import ALLOWED_FIELDS

try:  # pragma: no cover - import guard
    from opentelemetry import trace as _trace

    _tracer: Any = _trace.get_tracer("sci")
except ImportError:  # pragma: no cover
    _tracer = None


@contextmanager
def span(name: str, **attributes: Any) -> Iterator[Any]:
    safe = {k: v for k, v in attributes.items() if k in ALLOWED_FIELDS and isinstance(v, (str, int, float, bool))}
    if _tracer is None:
        yield None
        return
    with _tracer.start_as_current_span(name, attributes=safe) as s:
        yield s
