"""Debounce scheduling. Cloud Tasks named tasks dedupe the notices of a session that arrive within one window.

Every notice of a session that arrives within the same window shares ONE task, and that task runs one wait after the window ENDS. So the
wait is between `delay` and `delay + window` seconds, and two tasks of the same session are always a whole window apart: an evaluation
(seconds long) never overlaps the next one, so two of them never pay the AI for the same conversation at the same time."""
from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Protocol

from sci_workers.live import SessionUpdateEvent


class Scheduler(Protocol):
    async def schedule(self, event: SessionUpdateEvent, delay_seconds: int) -> bool:
        """True if newly scheduled, False if an equivalent task already exists (debounced)."""
        ...


def plan_task(event: SessionUpdateEvent, window_seconds: int, delay_seconds: int, arrived_at: datetime) -> tuple[str, datetime]:
    """(task key, when it runs). Pure: the window is the one the notice arrived in; the task runs one wait after that window ends."""
    key = event.debounce_key(window_seconds, arrived_at)
    window_end = (int(arrived_at.timestamp() // window_seconds) + 1) * window_seconds
    return key, datetime.fromtimestamp(window_end + delay_seconds, UTC)


class CloudTasksScheduler:
    def __init__(self, *, project: str, location: str, queue: str, target_url: str, invoker_sa: str, audience: str,
                 window_seconds: int, client: Any | None = None, clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        from google.cloud import tasks_v2

        self._tasks, self._window = tasks_v2, window_seconds
        self._client = client or tasks_v2.CloudTasksClient()
        self._parent = f"projects/{project}/locations/{location}/queues/{queue}"
        self._url, self._sa, self._aud = target_url, invoker_sa, audience
        self._clock = clock

    def _create(self, event: SessionUpdateEvent, delay_seconds: int) -> bool:
        from google.api_core.exceptions import AlreadyExists
        from google.protobuf import timestamp_pb2

        key, run_at = plan_task(event, self._window, delay_seconds, self._clock())
        when = timestamp_pb2.Timestamp()  # type: ignore[attr-defined]
        when.FromDatetime(run_at)
        task = {
            "name": f"{self._parent}/tasks/{key}",
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
