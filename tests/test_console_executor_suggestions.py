"""The executor of requests for suggestions on an agent's prompt: it re-validates the stored request, applies the same gates as an execution, makes ONE call over the prompt
and the numbers the person approved, records the spend the moment the provider answers, and deletes the text of a prompt that was not kept however the request ends."""
import hashlib
import json
from datetime import UTC, date, datetime

import pytest

from sci_bq.source import Tenant
from sci_console_executor.requests import RequestRefused
from sci_console_executor.suggestions import BigQuerySuggestionStore, SuggestionExecutor, parse_suggestion_request, worst_case_usd
from sci_core.provider import ProviderUsage
from sci_core.suggestion import CriterionSuggestion, SuggestionResult, Suggestions, max_output_tokens
from sci_openai.catalog import find
from sci_openai.suggestions import aggregate_text, prompt_text, prompt_tokens
from tests.duck import DuckBQ, DuckRunner

T = Tenant("orgA", "ws1")
TB = Tenant("orgB", "ws1")
NOW = datetime(2026, 11, 16, 12, tzinfo=UTC)
D0 = datetime(2026, 11, 16, 10, tzinfo=UTC)
TEXT = "Você vende calçados. Cumprimente o cliente. Fale com ana@loja.com se precisar."
HASH = hashlib.sha256(TEXT.encode()).hexdigest()
AGG = {
    "rubric": {"name": "Qualidade", "version": 5}, "period": {"from": "2026-10-01", "to": "2026-10-31"}, "seller_filter": False,
    "sample": {"analyses": 40, "sessions": 38},
    "criteria": [{"criterion_id": "needs", "name": "Necessidade", "weight": 25, "points_lost": 15.2, "weak_pct": 66.7, "applicable": 36, "answers": [{"answer": "none", "n": 14}]},
                 {"criterion_id": "greeting", "name": "Saudação", "weight": 10, "points_lost": 2.1, "weak_pct": 5, "applicable": 20, "answers": []}],
}
GPT4O = find("responses", "gpt-4o")


def stored(request_id="pir-1", status="REQUESTED", tenant=T, by="ana@x.com", aggregate=AGG, cap=0.1, provider="responses", model="gpt-4o", prompt_id="pr-1", prompt_hash=HASH, changed_by=None):
    return dict(
        request_id=request_id, changed_at=D0, organization_id=tenant.organization_id, workspace_id=tenant.workspace_id, status=status, rubric_id="sales_quality", rubric_version=5,
        period_from=date(2026, 10, 1), period_to=date(2026, 10, 31), seller_id=None, prompt_id=prompt_id, prompt_hash=prompt_hash, sample_analyses=40, sample_sessions=38,
        max_cost_usd=cap, estimate_low_usd=0.004, estimate_high_usd=0.03, actual_cost_usd=None, provider=provider, model=model, system_prompt_version=None,
        requested_by=by, requested_at=D0, changed_by=changed_by or by, error=None, aggregate=None if aggregate is None else (aggregate if isinstance(aggregate, str) else json.dumps(aggregate)),
    )


def pending(**kw):
    r = stored(**kw)
    out = {k: r[k] for k in ("request_id", "organization_id", "workspace_id", "rubric_id", "rubric_version", "seller_id", "prompt_id", "prompt_hash", "max_cost_usd", "provider", "model", "requested_by", "requested_at", "aggregate")}
    return {**out, "period_from": "2026-10-01", "period_to": "2026-10-31"}


# ---------- validation: the table is data, not authority ----------
def test_a_valid_stored_request_parses_into_what_the_executor_works_with():
    req = parse_suggestion_request(pending(), max_cost_ceiling=0.1)
    assert (req.request_id, req.tenant, req.rubric_id, req.rubric_version, req.prompt_id, req.prompt_hash) == ("pir-1", T, "sales_quality", 5, "pr-1", HASH)
    assert (req.period_from, req.period_to, req.seller_id, req.max_cost_usd, req.model.model, req.requested_by) == (date(2026, 10, 1), date(2026, 10, 31), None, 0.1, "gpt-4o", "ana@x.com")
    assert req.aggregate == AGG


@pytest.mark.parametrize(
    "over",
    [
        {"model": "gpt-9"}, {"provider": "decisions", "model": "gpt-6-luna"}, {"provider": "nope"},  # only a model of the closed catalog, and only the Responses API
        {"max_cost_usd": 5.0}, {"max_cost_usd": 0}, {"max_cost_usd": -1},
        {"period_from": "2026-10-31", "period_to": "2026-10-01"}, {"period_from": "2024-01-01"}, {"period_from": "abc"},
        {"rubric_version": 0}, {"rubric_id": "../x"}, {"prompt_id": "a b"},
        {"prompt_hash": "abc"}, {"prompt_hash": ""}, {"prompt_hash": "Z" * 64},
        {"aggregate": None}, {"aggregate": "null"}, {"aggregate": "not json"}, {"aggregate": "[]"}, {"aggregate": '{"criteria": []}'}, {"aggregate": '{"criteria": [{"nope": 1}]}'},
        {"aggregate": json.dumps({"criteria": [{"criterion_id": "a", "x": "y" * 250_000}]})},
    ],
)
def test_invalid_or_forged_stored_requests_are_refused(over):
    with pytest.raises(RequestRefused):
        parse_suggestion_request({**pending(), **over}, max_cost_ceiling=0.1)


def test_a_request_made_before_the_numbers_were_stored_with_it_says_to_ask_again():
    with pytest.raises(RequestRefused, match="Faça o pedido de novo"):
        parse_suggestion_request({**pending(), "aggregate": None}, max_cost_ceiling=0.1)


def test_the_worst_case_is_sized_on_the_text_that_will_really_be_sent_at_the_dearest_rates():
    worst = worst_case_usd(GPT4O, TEXT, AGG)
    sent = prompt_tokens(prompt_text(TEXT))
    tokens_in = 900 + sent + -(-len(aggregate_text(AGG)) // 4)
    book = GPT4O.prices.worst_case_price_book()
    # the output includes room for the whole improved prompt, so a longer prompt costs more on the way out too
    assert worst == pytest.approx((tokens_in * book.input_per_million + max_output_tokens(2, sent) * book.output_per_million) / 1e6)
    assert worst_case_usd(GPT4O, TEXT * 50, AGG) > worst  # a longer prompt costs more
    assert worst_case_usd(find("responses", "gpt-4o-mini"), TEXT, AGG) < worst  # a cheaper model costs less


# ---------- the executor ----------
class Suggester:
    version = "responses-suggestion-v1"
    model = "gpt-4o"

    def __init__(self, result=None, boom=None):
        self.calls, self._result, self._boom = [], result, boom

    async def suggest(self, *, prompt, aggregate):
        self.calls.append((prompt, aggregate))
        if self._boom:
            raise self._boom
        return self._result or SuggestionResult(
            suggestions=Suggestions(overall="Foque na necessidade.", priorities=["needs"], criteria=[CriterionSuggestion(criterion_id="needs", diagnosis="66,7% fracas.", changes=[])]),
            usage=ProviderUsage(input_tokens=1700, output_tokens=900, estimated_cost_usd=0.01325),
        )


class MemStore:
    def __init__(self, rows, texts=None, admins=("ana@x.com",), fail_drop=False):
        self.rows, self.texts, self.admins, self.fail_drop = list(rows), {("pr-1", HASH): TEXT} if texts is None else texts, set(admins), fail_drop
        self.claimed, self.finished, self.results, self.dropped, self.lost = [], [], [], [], set()

    async def pending(self, tenant, limit):
        return [r for r in self.rows if (r["organization_id"], r["workspace_id"]) == (tenant.organization_id, tenant.workspace_id)][:limit]

    async def claim(self, row, executor_id):
        if row["request_id"] in self.lost:
            return False
        self.claimed.append(row["request_id"])
        return True

    async def finish(self, row, executor_id, status, *, cost_usd, version, error):
        self.finished.append((row["request_id"], status, cost_usd, version, error))

    async def write_result(self, req, *, suggestions, model, version, input_tokens, output_tokens, cost_usd):
        self.results.append((req.request_id, suggestions, model, version, input_tokens, output_tokens, cost_usd, req.aggregate))

    async def read_prompt(self, tenant, prompt_id, prompt_hash):
        return self.texts.get((prompt_id, prompt_hash))

    async def drop_unkept_prompt(self, tenant, prompt_id):
        if self.fail_drop:
            raise RuntimeError("bq down")
        self.dropped.append(prompt_id)

    async def is_active_admin(self, tenant, email):
        return email in self.admins


class Spend:
    def __init__(self, fail=False):
        self.rows, self.fail = [], fail

    async def record(self, row):
        if self.fail:
            raise RuntimeError("no")
        self.rows.append(row)


class Ledger:
    def __init__(self, spent):
        self.spent = spent

    async def month_to_date_usd(self, tenant, month_start):
        assert month_start == date(2026, 11, 1)
        return self.spent


def executor(store, suggester=None, **kw):
    s = suggester or Suggester()
    return SuggestionExecutor(store=store, suggester_for=lambda entry: s, executor_id="ex-1", max_cost_ceiling=0.1, clock=lambda: NOW, **kw), s


async def run(ex, tenants=(T,), limit=3):
    return await ex.run_once(list(tenants), limit)


async def test_a_valid_request_is_written_charged_and_completed_and_the_unkept_text_goes_away():
    store, spend = MemStore([pending()]), Spend()
    ex, s = executor(store, recorder=spend, ledger=Ledger(0.0), monthly_budget_usd=1.0)
    assert await run(ex) == [("pir-1", "COMPLETED")]
    assert s.calls == [(TEXT, AGG)]  # the prompt as stored and the numbers as the console stored them: nothing else
    assert store.finished == [("pir-1", "COMPLETED", 0.01325, "responses-suggestion-v1", None)]
    (rid, suggestions, model, version, tin, tout, cost, aggregate) = store.results[0]
    assert (rid, model, version, tin, tout, cost, aggregate) == ("pir-1", "gpt-4o", "responses-suggestion-v1", 1700, 900, 0.01325, AGG)
    assert suggestions["overall"] == "Foque na necessidade." and suggestions["criteria"][0]["criterion_id"] == "needs"
    (paid,) = spend.rows  # the spend is recorded as its own line, a new kind, with no text
    assert (paid["kind"], paid["subject_id"], paid["model"], paid["input_tokens"], paid["output_tokens"], paid["cost_usd"], paid["session_id"]) == ("SUGGESTION", "pir-1", "gpt-4o", 1700, 900, 0.01325, None)
    assert TEXT not in json.dumps(paid) and "Cumprimente" not in json.dumps(paid)
    assert store.dropped == ["pr-1"]


async def test_the_result_is_stored_before_the_request_is_marked_completed():
    order = []
    store = MemStore([pending()])
    write, finish = store.write_result, store.finish
    store.write_result = lambda *a, **k: (order.append("result"), write(*a, **k))[1]
    store.finish = lambda *a, **k: (order.append("finish"), finish(*a, **k))[1]
    await run(executor(store)[0])
    assert order == ["result", "finish"]


async def test_a_request_that_was_taken_or_cancelled_meanwhile_is_skipped_and_nothing_is_touched():
    store = MemStore([pending()])
    store.lost.add("pir-1")
    ex, s = executor(store)
    assert await run(ex) == []
    assert not s.calls and not store.finished and not store.dropped  # not ours: nothing to finish, no text to delete


@pytest.mark.parametrize("admins", [(), ("edu@x.com",)])
async def test_a_requester_who_is_no_longer_an_admin_is_refused_and_no_call_is_made(admins):
    store = MemStore([pending()], admins=admins)
    ex, s = executor(store)
    assert await run(ex) == [("pir-1", "FAILED")]
    assert not s.calls and "administrador" in store.finished[0][4]
    assert store.dropped == ["pr-1"]  # it ended, so the unkept text goes


async def test_a_month_without_room_refuses_with_the_numbers_and_no_call_is_made():
    store = MemStore([pending(cap=0.1)])
    ex, s = executor(store, ledger=Ledger(0.95), monthly_budget_usd=1.0)
    assert await run(ex) == [("pir-1", "FAILED")]
    assert not s.calls and "teto mensal" in store.finished[0][4] and "US$ 0.9500" in store.finished[0][4]


async def test_a_prompt_whose_text_is_gone_or_changed_is_refused():
    for texts in ({}, {("pr-1", "0" * 64): TEXT}):
        store = MemStore([pending()], texts=texts)
        ex, s = executor(store)
        assert await run(ex) == [("pir-1", "FAILED")]
        assert not s.calls and "texto do prompt" in store.finished[0][4]


async def test_a_ceiling_below_the_worst_case_of_the_real_text_is_refused_before_the_call():
    store = MemStore([pending(cap=0.0001)])
    ex, s = executor(store)
    assert await run(ex) == [("pir-1", "FAILED")]
    assert not s.calls and "Pré-voo não aprovado" in store.finished[0][4]


async def test_an_answer_that_cannot_be_used_fails_the_request_keeps_the_charge_and_stores_no_result():
    bad = SuggestionResult(error="Refusal", usage=ProviderUsage(input_tokens=1700, output_tokens=20, estimated_cost_usd=0.0044))
    store, spend = MemStore([pending()]), Spend()
    ex, _ = executor(store, Suggester(result=bad), recorder=spend)
    assert await run(ex) == [("pir-1", "FAILED")]
    assert not store.results and spend.rows[0]["cost_usd"] == 0.0044  # answered, so charged and on the ledger
    (_, status, cost, _, error) = store.finished[0]
    assert (status, cost) == ("FAILED", 0.0044) and "Refusal" in error and "custo foi registrado" in error
    assert store.dropped == ["pr-1"]


async def test_a_call_that_got_no_answer_costs_nothing_and_is_not_on_the_ledger():
    nothing = SuggestionResult(error="ProviderUnavailable", usage=ProviderUsage())
    store, spend = MemStore([pending()]), Spend()
    ex, _ = executor(store, Suggester(result=nothing), recorder=spend)
    assert await run(ex) == [("pir-1", "FAILED")]
    assert spend.rows == [] and store.finished[0][2] == 0.0


async def test_an_unexpected_error_shows_only_its_type_and_keeps_what_the_call_cost():
    store = MemStore([pending()])
    store.write_result = None  # the call is paid, then storing the result breaks
    async def broken(*_a, **_k):
        raise ValueError("secret text of the prompt")
    store.write_result = broken
    ex, _ = executor(store, recorder=Spend())
    assert await run(ex) == [("pir-1", "FAILED")]
    (_, status, cost, _, error) = store.finished[0]
    assert status == "FAILED" and cost == 0.01325  # the charge is not lost with the result
    assert "ValueError" in error and "secret" not in error
    assert store.dropped == ["pr-1"]


async def test_the_unexpected_error_of_the_provider_call_shows_only_its_type():
    store = MemStore([pending()])
    ex, _ = executor(store, Suggester(boom=RuntimeError("the prompt says: ana@loja.com")))
    assert await run(ex) == [("pir-1", "FAILED")]
    assert "RuntimeError" in store.finished[0][4] and "ana@loja.com" not in store.finished[0][4]


async def test_a_spend_that_cannot_be_recorded_does_not_lose_the_answer_that_was_paid_for():
    store = MemStore([pending()])
    ex, _ = executor(store, recorder=Spend(fail=True))
    assert await run(ex) == [("pir-1", "COMPLETED")] and store.results


async def test_a_failure_to_delete_the_text_does_not_change_the_outcome_of_the_request():
    store = MemStore([pending()], fail_drop=True)
    ex, _ = executor(store)
    assert await run(ex) == [("pir-1", "COMPLETED")]


async def test_only_the_named_tenants_are_served_and_the_limit_bounds_the_invocation():
    store = MemStore([pending(request_id="a"), pending(request_id="b"), pending(request_id="c"), pending(request_id="x", tenant=TB)])
    ex, _ = executor(store)
    assert [r for r, _ in await run(ex, limit=2)] == ["a", "b"]
    assert "x" not in store.claimed


# ---------- the store: the real statements, on real DDL (DuckDB), tenant-scoped ----------
@pytest.fixture
def env():
    db = DuckBQ()
    db.insert("prompt_improvement_requests", [stored("r1"), stored("r2", tenant=TB), stored("r3", status="CANCELLED", changed_by="ana@x.com"), stored("r4", aggregate=None)])
    base = dict(version=1, name="Loja", content=TEXT, content_hash=HASH, created_by="ana@x.com", created_at=D0)
    db.insert("agent_prompts", [
        dict(prompt_id="pr-1", organization_id="orgA", workspace_id="ws1", retained=False, **base),
        dict(prompt_id="pr-kept", organization_id="orgA", workspace_id="ws1", retained=True, **base),
        dict(prompt_id="pr-1", organization_id="orgB", workspace_id="ws1", retained=False, **base),
    ])
    db.insert("app_users", [dict(organization_id="orgA", workspace_id="ws1", email="ana@x.com", role="ADMIN", status="ACTIVE", changed_at=D0, changed_by="boot")])
    runner = DuckRunner(db)
    return db, runner, BigQuerySuggestionStore(runner, "my-proj-123")


async def test_pending_returns_only_waiting_requests_of_the_tenant_with_their_numbers(env):
    _, _, store = env
    rows = await store.pending(T, 10)
    assert [r["request_id"] for r in rows] == ["r1", "r4"]  # r3 is cancelled, r2 belongs to orgB
    assert (rows[0]["period_from"], rows[0]["period_to"]) == ("2026-10-01", "2026-10-31")
    assert json.loads(json.loads(rows[0]["aggregate"])) == AGG  # DuckDB keeps JSON as text, so TO_JSON_STRING quotes it; BigQuery returns the JSON itself
    assert [r["request_id"] for r in await store.pending(TB, 10)] == ["r2"]


async def test_claim_then_finish_follow_the_state_machine_keep_the_numbers_and_record_the_cost(env):
    db, _, store = env
    r1 = (await store.pending(T, 10))[0]
    assert await store.claim(r1, "ex-1") is True
    assert [r["request_id"] for r in await store.pending(T, 10)] == ["r4"]  # RUNNING is no longer waiting
    assert await store.claim(r1, "ex-2") is False
    await store.finish(r1, "ex-2", "COMPLETED", cost_usd=0.5, version="v", error=None)  # only the claimer may finish
    assert db.rows("SELECT status FROM prompt_improvement_requests WHERE request_id = 'r1' ORDER BY changed_at DESC, status DESC")[0]["status"] == "RUNNING"
    await store.finish(r1, "ex-1", "COMPLETED", cost_usd=0.01325, version="responses-suggestion-v1", error=None)
    (done,) = db.rows("SELECT status, changed_by, actual_cost_usd, system_prompt_version, error, aggregate, prompt_hash, max_cost_usd FROM prompt_improvement_requests WHERE request_id = 'r1' AND status = 'COMPLETED'")
    assert (done["changed_by"], done["actual_cost_usd"], done["system_prompt_version"], done["error"], done["prompt_hash"], done["max_cost_usd"]) == ("ex-1", 0.01325, "responses-suggestion-v1", None, HASH, 0.1)
    assert json.loads(done["aggregate"]) == AGG  # every row of a request carries the numbers that were approved


async def test_a_cancelled_request_cannot_be_claimed(env):
    _, _, store = env
    assert await store.claim(pending(request_id="r3"), "ex-1") is False


async def test_the_result_is_stored_with_the_numbers_that_were_sent(env):
    db, _, store = env
    req = parse_suggestion_request(pending(), max_cost_ceiling=0.1)
    await store.write_result(req, suggestions={"overall": "x", "priorities": [], "criteria": []}, model="gpt-4o", version="v1", input_tokens=10, output_tokens=5, cost_usd=0.001)
    (res,) = db.rows("SELECT * FROM prompt_improvement_results")
    assert (res["request_id"], res["organization_id"], res["workspace_id"], res["model"], res["system_prompt_version"], res["input_tokens"], res["output_tokens"], res["cost_usd"]) == ("pir-1", "orgA", "ws1", "gpt-4o", "v1", 10, 5, 0.001)
    assert json.loads(res["aggregate"]) == AGG and json.loads(res["suggestions"])["overall"] == "x"


async def test_the_text_is_read_by_prompt_and_hash_of_the_tenant_only(env):
    _, _, store = env
    assert await store.read_prompt(T, "pr-1", HASH) == TEXT
    assert await store.read_prompt(T, "pr-1", "0" * 64) is None  # another text under the same id is not the text that was approved
    assert await store.read_prompt(T, "nope", HASH) is None
    assert await store.read_prompt(Tenant("orgC", "ws1"), "pr-1", HASH) is None


async def test_only_a_prompt_that_was_not_kept_is_deleted_and_only_in_its_workspace(env):
    db, _, store = env
    await store.drop_unkept_prompt(T, "pr-kept")  # kept: untouched, whatever the id
    assert db.rows("SELECT COUNT(*) AS n FROM agent_prompts WHERE prompt_id = 'pr-kept'")[0]["n"] == 1
    await store.drop_unkept_prompt(T, "pr-1")
    assert db.rows("SELECT organization_id FROM agent_prompts WHERE prompt_id = 'pr-1'") == [{"organization_id": "orgB"}]  # orgB's own is not ours to delete


async def test_the_admin_check_is_the_executions_own_rule(env):
    _, _, store = env
    assert await store.is_active_admin(T, "ana@x.com") is True and await store.is_active_admin(TB, "ana@x.com") is False


async def test_every_statement_is_tenant_scoped(env):
    _, runner, store = env
    r1 = (await store.pending(T, 10))[0]
    await store.claim(r1, "ex-1")
    await store.finish(r1, "ex-1", "FAILED", cost_usd=0.0, version=None, error="x")
    await store.write_result(parse_suggestion_request(pending(), max_cost_ceiling=0.1), suggestions={}, model="m", version="v", input_tokens=1, output_tokens=1, cost_usd=0.0)
    await store.read_prompt(T, "pr-1", HASH)
    await store.drop_unkept_prompt(T, "pr-1")
    await store.is_active_admin(T, "ana@x.com")
    inserts_values = [q for q, _ in runner.queries if "VALUES" in q]  # the result row carries its tenant as parameters of its own
    assert inserts_values and all("@organization_id" in q and "@workspace_id" in q for q in inserts_values)
    assert all("organization_id = @organization_id AND workspace_id = @workspace_id" in q for q, _ in runner.queries if "VALUES" not in q)
