"""Why something failed, in a form that is safe to store and show: a closed set of codes plus the exception class name.

Never the exception message, a provider response body or any conversation text (they may echo chat content). The codes are what the console
turns into an explanation and a suggested action, so a user can tell a rate limit from a bad key from an oversized conversation.
"""
from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from sci_bq.runner import QueryTooExpensive
from sci_bq.source import Tenant
from sci_core.hashing import canonical_hash
from sci_core.rubric import RubricError
from sci_openai.errors import (
    CircuitOpen,
    InvalidProviderResponse,
    ProviderError,
    ProviderRequestError,
    QuotaExceeded,
    TransientProviderError,
)

# Closed set. The console has a text and a suggested action for each one.
CODES = (
    "PROVIDER_UNAVAILABLE", "PROVIDER_QUOTA", "PROVIDER_AUTH", "PROVIDER_REJECTED", "PROVIDER_CIRCUIT_OPEN", "INVALID_PROVIDER_RESPONSE",
    "INPUT_TOO_LARGE", "PROVIDER_ERROR", "RUBRIC_UNAVAILABLE", "QUERY_TOO_EXPENSIVE", "BIGQUERY_ERROR", "TIMEOUT", "UNEXPECTED",
)
_SAFE_CODE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


@dataclass(frozen=True)
class FailureInfo:
    code: str
    error_type: str
    http_status: int | None = None
    provider_code: str | None = None


def classify_failure(exc: BaseException) -> FailureInfo:
    name = type(exc).__name__
    if isinstance(exc, ProviderRequestError):
        provider = exc.code if isinstance(exc.code, str) and _SAFE_CODE.match(exc.code) else None
        return FailureInfo("PROVIDER_AUTH" if exc.status in (401, 403) else "PROVIDER_REJECTED", name, exc.status, provider)
    if isinstance(exc, QuotaExceeded):
        return FailureInfo("PROVIDER_QUOTA", name)
    if isinstance(exc, TransientProviderError):
        return FailureInfo("PROVIDER_UNAVAILABLE", name)
    if isinstance(exc, CircuitOpen):
        return FailureInfo("PROVIDER_CIRCUIT_OPEN", name)
    if isinstance(exc, InvalidProviderResponse):
        return FailureInfo("INVALID_PROVIDER_RESPONSE", name)
    if isinstance(exc, ProviderError):  # the adapters raise the base class only to refuse an oversized conversation
        return FailureInfo("INPUT_TOO_LARGE" if "max_input_tokens" in str(exc) else "PROVIDER_ERROR", name)
    if isinstance(exc, RubricError):
        return FailureInfo("RUBRIC_UNAVAILABLE", name)
    if isinstance(exc, QueryTooExpensive):
        return FailureInfo("QUERY_TOO_EXPENSIVE", name)
    if isinstance(exc, TimeoutError):
        return FailureInfo("TIMEOUT", name)
    module = type(exc).__module__
    if module.startswith("google.") or module.startswith("grpc"):
        return FailureInfo("BIGQUERY_ERROR", name)
    return FailureInfo("UNEXPECTED", name)


class FailureSink(Protocol):
    """Where failure rows go (BigQuery in production). Optional for every job: without one, only the counters are kept."""

    async def write_failures(self, rows: Sequence[dict[str, Any]]) -> None: ...


def failure_row(
    tenant: Tenant, run_id: str, session_id: str | None, stage: str, exc: BaseException, now: datetime
) -> dict[str, Any]:
    """Deterministic `failure_id`: a retried write of the same failure is the same logical row."""
    info = classify_failure(exc)
    fid = canonical_hash([tenant.organization_id, tenant.workspace_id, run_id, session_id, stage, now.isoformat()])[:32]
    return {
        "failure_id": fid, "run_id": run_id, "organization_id": tenant.organization_id, "workspace_id": tenant.workspace_id,
        "session_id": session_id, "stage": stage, "error_code": info.code, "error_type": info.error_type,
        "http_status": info.http_status, "provider_code": info.provider_code, "occurred_at": now.isoformat(),
    }
