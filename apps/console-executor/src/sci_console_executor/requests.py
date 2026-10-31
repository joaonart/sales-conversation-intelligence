"""Requests made in the console, and the executor that carries them out under its own gates."""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from sci_bq.runner import QueryRunner
from sci_bq.source import Tenant
from sci_openai.catalog import UnknownModel, find

log = logging.getLogger("sci.console_executor")  # metadata only: never log message content or prompts

MAX_WINDOW_DAYS = 366
Kind = Literal["ROUTING", "ANALYSIS", "SESSION_ANALYSIS"]
_PROJECT = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
_DATASET = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,1023}$")


class RequestRefused(Exception):
    """The request cannot be run. The message is safe to show to the administrator (no content, no secrets)."""


class Params(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    start: date | None = None
    end: date | None = None
    max_sessions: int | None = Field(default=None, ge=1)
    rubric_id: str | None = Field(default=None, min_length=1, max_length=128)
    rubric_version: int | None = Field(default=None, ge=1)
    only_routed: bool = False
    session_id: str | None = Field(default=None, min_length=1, max_length=128)
    provider: Literal["decisions", "responses"] | None = (
        None  # the API and model chosen in the console; both or none (none: the executor's own default)
    )
    model: str | None = Field(default=None, min_length=1, max_length=64)


@dataclass(frozen=True)
class RunRequest:
    request_id: str
    tenant: Tenant
    kind: Kind
    params: Params
    max_cost_usd: float
    requested_by: str


def parse_request(row: dict[str, Any], *, max_cost_ceiling: float, max_sessions_ceiling: int, today: date) -> RunRequest:
    """Validates a stored request again: the table is data, not authority."""
    kind = row.get("kind")
    if kind not in ("ROUTING", "ANALYSIS", "SESSION_ANALYSIS"):
        raise RequestRefused("Tipo de execução desconhecido.")
    try:
        raw = json.loads(row["params"]) if isinstance(row["params"], str) else dict(row["params"])
        p = Params.model_validate(raw)
    except (ValueError, ValidationError, KeyError, TypeError) as exc:
        raise RequestRefused("Parâmetros do pedido inválidos.") from exc
    if (p.provider is None) != (p.model is None):
        raise RequestRefused("O pedido precisa informar a API e o modelo juntos.")
    if p.provider and p.model:
        try:
            find(p.provider, p.model)  # a closed list: a stored request cannot name any other model or price
        except UnknownModel as exc:
            raise RequestRefused("Modelo fora da lista permitida para esta API.") from exc
    cap = float(row["max_cost_usd"])
    if not 0 < cap <= max_cost_ceiling:
        raise RequestRefused(f"O teto de custo do pedido (US$ {cap}) está fora do limite do executor (US$ {max_cost_ceiling}).")
    if kind == "SESSION_ANALYSIS":
        if not (p.session_id and p.rubric_id and p.rubric_version):
            raise RequestRefused("Pedido de uma sessão sem sessão ou rubrica.")
    else:
        if not (p.start and p.end and p.max_sessions):
            raise RequestRefused("Pedido sem janela ou limite de sessões.")
        if p.end < p.start or (p.end - p.start).days > MAX_WINDOW_DAYS or p.end > today:
            raise RequestRefused("Janela de datas inválida.")
        if p.max_sessions > max_sessions_ceiling:
            raise RequestRefused(f"O limite de sessões ({p.max_sessions}) passa do limite do executor ({max_sessions_ceiling}).")
        if kind == "ANALYSIS" and not (p.rubric_id and p.rubric_version):
            raise RequestRefused("Pedido de análise sem rubrica.")
    return RunRequest(
        request_id=str(row["request_id"]),
        tenant=Tenant(str(row["organization_id"]), str(row["workspace_id"])),
        kind=kind,
        params=p,
        max_cost_usd=cap,
        requested_by=str(row["requested_by"]),
    )


@dataclass(frozen=True)
class JobOutcome:
    status: str  # COMPLETED, COMPLETED_WITH_FAILURES, BUDGET_STOPPED, SESSION_GATE_STOPPED
    result: dict[str, Any]


class JobRunner(Protocol):
    """Runs one validated request with the existing jobs. Raises RequestRefused when its own preflight cannot approve it."""

    async def run(self, req: RunRequest) -> JobOutcome: ...


class RequestStore(Protocol):
    async def pending(self, tenant: Tenant, limit: int) -> list[dict[str, Any]]: ...
    async def claim(self, row: dict[str, Any], executor_id: str) -> bool: ...
    async def finish(
        self, row: dict[str, Any], executor_id: str, status: str, result: dict[str, Any] | None, error: str | None
    ) -> None: ...
    async def is_active_admin(self, tenant: Tenant, email: str) -> bool: ...


class RequestExecutor:
    def __init__(
        self,
        *,
        store: RequestStore,
        jobs: JobRunner,
        executor_id: str,
        max_cost_ceiling: float,
        max_sessions_ceiling: int,
        clock: Any = lambda: datetime.now(UTC),
    ) -> None:
        self._store, self._jobs, self._id = store, jobs, executor_id
        self._cost_ceiling, self._sessions_ceiling, self._clock = max_cost_ceiling, max_sessions_ceiling, clock

    async def list_pending(self, tenants: Sequence[Tenant], limit: int) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for t in tenants:
            out += await self._store.pending(t, limit)
        return sorted(out, key=lambda r: str(r["requested_at"]))[:limit]

    async def run_once(self, tenants: Sequence[Tenant], limit: int) -> list[tuple[str, str]]:
        """Claims and runs up to `limit` waiting requests (oldest first). Returns (request_id, final status)."""
        done: list[tuple[str, str]] = []
        for row in await self.list_pending(tenants, limit):
            if not await self._store.claim(row, self._id):
                continue  # cancelled or taken meanwhile
            done.append((str(row["request_id"]), await self._execute(row)))
        return done

    async def _execute(self, row: dict[str, Any]) -> str:
        rid = str(row["request_id"])
        try:
            req = parse_request(
                row, max_cost_ceiling=self._cost_ceiling, max_sessions_ceiling=self._sessions_ceiling, today=self._clock().date()
            )
            if not await self._store.is_active_admin(req.tenant, req.requested_by):
                raise RequestRefused("Quem pediu não é mais administrador ativo deste workspace.")
            outcome = await self._jobs.run(req)
        except RequestRefused as exc:
            await self._store.finish(row, self._id, "FAILED", None, str(exc))
            return "FAILED"
        except Exception as exc:  # the reason shown is the error type only: messages may carry content
            log.warning("request failed", extra={"event": "request_failed", "request_id": rid, "error_type": type(exc).__name__})
            await self._store.finish(row, self._id, "FAILED", None, f"Erro inesperado ({type(exc).__name__}). Veja os logs do executor.")
            return "FAILED"
        await self._store.finish(row, self._id, outcome.status, outcome.result, None)
        return outcome.status


def _table(project: str, dataset: str, table: str) -> str:
    if not _PROJECT.match(project) or not _DATASET.match(dataset):
        raise ValueError("invalid project or dataset")
    return f"`{project}.{dataset}.{table}`"


TENANT = "organization_id = @organization_id AND workspace_id = @workspace_id"
_COLUMNS = (
    "request_id, changed_at, organization_id, workspace_id, kind, status, params, max_cost_usd, estimate_low_usd, estimate_high_usd, "
    "requested_by, requested_at, changed_by, result, error"
)
_LATEST = "QUALIFY ROW_NUMBER() OVER (PARTITION BY request_id ORDER BY changed_at DESC) = 1"


class BigQueryRequestStore:
    """Append-only transitions in run_requests; the latest row per request wins. Every statement is tenant-scoped."""

    def __init__(self, runner: QueryRunner, project: str, config_dataset: str = "conversation_config") -> None:
        self._runner = runner
        self._req = _table(project, config_dataset, "run_requests")
        self._users = _table(project, config_dataset, "app_users")

    async def pending(self, tenant: Tenant, limit: int) -> list[dict[str, Any]]:
        return await self._runner.query(
            "SELECT request_id, organization_id, workspace_id, kind, TO_JSON_STRING(params) AS params, max_cost_usd, requested_by, "
            "requested_at "
            f"FROM {self._req} WHERE {TENANT} AND DATE(requested_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY) "
            f"{_LATEST} AND status = 'REQUESTED' ORDER BY requested_at, request_id LIMIT @limit",
            {**tenant.params(), "limit": limit},
        )

    def _scope(self, row: dict[str, Any]) -> dict[str, Any]:
        return {"organization_id": row["organization_id"], "workspace_id": row["workspace_id"], "request_id": row["request_id"]}

    async def claim(self, row: dict[str, Any], executor_id: str) -> bool:
        """REQUESTED -> RUNNING, guarded inside the statement. True only if this executor's row is now the latest."""
        p = {**self._scope(row), "by": executor_id}
        await self._runner.query(
            f"INSERT INTO {self._req} ({_COLUMNS}) SELECT request_id, CURRENT_TIMESTAMP(), organization_id, workspace_id, kind, "
            "'RUNNING', params, max_cost_usd, estimate_low_usd, estimate_high_usd, requested_by, requested_at, @by, NULL, NULL "
            f"FROM (SELECT * FROM {self._req} WHERE {TENANT} AND request_id = @request_id {_LATEST}) "
            "WHERE status = 'REQUESTED'",
            p,
        )
        now = await self._runner.query(
            f"SELECT status, changed_by FROM {self._req} WHERE {TENANT} AND request_id = @request_id ORDER BY changed_at DESC LIMIT 1",
            self._scope(row),
        )
        return bool(now) and now[0]["status"] == "RUNNING" and now[0]["changed_by"] == executor_id

    async def finish(self, row: dict[str, Any], executor_id: str, status: str, result: dict[str, Any] | None, error: str | None) -> None:
        """RUNNING -> final status, only by the executor that claimed it."""
        p = {
            **self._scope(row),
            "by": executor_id,
            "status": status,
            "error": error,
            "result": json.dumps(result, default=str) if result is not None else None,
        }
        await self._runner.query(
            f"INSERT INTO {self._req} ({_COLUMNS}) SELECT request_id, CURRENT_TIMESTAMP(), organization_id, workspace_id, kind, "
            "@status, params, max_cost_usd, estimate_low_usd, estimate_high_usd, requested_by, requested_at, @by, "
            "IF(@result IS NULL, NULL, PARSE_JSON(@result)), @error "
            f"FROM (SELECT * FROM {self._req} WHERE {TENANT} AND request_id = @request_id {_LATEST}) "
            "WHERE status = 'RUNNING' AND changed_by = @by",
            p,
        )

    async def is_active_admin(self, tenant: Tenant, email: str) -> bool:
        rows = await self._runner.query(
            f"SELECT role, status FROM {self._users} WHERE {TENANT} AND email = @email "
            "QUALIFY ROW_NUMBER() OVER (PARTITION BY email ORDER BY changed_at DESC) = 1",
            {**tenant.params(), "email": email.lower()},
        )
        return bool(rows) and rows[0]["role"] == "ADMIN" and rows[0]["status"] == "ACTIVE"
