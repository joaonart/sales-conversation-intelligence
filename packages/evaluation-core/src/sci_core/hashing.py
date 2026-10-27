"""Stable hashes used for idempotency and content-hash deduplication."""
import hashlib
import json
from typing import Any


def canonical_hash(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def session_content_hash(messages: list[dict[str, Any]]) -> str:
    """Order-independent of fetch order: sorted by (sequence_number, message_id)."""
    ordered = sorted(messages, key=lambda m: (m.get("sequence_number") or 0, m["message_id"]))
    return canonical_hash([
        [m["message_id"], m.get("sequence_number"), m.get("sender_type"), m.get("content")] for m in ordered
    ])


def analysis_id(
    *, organization_id: str, workspace_id: str, session_id: str, rubric_id: str,
    rubric_version: int, content_hash: str, model: str, prompt_version: str,
) -> str:
    """Deterministic: a retry of the same logical analysis yields the same id."""
    return canonical_hash([organization_id, workspace_id, session_id, rubric_id, rubric_version,
                           content_hash, model, prompt_version])
