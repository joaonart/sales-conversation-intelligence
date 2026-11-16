"""Requests for suggestions on an agent's prompt, made in the console ("Melhorar prompt"), and the executor that carries them out.

Same gates as the execution requests (the table is data, not authority): the model comes from the closed catalog, the ceiling must fit the worker's, the person
who asked must still be an active ADMIN of the workspace, the month's budget must have room, and the worst case of the call, sized on the text that will really
be sent, must fit the ceiling the person approved. ONE call is made, over the prompt and the numbers the console stored with the request (never conversation text).
The text of a prompt that was not kept is deleted when the request ends, however it ends.
"""

from __future__ import annotations

import json
import logging
import math
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, Protocol

from sci_bq.runner import QueryRunner
from sci_bq.source import Tenant
from sci_console_executor.requests import BigQueryRequestStore, Ledger, RequestRefused, ensure_within_monthly_budget, _table
from sci_core.spend import SpendRecorder, record_best_effort, spend_row
from sci_core.suggestion import SYSTEM_TOKENS, Suggester, max_output_tokens
from sci_openai.catalog import CatalogModel, UnknownModel, find
from sci_openai.suggestions import aggregate_text, criterion_ids, prompt_text

log = logging.getLogger("sci.console_executor")  # metadata only: never log message content or prompts

MAX_PERIOD_DAYS = 366
MAX_AGGREGATE_CHARS = 200_000
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_HASH = re.compile(r"^[0-9a-f]{64}$")
TENANT = "organization_id = @organization_id AND workspace_id = @workspace_id"


@dataclass(frozen=True)
class SuggestionRequest:
    request_id: str
    tenant: Tenant
    rubric_id: str
    rubric_version: int
    period_from: date
    period_to: date
    seller_id: str | None
    prompt_id: str
    prompt_hash: str
    max_cost_usd: float
    model: CatalogModel
    requested_by: str
    aggregate: dict[str, Any]  # the numbers the person saw and approved the cost on


def parse_suggestion_request(row: dict[str, Any], *, max_cost_ceiling: float) -> SuggestionRequest:
    """Validates a stored request again: the table is data, not authority."""
    try:
        provider, model = str(row["provider"]), str(row["model"])
        entry = find(provider, model)  # a closed list: a stored request cannot name any other model or price
    except (KeyError, UnknownModel) as exc:
        raise RequestRefused("Modelo fora da lista permitida para esta API.") from exc
    if entry.provider != "responses":
        raise RequestRefused("As sugestões só podem ser escritas pela Responses API.")
    cap = float(row["max_cost_usd"])
    if not 0 < cap <= max_cost_ceiling:
        raise RequestRefused(f"O teto de custo do pedido (US$ {cap}) está fora do limite do worker sob demanda (US$ {max_cost_ceiling}).")
    try:
        start, end = date.fromisoformat(str(row["period_from"])), date.fromisoformat(str(row["period_to"]))
        rubric_id, rubric_version, prompt_id = str(row["rubric_id"]), int(row["rubric_version"]), str(row["prompt_id"])
    except (KeyError, ValueError, TypeError) as exc:
        raise RequestRefused("Parâmetros do pedido inválidos.") from exc
    if end < start or (end - start).days > MAX_PERIOD_DAYS or rubric_version < 1 or not _ID.match(rubric_id) or not _ID.match(prompt_id):
        raise RequestRefused("Parâmetros do pedido inválidos.")
    prompt_hash = str(row.get("prompt_hash") or "")
    if not _HASH.match(prompt_hash):
        raise RequestRefused("Pedido sem a identificação do texto do prompt.")
    raw = row.get("aggregate")
    if raw is None or raw == "null":
        raise RequestRefused("O pedido não traz os números da prévia (foi feito por uma versão anterior do console). Faça o pedido de novo.")
    try:
        aggregate = json.loads(raw) if isinstance(raw, str) else dict(raw)
    except (ValueError, TypeError) as exc:
        raise RequestRefused("Os números do pedido são inválidos.") from exc
    if not isinstance(aggregate, dict) or not criterion_ids(aggregate) or len(aggregate_text(aggregate)) > MAX_AGGREGATE_CHARS:
        raise RequestRefused("Os números do pedido são inválidos.")
    seller = row.get("seller_id")
    return SuggestionRequest(
        request_id=str(row["request_id"]),
        tenant=Tenant(str(row["organization_id"]), str(row["workspace_id"])),
        rubric_id=rubric_id,
        rubric_version=rubric_version,
        period_from=start,
        period_to=end,
        seller_id=None if seller in (None, "") else str(seller),
        prompt_id=prompt_id,
        prompt_hash=prompt_hash,
        max_cost_usd=cap,
        model=entry,
        requested_by=str(row["requested_by"]),
        aggregate=aggregate,
    )


def worst_case_usd(model: CatalogModel, prompt: str, aggregate: dict[str, Any]) -> float:
    """The most the call may cost: the rules, the prompt as it will be sent and the numbers in, the full cap of the output (the dearest rates)."""
    book = model.prices.worst_case_price_book()
    tokens_in = SYSTEM_TOKENS + math.ceil(len(prompt_text(prompt)) / 4) + math.ceil(len(aggregate_text(aggregate)) / 4)
    tokens_out = max_output_tokens(len(criterion_ids(aggregate)))
    return (tokens_in * book.input_per_million + tokens_out * book.output_per_million) / 1e6


class SuggestionStore(Protocol):
    async def pending(self, tenant: Tenant, limit: int) -> list[dict[str, Any]]: ...
    async def claim(self, row: dict[str, Any], executor_id: str) -> bool: ...
    async def finish(self, row: dict[str, Any], executor_id: str, status: str, *, cost_usd: float, version: str | None, error: str | None) -> None: ...
    async def write_result(self, req: SuggestionRequest, *, suggestions: dict[str, Any], model: str, version: str, input_tokens: int, output_tokens: int, cost_usd: float) -> None: ...
    async def read_prompt(self, tenant: Tenant, prompt_id: str, prompt_hash: str) -> str | None: ...
    async def drop_unkept_prompt(self, tenant: Tenant, prompt_id: str) -> None: ...
    async def is_active_admin(self, tenant: Tenant, email: str) -> bool: ...


class SuggestionExecutor:
    def __init__(
        self,
        *,
        store: SuggestionStore,
        suggester_for: Callable[[CatalogModel], Suggester],
        executor_id: str,
        max_cost_ceiling: float,
        recorder: SpendRecorder | None = None,
        ledger: Ledger | None = None,
        monthly_budget_usd: float = 0.0,
        clock: Any = lambda: datetime.now(UTC),
    ) -> None:
        self._store, self._suggester_for, self._id = store, suggester_for, executor_id
        self._ceiling, self._recorder, self._ledger, self._budget, self._clock = max_cost_ceiling, recorder, ledger, monthly_budget_usd, clock

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
            try:
                done.append((str(row["request_id"]), await self._execute(row)))
            finally:  # however it ended, the text of a prompt that was not kept has no reason to stay
                await self._drop_prompt(row)
        return done

    async def _drop_prompt(self, row: dict[str, Any]) -> None:
        try:
            await self._store.drop_unkept_prompt(Tenant(str(row["organization_id"]), str(row["workspace_id"])), str(row["prompt_id"]))
        except Exception as exc:  # noqa: BLE001  (the workspace cleaner removes a leftover; the request's own outcome is already recorded)
            log.warning("prompt cleanup failed", extra={"event": "prompt_cleanup_failed", "request_id": str(row.get("request_id")), "error_type": type(exc).__name__})

    async def _execute(self, row: dict[str, Any]) -> str:
        rid = str(row["request_id"])
        spent = 0.0  # what the call cost, kept on the request even when something after the call goes wrong
        version: str | None = None
        try:
            req = parse_suggestion_request(row, max_cost_ceiling=self._ceiling)
            if not await self._store.is_active_admin(req.tenant, req.requested_by):
                raise RequestRefused("Quem pediu não é mais administrador ativo deste workspace.")
            await ensure_within_monthly_budget(self._ledger, self._budget, req.tenant, req.max_cost_usd, self._clock().date())
            text = await self._store.read_prompt(req.tenant, req.prompt_id, req.prompt_hash)
            if text is None:
                raise RequestRefused("O texto do prompt não está mais disponível. Faça o pedido de novo.")
            worst = worst_case_usd(req.model, text, req.aggregate)
            if worst > req.max_cost_usd:
                raise RequestRefused(f"Pré-voo não aprovado: o custo máximo da chamada é US$ {worst:.5f} e o teto do pedido é US$ {req.max_cost_usd}.")
            suggester = self._suggester_for(req.model)
            version = suggester.version
            result = await suggester.suggest(prompt=text, aggregate=req.aggregate)
            spent = result.usage.estimated_cost_usd
            if result.usage.input_tokens or result.usage.output_tokens:  # recorded the moment the provider answered, before anything is stored
                await record_best_effort(
                    self._recorder,
                    spend_row(
                        kind="SUGGESTION", organization_id=req.tenant.organization_id, workspace_id=req.tenant.workspace_id, session_id=None, subject_id=req.request_id,
                        mode="suggestion", model=suggester.model, input_tokens=result.usage.input_tokens, output_tokens=result.usage.output_tokens, cost_usd=spent,
                    ),
                )
            if result.suggestions is None:
                await self._store.finish(
                    row, self._id, "FAILED", cost_usd=spent, version=version,
                    error=f"A IA não devolveu sugestões utilizáveis ({result.error}). Se houve resposta, o custo foi registrado. Tente de novo.",
                )
                return "FAILED"
            await self._store.write_result(
                req, suggestions=result.suggestions.model_dump(), model=suggester.model, version=version,
                input_tokens=result.usage.input_tokens, output_tokens=result.usage.output_tokens, cost_usd=spent,
            )
        except RequestRefused as exc:
            await self._store.finish(row, self._id, "FAILED", cost_usd=spent, version=version, error=str(exc))
            return "FAILED"
        except Exception as exc:  # the reason shown is the error type only: messages may carry content
            log.warning("suggestion request failed", extra={"event": "suggestion_request_failed", "request_id": rid, "error_type": type(exc).__name__})
            await self._store.finish(row, self._id, "FAILED", cost_usd=spent, version=version, error=f"Erro inesperado ({type(exc).__name__}). Veja os logs do worker sob demanda.")
            return "FAILED"
        await self._store.finish(row, self._id, "COMPLETED", cost_usd=spent, version=version, error=None)
        return "COMPLETED"


_REQ_COLUMNS = (
    "request_id, changed_at, organization_id, workspace_id, status, rubric_id, rubric_version, period_from, period_to, seller_id, prompt_id, prompt_hash, "
    "sample_analyses, sample_sessions, max_cost_usd, estimate_low_usd, estimate_high_usd, actual_cost_usd, provider, model, system_prompt_version, "
    "requested_by, requested_at, changed_by, error, aggregate"
)
_LATEST = "QUALIFY ROW_NUMBER() OVER (PARTITION BY request_id ORDER BY changed_at DESC) = 1"


class BigQuerySuggestionStore:
    """Append-only transitions in prompt_improvement_requests; the latest row per request wins. Every statement is tenant-scoped. The text of a prompt is
    read by (prompt, hash) and never logged."""

    def __init__(self, runner: QueryRunner, project: str, config_dataset: str = "conversation_config") -> None:
        self._runner = runner
        self._req = _table(project, config_dataset, "prompt_improvement_requests")
        self._prompts = _table(project, config_dataset, "agent_prompts")
        self._results = _table(project, config_dataset, "prompt_improvement_results")
        self._admins = BigQueryRequestStore(runner, project, config_dataset)  # who is an active ADMIN is answered by the same rule

    @staticmethod
    def _scope(row: dict[str, Any]) -> dict[str, Any]:
        return {"organization_id": row["organization_id"], "workspace_id": row["workspace_id"], "request_id": row["request_id"]}

    async def pending(self, tenant: Tenant, limit: int) -> list[dict[str, Any]]:
        return await self._runner.query(
            "SELECT request_id, organization_id, workspace_id, rubric_id, rubric_version, CAST(period_from AS STRING) AS period_from, CAST(period_to AS STRING) AS period_to, "
            "seller_id, prompt_id, prompt_hash, max_cost_usd, provider, model, requested_by, requested_at, TO_JSON_STRING(aggregate) AS aggregate "
            f"FROM {self._req} WHERE {TENANT} AND DATE(requested_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY) "
            f"{_LATEST} AND status = 'REQUESTED' ORDER BY requested_at, request_id LIMIT @limit",
            {**tenant.params(), "limit": limit},
        )

    async def claim(self, row: dict[str, Any], executor_id: str) -> bool:
        """REQUESTED -> RUNNING, guarded inside the statement. True only if this executor's row is now the latest."""
        await self._runner.query(
            f"INSERT INTO {self._req} ({_REQ_COLUMNS}) SELECT request_id, CURRENT_TIMESTAMP(), organization_id, workspace_id, 'RUNNING', rubric_id, rubric_version, "
            "period_from, period_to, seller_id, prompt_id, prompt_hash, sample_analyses, sample_sessions, max_cost_usd, estimate_low_usd, estimate_high_usd, "
            "actual_cost_usd, provider, model, system_prompt_version, requested_by, requested_at, @by, NULL, aggregate "
            f"FROM (SELECT * FROM {self._req} WHERE {TENANT} AND request_id = @request_id {_LATEST}) WHERE status = 'REQUESTED'",
            {**self._scope(row), "by": executor_id},
        )
        now = await self._runner.query(
            f"SELECT status, changed_by FROM {self._req} WHERE {TENANT} AND request_id = @request_id ORDER BY changed_at DESC LIMIT 1", self._scope(row)
        )
        return bool(now) and now[0]["status"] == "RUNNING" and now[0]["changed_by"] == executor_id

    async def finish(self, row: dict[str, Any], executor_id: str, status: str, *, cost_usd: float, version: str | None, error: str | None) -> None:
        """RUNNING -> final status, only by the executor that claimed it; it keeps what the call cost."""
        await self._runner.query(
            f"INSERT INTO {self._req} ({_REQ_COLUMNS}) SELECT request_id, CURRENT_TIMESTAMP(), organization_id, workspace_id, @status, rubric_id, rubric_version, "
            "period_from, period_to, seller_id, prompt_id, prompt_hash, sample_analyses, sample_sessions, max_cost_usd, estimate_low_usd, estimate_high_usd, "
            "@cost, provider, model, @version, requested_by, requested_at, @by, @error, aggregate "
            f"FROM (SELECT * FROM {self._req} WHERE {TENANT} AND request_id = @request_id {_LATEST}) WHERE status = 'RUNNING' AND changed_by = @by",
            {**self._scope(row), "by": executor_id, "status": status, "cost": float(cost_usd), "version": version, "error": error},
        )

    async def write_result(
        self, req: SuggestionRequest, *, suggestions: dict[str, Any], model: str, version: str, input_tokens: int, output_tokens: int, cost_usd: float
    ) -> None:
        await self._runner.query(
            f"INSERT INTO {self._results} (request_id, organization_id, workspace_id, created_at, aggregate, suggestions, model, system_prompt_version, input_tokens, "
            "output_tokens, cost_usd) VALUES (@request_id, @organization_id, @workspace_id, CURRENT_TIMESTAMP(), PARSE_JSON(@aggregate), PARSE_JSON(@suggestions), "
            "@model, @version, @input_tokens, @output_tokens, @cost)",
            {
                "request_id": req.request_id, **req.tenant.params(), "aggregate": json.dumps(req.aggregate, ensure_ascii=False),
                "suggestions": json.dumps(suggestions, ensure_ascii=False), "model": model, "version": version, "input_tokens": input_tokens,
                "output_tokens": output_tokens, "cost": float(cost_usd),
            },
        )

    async def read_prompt(self, tenant: Tenant, prompt_id: str, prompt_hash: str) -> str | None:
        rows = await self._runner.query(
            f"SELECT content FROM {self._prompts} WHERE {TENANT} AND prompt_id = @prompt_id AND content_hash = @hash LIMIT 1",
            {**tenant.params(), "prompt_id": prompt_id, "hash": prompt_hash},
        )
        return str(rows[0]["content"]) if rows else None

    async def drop_unkept_prompt(self, tenant: Tenant, prompt_id: str) -> None:
        """Only a prompt that was not kept: a kept one is never deleted, whatever the id."""
        await self._runner.query(
            f"DELETE FROM {self._prompts} WHERE {TENANT} AND prompt_id = @prompt_id AND NOT retained", {**tenant.params(), "prompt_id": prompt_id}
        )

    async def is_active_admin(self, tenant: Tenant, email: str) -> bool:
        return await self._admins.is_active_admin(tenant, email)
