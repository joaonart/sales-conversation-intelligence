"""How to turn a conversation of YOUR system into the events the platform expects. The `chat` record below is invented: replace `chat_to_event`
with the mapping of your own data. What matters are the four rules this file shows:

1. `session_id` is the id of the conversation in your system; every event of the same conversation carries the same one.
2. `started_at` never changes; `updated_at` is the moment of the LAST change in your system and must grow with every event you send.
3. Send the messages that are new since the last event (sending an old one again is harmless: the platform stores each message_id once).
4. `event_id` is unique per event. Building it from the session and `updated_at` makes a retry of the same change produce the same id.

Run `python mapping_example.py` to print the events built from the sample chat (nothing is sent).
"""
from __future__ import annotations

import json
from collections.abc import Iterable
from typing import Any

SENDER_TYPES = {"client": "customer", "agent": "seller", "bot": "bot", "system": "system"}  # your labels -> the platform's four


def chat_to_event(chat: dict[str, Any], *, organization_id: str, workspace_id: str, already_sent: Iterable[str] = ()) -> dict[str, Any] | None:
    """The event for the current state of `chat`, with only the messages not sent yet. None when nothing is new and the chat is still open.

    A closed chat always produces an event (it carries the closing): sending it again is harmless, because the same `updated_at` changes nothing."""
    sent = set(already_sent)
    new = [m for m in chat["messages"] if m["id"] not in sent]
    if not new and not chat.get("closed_at"):
        return None
    last_change = max([m["at"] for m in chat["messages"]] + ([chat["closed_at"]] if chat.get("closed_at") else []) + [chat["opened_at"]])
    return {
        "event_id": f"{chat['id']}@{last_change}",
        "organization_id": organization_id,
        "workspace_id": workspace_id,
        "session": {
            "session_id": chat["id"],
            "channel": chat.get("channel"),
            "customer_id": chat["customer"]["id"],
            "seller_id": chat.get("agent", {}).get("id"),
            "status": "closed" if chat.get("closed_at") else "open",
            "started_at": chat["opened_at"],
            "updated_at": last_change,
            "closed_at": chat.get("closed_at"),
        },
        "messages": [
            {
                "message_id": m["id"],
                "sender_id": m.get("sender_id"),
                "sender_type": SENDER_TYPES.get(m["from"]),
                "message_type": "text",
                "content": m["text"],
                "created_at": m["at"],
                "sequence_number": i,
            }
            for i, m in enumerate(chat["messages"], start=1)
            if m["id"] not in sent
        ],
    }


SAMPLE_CHAT = {
    "id": "exemplo-002", "channel": "webchat", "customer": {"id": "cliente-90"}, "agent": {"id": "vendedor-3"},
    "opened_at": "2026-11-02T15:00:00Z", "closed_at": None,
    "messages": [
        {"id": "a1", "from": "client", "sender_id": "cliente-90", "text": "Bom dia, vocês entregam em Curitiba?", "at": "2026-11-02T15:00:04Z"},
        {"id": "a2", "from": "agent", "sender_id": "vendedor-3", "text": "Bom dia! Entregamos sim, em 3 dias úteis.", "at": "2026-11-02T15:01:00Z"},
    ],
}


if __name__ == "__main__":
    first = chat_to_event(SAMPLE_CHAT, organization_id="org-test", workspace_id="default")
    print(json.dumps(first, ensure_ascii=False, indent=2))
    # later: one more message arrives and the chat is closed; only the new message goes, with a later updated_at
    SAMPLE_CHAT["messages"].append({"id": "a3", "from": "client", "sender_id": "cliente-90", "text": "Perfeito, obrigado!", "at": "2026-11-02T15:02:10Z"})
    SAMPLE_CHAT["closed_at"] = "2026-11-02T15:02:30Z"
    second = chat_to_event(SAMPLE_CHAT, organization_id="org-test", workspace_id="default", already_sent=["a1", "a2"])
    print(json.dumps(second, ensure_ascii=False, indent=2))
