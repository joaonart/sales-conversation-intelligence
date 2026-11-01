"""Publishes to Pub/Sub through its REST API with the service's own identity (no client library, no keys)."""
from __future__ import annotations

import asyncio
import base64
import json
from typing import Any

_SCOPE = "https://www.googleapis.com/auth/pubsub"
_TIMEOUT_SECONDS = 20


class PublishError(RuntimeError):
    """The topic did not accept the message (the status only, never the payload)."""


class PubSubPublisher:
    def __init__(self, project: str, session: Any | None = None) -> None:
        self._project = project
        self._session = session

    def _http(self) -> Any:
        if self._session is None:
            import google.auth
            from google.auth.transport.requests import AuthorizedSession

            credentials, _ = google.auth.default(scopes=[_SCOPE])
            self._session = AuthorizedSession(credentials)  # type: ignore[no-untyped-call]
        return self._session

    async def publish(self, topic: str, payload: dict[str, Any], attributes: dict[str, str] | None = None) -> str:
        """`topic` is the topic name (not the full path). Returns the message id."""
        data = base64.b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()
        body = {"messages": [{"data": data, "attributes": attributes or {}}]}
        url = f"https://pubsub.googleapis.com/v1/projects/{self._project}/topics/{topic}:publish"

        def send() -> str:
            response = self._http().post(url, json=body, timeout=_TIMEOUT_SECONDS)
            if response.status_code != 200:
                raise PublishError(f"pubsub publish failed: HTTP {response.status_code}")
            return str(response.json()["messageIds"][0])

        try:
            return await asyncio.to_thread(send)
        except PublishError:
            raise
        except Exception as exc:
            raise PublishError(f"pubsub publish failed: {type(exc).__name__}") from exc
