"""Every paid call to the AI provider is recorded the moment the provider answers.

Why: the monthly cap used to read the cost of the analyses that were STORED. A paid call whose result is never stored (a failed write, a
concurrent twin that lost the race) was in no table, so the cap undercounted real spend. A row here is written before the answer is scored
or stored, and the cap reads these rows. A row never holds message text: ids, model, tokens and cost.
"""
from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any, Protocol

log = logging.getLogger("sci.spend")


class SpendRecorder(Protocol):
    async def record(self, row: dict[str, Any]) -> None: ...


def spend_row(*, kind: str, organization_id: str, workspace_id: str, session_id: str | None, subject_id: str | None, mode: str | None,
              model: str | None, input_tokens: int, output_tokens: int, cost_usd: float, now: datetime | None = None) -> dict[str, Any]:
    """One row per call: `spend_id` is unique per call (two calls for the same analysis are two rows, because both were paid)."""
    return {
        "spend_id": f"{kind.lower()}-{uuid.uuid4().hex}", "organization_id": organization_id, "workspace_id": workspace_id,
        "session_id": session_id, "kind": kind, "subject_id": subject_id, "mode": mode, "model": model,
        "input_tokens": input_tokens, "output_tokens": output_tokens, "cost_usd": cost_usd,
        "occurred_at": (now or datetime.now(UTC)).isoformat(),
    }


async def record_best_effort(recorder: SpendRecorder | None, row: dict[str, Any]) -> bool:
    """Records the spend; on failure it says so loudly and carries on (dropping an answer already paid for would cost twice)."""
    if recorder is None:
        return False
    try:
        await recorder.record(row)
        return True
    except Exception as exc:
        log.error("spend not recorded", extra={"event": "spend_not_recorded", "error_type": type(exc).__name__, "kind": row.get("kind"),
                                               "organization_id": row.get("organization_id"), "cost_usd": row.get("cost_usd")})
        return False
