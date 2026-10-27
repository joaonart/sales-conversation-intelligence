"""Debounce scheduling. Cloud Tasks named tasks dedupe repeated events per (tenant, session, window)."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from sci_workers.live import SessionUpdateEvent


class Scheduler(Protocol):
    async def schedule(self, event: SessionUpdateEvent, delay_seconds: int) -> bool:
        """True if newly scheduled, False if an equivalent task already exists (debounced)."""
        ...


class CloudTasksScheduler:
    def __init__(self, *, project: str, location: str, queue: str, target_url: str, invoker_sa: str, audience: str,
                 window_seconds: int, client: Any | None = None) -> None:
        from google.cloud import tasks_v2

        self._tasks, self._window = tasks_v2, window_seconds
        self._client = client or tasks_v2.CloudTasksClient()
        self._parent = f"projects/{project}/locations/{location}/queues/{queue}"
        self._url, self._sa, self._aud = target_url, invoker_sa, audience

    def _create(self, event: SessionUpdateEvent, delay_seconds: int) -> bool:
        from google.api_core.exceptions import AlreadyExists
        from google.protobuf import timestamp_pb2

        when = timestamp_pb2.Timestamp()  # type: ignore[attr-defined]
        when.FromDatetime(datetime.now(UTC) + timedelta(seconds=delay_seconds))
        task = {
            "name": f"{self._parent}/tasks/{event.debounce_key(self._window)}",
            "schedule_time": when,
            "http_request": {
                "http_method": self._tasks.HttpMethod.POST, "url": self._url,
                "headers": {"Content-Type": "application/json"},
                "body": event.model_dump_json().encode(),
                "oidc_token": {"service_account_email": self._sa, "audience": self._aud},
            },
        }
        try:
            self._client.create_task(request={"parent": self._parent, "task": task})
        except AlreadyExists:
            return False
        return True

    async def schedule(self, event: SessionUpdateEvent, delay_seconds: int) -> bool:
        return await asyncio.to_thread(self._create, event, delay_seconds)
