"""Validated table references. Identifiers come from deployment config, never from request input."""
from __future__ import annotations

import re
from dataclasses import dataclass

_PROJECT = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
_DATASET = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,1023}$")  # BigQuery datasets: no hyphens
_TABLE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,1023}$")


def _ref(project: str, dataset: str, table: str) -> str:
    if not _PROJECT.match(project):
        raise ValueError(f"invalid project id: {project!r}")
    if not _DATASET.match(dataset):
        raise ValueError(f"invalid dataset id: {dataset!r}")
    if not _TABLE.match(table):
        raise ValueError(f"invalid table id: {table!r}")
    return f"`{project}.{dataset}.{table}`"


@dataclass(frozen=True)
class Tables:
    project: str
    source_dataset: str = "commerce"
    config_dataset: str = "conversation_config"
    analytics_dataset: str = "conversation_analytics"

    def _t(self, dataset: str, table: str) -> str:
        return _ref(self.project, dataset, table)

    @property
    def sessions(self) -> str:
        return self._t(self.source_dataset, "sessions")

    @property
    def messages(self) -> str:
        return self._t(self.source_dataset, "messages")

    @property
    def rubrics(self) -> str:
        return self._t(self.config_dataset, "evaluation_rubrics")

    @property
    def criteria(self) -> str:
        return self._t(self.config_dataset, "evaluation_criteria")

    @property
    def policies(self) -> str:
        return self._t(self.config_dataset, "evaluation_policies")

    @property
    def analyses(self) -> str:
        return self._t(self.analytics_dataset, "session_analyses")

    @property
    def latest_analyses(self) -> str:
        return self._t(self.analytics_dataset, "latest_session_analyses")

    @property
    def criterion_results(self) -> str:
        return self._t(self.analytics_dataset, "session_criterion_results")

    @property
    def runs(self) -> str:
        return self._t(self.analytics_dataset, "analysis_runs")

    @property
    def routes(self) -> str:
        return self._t(self.analytics_dataset, "session_routes")

    @property
    def current_routes(self) -> str:
        return self._t(self.analytics_dataset, "current_session_routes")

    @property
    def failures(self) -> str:
        return self._t(self.analytics_dataset, "run_failures")
