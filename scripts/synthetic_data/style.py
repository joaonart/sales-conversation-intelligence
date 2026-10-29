"""Turns clean template text into how people really type in chat apps. `level` is 0 (formal) .. 1 (very informal)."""

from __future__ import annotations

import random
import unicodedata

ABBR = [
    ("você", "vc"),
    ("vocês", "vcs"),
    ("porque", "pq"),
    ("não", "n"),
    ("também", "tb"),
    ("beleza", "blz"),
    ("obrigado", "obg"),
    ("obrigada", "obg"),
    ("por favor", "pfv"),
    ("quanto", "qto"),
    ("para", "pra"),
    ("está", "tá"),
    ("estou", "tô"),
    ("tudo bem", "td bem"),
    ("comigo", "cmg"),
    ("mesmo", "msm"),
]
EMOJIS = ["😊", "👍", "🙏", "😅", "😉", "🙂", "😕", "🔥", "👏"]


def strip_accents(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn")


def _typo(rng: random.Random, text: str) -> str:
    words = text.split(" ")
    idx = [i for i, w in enumerate(words) if len(w) > 4 and w.isalpha()]
    if not idx:
        return text
    i = rng.choice(idx)
    w = list(words[i])
    j = rng.randrange(1, len(w) - 2)
    w[j], w[j + 1] = w[j + 1], w[j]
    words[i] = "".join(w)
    return " ".join(words)


def casualize(rng: random.Random, text: str, level: float, typo_scale: float = 1.0) -> str:
    if not text or level <= 0:
        return text
    if rng.random() < level * 0.6:
        text = text[0].lower() + text[1:]
    for long, short in ABBR:
        if long in text.lower() and rng.random() < level * 0.5:
            text = text.replace(long, short).replace(long.capitalize(), short)
    if rng.random() < level * 0.25:
        text = strip_accents(text)
    if rng.random() < level * 0.15 * typo_scale:
        text = _typo(rng, text)
    if rng.random() < level * 0.08 and text[-1:].isalpha():
        text += text[-1] * rng.randint(1, 3)  # "simmm"
    if text.endswith((".", "!")) and rng.random() < level * 0.6:
        text = text[:-1]
    if rng.random() < level * 0.12:
        text += " " + rng.choice(EMOJIS)
    return text


def burst(rng: random.Random, text: str, level: float) -> list[str]:
    """People often send one thought as several short messages."""
    if len(text) < 60 or rng.random() > level * 0.5:
        return [text]
    cut = text.find(". ", 20)
    if cut == -1 or cut > len(text) - 15:
        cut = text.find(", ", 25)
    if cut == -1 or cut > len(text) - 15:
        return [text]
    return [text[: cut + 1].strip(), text[cut + 1 :].strip()]
