class ProviderError(RuntimeError):
    """Base class. Messages never contain request/response bodies (they may echo chat content)."""


class ProviderRequestError(ProviderError):
    def __init__(self, status: int, code: str | None) -> None:
        super().__init__(f"OpenAI request rejected: status={status} code={code}")
        self.status, self.code = status, code


class QuotaExceeded(ProviderError):
    """Billing/quota problem: needs a human, never retried."""


class TransientProviderError(ProviderError):
    """Retries exhausted on 429/5xx/timeouts."""


class CircuitOpen(ProviderError):
    pass


class InvalidProviderResponse(ProviderError):
    pass
