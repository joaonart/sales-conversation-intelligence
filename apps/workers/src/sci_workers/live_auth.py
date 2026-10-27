"""OIDC verification for Pub/Sub push and Cloud Tasks callers (no shared secrets, no keys)."""
from __future__ import annotations

from typing import Protocol


class AuthError(PermissionError):
    pass


class TokenVerifier(Protocol):
    def verify(self, authorization: str | None) -> str:
        """Returns the verified caller email or raises AuthError."""
        ...


class GoogleOIDCVerifier:
    def __init__(self, audience: str, allowed_emails: frozenset[str]) -> None:
        if not audience or not allowed_emails:
            raise ValueError("audience and allowed_emails are required")
        self._aud, self._allowed = audience, allowed_emails

    def verify(self, authorization: str | None) -> str:
        from google.auth.transport import requests
        from google.oauth2 import id_token

        if not authorization or not authorization.lower().startswith("bearer "):
            raise AuthError("missing bearer token")
        try:
            claims = id_token.verify_oauth2_token(  # type: ignore[no-untyped-call]
                authorization[7:].strip(), requests.Request(), audience=self._aud)
        except ValueError as exc:  # signature, expiry, audience, issuer
            raise AuthError("invalid token") from exc
        email = claims.get("email")
        if not claims.get("email_verified") or email not in self._allowed:
            raise AuthError("caller not allowed")
        return str(email)
