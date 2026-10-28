"""Builds the real evaluation engine (OpenAI Decisions). Only reached after the explicit approval gates."""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from pathlib import Path

from sci_core.engine import EvaluationEngine
from sci_openai.decisions import DecisionsProvider
from sci_openai.http import OpenAIHttp
from sci_openai.pricing import LUNA_STANDARD_SHORT, TokenPrices


class MissingApiKey(RuntimeError):
    pass


def api_key_provider(env: Mapping[str, str] = os.environ) -> Callable[[], str]:
    """Key from OPENAI_API_KEY (Cloud Run injects the Secret Manager value) or a 0600 file in OPENAI_API_KEY_FILE.

    The key is read lazily and never logged; error messages do not include it."""
    file = env.get("OPENAI_API_KEY_FILE")
    inline = env.get("OPENAI_API_KEY")
    if file:
        path = Path(file).expanduser()
        if path.stat().st_mode & 0o077:
            raise MissingApiKey("OPENAI_API_KEY_FILE must not be readable by group/others (chmod 600)")
        value = path.read_text(encoding="utf-8").strip()
    elif inline:
        value = inline.strip()
    else:
        raise MissingApiKey("set OPENAI_API_KEY or OPENAI_API_KEY_FILE")
    if not value:
        raise MissingApiKey("OpenAI API key is empty")
    return lambda: value


def build_engine(
    *, mode: str, tenant_safety_id: str | None, key: Callable[[], str], prices: TokenPrices = LUNA_STANDARD_SHORT
) -> EvaluationEngine:
    provider = DecisionsProvider(OpenAIHttp(key), prices, tenant_safety_id=tenant_safety_id)
    return EvaluationEngine(provider, mode=mode)
