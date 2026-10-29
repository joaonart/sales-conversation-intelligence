"""A conversation under construction: a list of turns plus the ground truth of what really happened in it."""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any

from . import lexicon as L
from . import style


class _Safe(dict):
    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def fill(rng: random.Random, bank: list[str], **slots: Any) -> str:
    return rng.choice(bank).format_map(_Safe(slots))


@dataclass
class Turn:
    who: str  # customer | seller | bot | system
    text: str
    mtype: str = "text"  # text | audio | image | document | sticker | system
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class Convo:
    rng: random.Random
    customer_level: float  # informality of the customer
    seller_level: float
    hi: str = "Olá"  # day-part greeting matching the session's local start time
    turns: list[Turn] = field(default_factory=list)
    truth: dict[str, Any] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)

    def customer(self, text: str, *, mtype: str = "text", casual: bool = True) -> None:
        if casual and len(text) > 18 and text.endswith("?") and self.rng.random() < 0.22:
            text = self.rng.choice(L.CUSTOMER_LEAD) + text[0].lower() + text[1:]  # natural lead-in
        text = style.casualize(self.rng, text, self.customer_level) if casual else text
        for part in style.burst(self.rng, text, self.customer_level):
            self.turns.append(Turn("customer", part, mtype))

    def seller(self, text: str, *, mtype: str = "text") -> None:
        if len(text) > 30 and self.rng.random() < 0.15:
            text = self.rng.choice(L.SELLER_LEAD) + text
        if len(text) > 45 and text.endswith((".", "!")) and self.rng.random() < 0.12:
            text += self.rng.choice(L.SELLER_TAIL)
        text = style.casualize(self.rng, text, self.seller_level, typo_scale=0.3)  # sellers type more carefully than customers
        self.turns.append(Turn("seller", text, mtype))

    def other(self, who: str, text: str) -> None:
        self.turns.append(Turn(who, text, "system" if who == "system" else "text"))

    def customer_audio(self, text: str) -> None:
        """Voice notes arrive as transcriptions."""
        self.turns.append(Turn("customer", style.casualize(self.rng, text, self.customer_level * 0.7), "audio"))

    def sticker(self) -> None:
        self.turns.append(Turn("customer", "", "sticker"))

    def image(self) -> None:
        self.turns.append(Turn("customer", "[imagem enviada pelo cliente]", "image"))

    def document(self, who: str, name: str) -> None:
        self.turns.append(Turn(who, f"[documento enviado: {name}]", "document"))
