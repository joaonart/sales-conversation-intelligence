"""Resilient JSON-over-HTTP client: bounded retries with jitter, circuit breaker, concurrency cap."""
from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import httpx

from sci_openai.errors import CircuitOpen, ProviderRequestError, QuotaExceeded, TransientProviderError

RETRYABLE_STATUS = {429, 500, 502, 503, 504}
NON_RETRYABLE_429_CODES = {"insufficient_quota", "billing_hard_limit_reached"}


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 4
    base_delay: float = 0.5
    max_delay: float = 20.0
    total_timeout: float = 60.0


class CircuitBreaker:
    def __init__(self, failure_threshold: int = 5, cooldown: float = 30.0, clock: Callable[[], float] = time.monotonic) -> None:
        self._threshold, self._cooldown, self._clock = failure_threshold, cooldown, clock
        self._failures: int = 0
        self._opened_at: float | None = None

    def allow(self) -> bool:
        if self._opened_at is None:
            return True
        if self._clock() - self._opened_at >= self._cooldown:
            self._opened_at = None  # half-open: let one attempt through
            self._failures = self._threshold - 1
            return True
        return False

    def success(self) -> None:
        self._failures, self._opened_at = 0, None

    def failure(self) -> None:
        self._failures += 1
        if self._failures >= self._threshold:
            self._opened_at = self._clock()


def _error_code(resp: httpx.Response) -> str | None:
    try:
        err = resp.json().get("error")
        return str(err.get("code") or err.get("type")) if isinstance(err, dict) else None
    except ValueError:
        return None


def _retry_after(resp: httpx.Response) -> float | None:
    raw = resp.headers.get("retry-after")
    try:
        return max(0.0, float(raw)) if raw is not None else None
    except ValueError:
        return None  # HTTP-date form is ignored; exponential backoff applies


class OpenAIHttp:
    def __init__(self, api_key_provider: Callable[[], str], *, base_url: str = "https://api.openai.com/v1",
                 client: httpx.AsyncClient | None = None, retry: RetryPolicy | None = None,
                 breaker: CircuitBreaker | None = None, concurrency: int = 4, timeout: float = 60.0,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep, rng: Callable[[], float] = random.random,
                 clock: Callable[[], float] = time.monotonic, project: str | None = None) -> None:
        self._key, self._base, self._sleep, self._rng, self._clock = api_key_provider, base_url, sleep, rng, clock
        self._retry = retry or RetryPolicy()
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=5.0))
        self._breaker = breaker or CircuitBreaker(clock=clock)
        self._sem = asyncio.Semaphore(concurrency)
        self._project = project

    def _headers(self) -> dict[str, str]:
        h = {"Authorization": f"Bearer {self._key()}", "Content-Type": "application/json"}
        if self._project:
            h["OpenAI-Project"] = self._project
        return h

    async def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        start = self._clock()
        last: str = "unknown"
        for attempt in range(1, self._retry.max_attempts + 1):
            if not self._breaker.allow():
                raise CircuitOpen("circuit open after repeated provider failures")
            retry_after: float | None = None
            try:
                async with self._sem:
                    resp = await self._client.post(f"{self._base}{path}", json=body, headers=self._headers())
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last = type(exc).__name__
                self._breaker.failure()
            else:
                if resp.status_code == 200:
                    self._breaker.success()
                    data = resp.json()
                    if not isinstance(data, dict):
                        raise TransientProviderError("unexpected response shape")
                    return data
                code = _error_code(resp)
                if resp.status_code == 429 and code in NON_RETRYABLE_429_CODES:
                    raise QuotaExceeded(f"quota/billing error: {code}")
                if resp.status_code not in RETRYABLE_STATUS:
                    raise ProviderRequestError(resp.status_code, code)  # 400/401/403/404...: retry cannot help
                last = f"status {resp.status_code}"
                retry_after = _retry_after(resp)
                self._breaker.failure()
            if attempt == self._retry.max_attempts:
                break
            backoff = min(self._retry.max_delay, self._retry.base_delay * 2 ** (attempt - 1))
            delay = max(backoff, retry_after or 0.0) + self._rng() * 0.25 * backoff  # Retry-After is a minimum
            if self._clock() - start + delay > self._retry.total_timeout:
                break
            await self._sleep(delay)
        raise TransientProviderError(f"provider unavailable after retries ({last})")
