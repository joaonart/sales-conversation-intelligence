"""Published-rubric loading with tenant-safe caching."""
from __future__ import annotations

import time
from collections.abc import Callable
from typing import Protocol

from sci_core.rubric import Rubric, RubricError, RubricStatus


class RubricRepository(Protocol):
    """Backed by BigQuery in production. Must filter by organization/workspace."""

    async def fetch(
        self, organization_id: str, workspace_id: str, rubric_id: str, version: int | None
    ) -> Rubric | None:
        """version=None -> latest PUBLISHED version."""
        ...


class RubricLoader:
    """Pinned versions are immutable so they are cached forever; 'latest' uses a short TTL."""

    def __init__(self, repo: RubricRepository, latest_ttl_seconds: float = 60,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._repo = repo
        self._ttl = latest_ttl_seconds
        self._clock = clock
        self._pinned: dict[tuple[str, str, str, int], Rubric] = {}
        self._latest: dict[tuple[str, str, str], tuple[float, Rubric]] = {}

    async def load(self, organization_id: str, workspace_id: str, rubric_id: str,
                   version: int | None = None) -> Rubric:
        if version is not None:
            hit = self._pinned.get((organization_id, workspace_id, rubric_id, version))
            if hit:
                return hit
        else:
            entry = self._latest.get((organization_id, workspace_id, rubric_id))
            if entry and self._clock() - entry[0] < self._ttl:
                return entry[1]
        rubric = await self._repo.fetch(organization_id, workspace_id, rubric_id, version)
        if rubric is None:
            raise RubricError(f"rubric {rubric_id} (version={version}) not found")
        # Defense in depth: a repository bug must never leak another tenant's rubric.
        if (rubric.organization_id, rubric.workspace_id, rubric.rubric_id) != (organization_id, workspace_id, rubric_id):
            raise RubricError("repository returned a rubric outside the requested tenant scope")
        if rubric.status != RubricStatus.PUBLISHED:
            raise RubricError(f"rubric {rubric_id} v{rubric.version} is {rubric.status.value}, not PUBLISHED")
        if version is not None and rubric.version != version:
            raise RubricError("repository returned a different rubric version than requested")
        self._pinned[(organization_id, workspace_id, rubric_id, rubric.version)] = rubric
        if version is None:
            self._latest[(organization_id, workspace_id, rubric_id)] = (self._clock(), rubric)
        return rubric
