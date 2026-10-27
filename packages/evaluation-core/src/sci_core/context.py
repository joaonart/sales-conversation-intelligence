"""Session context construction. Message text is untrusted evidence, never instructions."""
from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel

_DELIM = "<<<MESSAGE"
_END = "MESSAGE>>>"

_PII = [
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"), "[EMAIL]"),
    (re.compile(r"\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b"), "[CPF]"),
    (re.compile(r"\b\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}\b"), "[CNPJ]"),
    (re.compile(r"(?<!\w)(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?9?\d{4}[-\s]?\d{4}(?!\w)"), "[PHONE]"),
]


def mask_pii(text: str) -> str:
    for pattern, token in _PII:
        text = pattern.sub(token, text)
    return text


class Conversation(BaseModel):
    """Prepared, masked conversation. `message_ids` is the allowed evidence set."""
    text: str
    message_ids: tuple[str, ...]
    approx_tokens: int


def build_conversation(messages: list[dict[str, Any]], *, mask: bool = True) -> Conversation:
    ordered = sorted(messages, key=lambda m: (m.get("sequence_number") or 0, m["message_id"]))
    parts: list[str] = []
    for m in ordered:
        content = m.get("content") or ""
        content = mask_pii(content) if mask else content
        # Neutralise delimiter spoofing so a message cannot close its own data block.
        content = content.replace(_DELIM, "<<MESSAGE").replace(_END, "MESSAGE>>")
        parts.append(f'{_DELIM} id={m["message_id"]} role={m.get("sender_type") or "unknown"}\n{content}\n{_END}')
    text = "\n".join(parts)
    return Conversation(text=text, message_ids=tuple(m["message_id"] for m in ordered),
                        approx_tokens=max(1, len(text) // 4))
