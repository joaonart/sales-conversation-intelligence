"""Every paid call is recorded when the provider answers, and the monthly cap reads that record (not only the analyses that were stored)."""
import json
from datetime import UTC, datetime

import pytest

from sci_bq import queries
from sci_bq.source import Tenant
from sci_bq.spend import BigQuerySpendRecorder, SpendRecordError
from sci_bq.tables import Tables
from sci_core.engine import EvaluationEngine
from sci_core.provider import AnswerState, ProviderAnswer, ProviderResponse, ProviderUsage
from sci_core.routing import ROUTE_CRITERION_ID, RoutingConfig, SessionRouter
from sci_core.rubric import Rubric
from tests.duck import DuckBQ
from tests.test_routing import CFG, msgs  # noqa: F401  (the routing fixtures)
from tests.test_routing import FakeProvider as RouteProvider

NOW = datetime(2026, 11, 1, 13, 0, tzinfo=UTC)
T = Tables("proj-123456")
SECRET = "texto-privado-do-cliente-998877"


class Provider:
    model, prompt_version = "fake-model", "p1"

    def __init__(self, cost=0.00015, boom=False):
        self.cost, self.boom, self.calls = cost, boom, 0

    async def evaluate(self, text, criteria):
        self.calls += 1
        if self.boom:
            raise RuntimeError("provider down")
        answers = [ProviderAnswer(criterion_id=c.criterion_id, state=AnswerState.INSUFFICIENT_EVIDENCE) for c in criteria]
        return ProviderResponse(answers=answers, usage=ProviderUsage(input_tokens=1500, output_tokens=0, estimated_cost_usd=self.cost))


class Recorder:
    def __init__(self, fail=False):
        self.rows, self.fail = [], fail

    async def record(self, row):
        if self.fail:
            raise SpendRecordError("bigquery down")
        self.rows.append(row)


async def evaluate(rubric_json, session, recorder, provider=None):
    e = EvaluationEngine(provider or Provider(), mode="live", clock=lambda: NOW, recorder=recorder)
    return await e.evaluate(organization_id="demo", workspace_id="default", session_id="s001", messages=session["messages"],
                            rubric=Rubric.model_validate(rubric_json))


# ---- the engine ----
async def test_a_paid_call_is_recorded_with_the_analysis_id_the_cost_and_no_message_text(rubric_json, session):
    rec = Recorder()
    ev = await evaluate(rubric_json, session, rec)
    (row,) = rec.rows
    assert (row["kind"], row["mode"], row["model"], row["session_id"], row["subject_id"]) == ("ANALYSIS", "live", "fake-model", "s001", ev.analysis_id)
    assert row["cost_usd"] == 0.00015 and row["input_tokens"] == 1500 and row["organization_id"] == "demo" and row["workspace_id"] == "default"
    assert row["spend_id"].startswith("analysis-") and row["occurred_at"] == NOW.isoformat()
    assert set(row) == {"spend_id", "organization_id", "workspace_id", "session_id", "kind", "subject_id", "mode", "model", "input_tokens",
                        "output_tokens", "cost_usd", "occurred_at"}  # ids, model, tokens, cost: never content
    assert SECRET not in json.dumps(row)


async def test_two_paid_calls_for_the_same_analysis_are_two_rows_because_both_were_paid(rubric_json, session):
    rec = Recorder()
    a, b = await evaluate(rubric_json, session, rec), await evaluate(rubric_json, session, rec)
    assert a.analysis_id == b.analysis_id and len(rec.rows) == 2 and rec.rows[0]["spend_id"] != rec.rows[1]["spend_id"]
    assert rec.rows[0]["subject_id"] == rec.rows[1]["subject_id"]


async def test_a_failure_to_record_never_loses_the_answer_that_was_already_paid_for(rubric_json, session, caplog):
    with caplog.at_level("ERROR"):
        ev = await evaluate(rubric_json, session, Recorder(fail=True))
    assert ev.analysis_id and ev.estimated_cost_usd == 0.00015  # the evaluation is returned
    assert "spend not recorded" in caplog.text


async def test_nothing_is_recorded_when_no_call_was_made(rubric_json, session):
    """Below the minimum evidence the engine abstains without calling the provider: no spend."""
    rj = {**rubric_json, "policy": {**rubric_json["policy"], "min_messages": 999}}
    rec, p = Recorder(), Provider()
    await evaluate(rj, session, rec, p)
    assert p.calls == 0 and rec.rows == []


async def test_a_call_that_fails_before_an_answer_records_nothing(rubric_json, session):
    rec = Recorder()
    with pytest.raises(RuntimeError):
        await evaluate(rubric_json, session, rec, Provider(boom=True))
    assert rec.rows == []  # no answer, nothing was charged


async def test_the_recorder_is_optional(rubric_json, session):
    assert (await evaluate(rubric_json, session, None)).analysis_id


# ---- the router ----
async def test_a_routing_call_is_recorded_when_it_is_known_for_whom():
    rec = Recorder()
    await SessionRouter(RouteProvider("after_sales"), CFG, recorder=rec).classify(msgs(3), organization_id="o", workspace_id="w", session_id="s1")
    (row,) = rec.rows
    assert (row["kind"], row["mode"], row["session_id"], row["subject_id"], row["cost_usd"]) == ("ROUTING", "routing", "s1", "s1", 0.0004)
    await SessionRouter(RouteProvider("sales"), CFG, recorder=rec).classify(msgs(3))  # no tenant given: nothing to attribute it to
    assert len(rec.rows) == 1


async def test_a_single_route_makes_no_call_and_records_nothing():
    cfg = RoutingConfig.parse({"routes": [{"key": "sales", "description": "tudo", "rubric_id": "sales_quality"}], "fallback": "sales"})
    rec = Recorder()
    await SessionRouter(RouteProvider("sales"), cfg, recorder=rec).classify(msgs(2), organization_id="o", workspace_id="w", session_id="s")
    assert rec.rows == [] and ROUTE_CRITERION_ID


# ---- the BigQuery recorder ----
class FakeBQ:
    def __init__(self, errors=None, raises=None):
        self.errors, self.raises, self.inserts = errors or [], raises, []

    def insert_rows_json(self, table, rows, row_ids=None):
        if self.raises:
            raise self.raises
        self.inserts.append((table, rows, row_ids))
        return self.errors


async def test_the_row_is_streamed_with_its_own_id_so_a_retry_of_the_same_write_is_a_no_op():
    bq = FakeBQ()
    row = {"spend_id": "analysis-abc", "organization_id": "o", "cost_usd": 0.1}
    await BigQuerySpendRecorder(T, "US", client=bq).record(row)
    assert bq.inserts == [("proj-123456.conversation_analytics.ai_spend", [row], ["analysis-abc"])]


async def test_a_refused_insert_is_an_error_that_never_carries_the_row():
    secret_row = {"spend_id": "x", "organization_id": SECRET}
    with pytest.raises(SpendRecordError) as e:
        await BigQuerySpendRecorder(T, "US", client=FakeBQ(errors=[{"index": 0, "errors": [{"reason": "invalid"}]}])).record(secret_row)
    assert "invalid" in str(e.value) and SECRET not in str(e.value)
    with pytest.raises(SpendRecordError) as e2:
        await BigQuerySpendRecorder(T, "US", client=FakeBQ(raises=RuntimeError(SECRET))).record(secret_row)
    assert SECRET not in str(e2.value)


# ---- the cap reads the record ----
def _spent(db, tenant="o", month=(2026, 11, 1)):
    from datetime import date

    return float(db.rows(queries.month_to_date_spend(T), {"organization_id": tenant, "workspace_id": "w", "month_start": date(*month)})[0]["spent_usd"])


def _db():
    return DuckBQ()


def analysis(aid, cost, at, org="o"):
    return {"analysis_id": aid, "organization_id": org, "workspace_id": "w", "session_id": "s", "rubric_id": "r", "rubric_version": 1, "analysis_mode": "live",
            "session_content_hash": "h", "analysis_status": "COMPLETED", "estimated_cost_usd": cost, "started_at": at, "completed_at": at}


def spend(sid, cost, at, org="o", subject="a1"):
    return {"spend_id": sid, "organization_id": org, "workspace_id": "w", "session_id": "s", "kind": "ANALYSIS", "subject_id": subject,
            "mode": "live", "model": "m", "input_tokens": 1, "output_tokens": 0, "cost_usd": cost, "occurred_at": at}


def at(h):
    return datetime(2026, 11, 1, h, 0, tzinfo=UTC)


def test_the_cap_counts_a_paid_call_whose_analysis_was_never_stored():
    db = _db()
    db.insert("ai_spend", [spend("s1", 0.25, at(10), subject="a1"), spend("s2", 0.25, at(11), subject="a1")])  # two paid calls, one analysis stored
    db.insert("session_analyses", [analysis("a1", 0.25, at(11))])
    assert _spent(db) == pytest.approx(0.50)  # the stored analyses alone would say 0.25


def test_spend_before_calls_were_recorded_still_counts_and_nothing_is_counted_twice():
    db = _db()
    db.insert("session_analyses", [analysis("old1", 0.10, at(8)), analysis("old2", 0.20, at(9)),  # stored before the first recorded call
                                   analysis("new1", 0.25, at(11))])  # stored after: its spend row is the one that counts
    db.insert("ai_spend", [spend("s1", 0.25, at(11), subject="new1")])
    assert _spent(db) == pytest.approx(0.55)  # 0.10 + 0.20 (legacy) + 0.25 (recorded), not 0.80


def test_a_tenant_without_recorded_calls_keeps_its_old_total_and_tenants_stay_apart():
    db = _db()
    db.insert("session_analyses", [analysis("a", 0.30, at(9)), analysis("b", 5.00, at(13), org="other")])
    assert _spent(db) == pytest.approx(0.30)  # no recorded call yet: the old rule
    db.insert("ai_spend", [spend("x", 5.00, at(12), org="other", subject="b")])
    assert _spent(db) == pytest.approx(0.30)  # another tenant's first recorded call is not this tenant's cut-off
    assert _spent(db, tenant="other") == pytest.approx(5.00)


def test_only_this_month_counts():
    db = _db()
    db.insert("ai_spend", [spend("old", 1.00, datetime(2026, 10, 31, 23, 0, tzinfo=UTC)), spend("new", 0.40, at(10))])
    assert _spent(db) == pytest.approx(0.40)


def test_the_cap_query_is_tenant_scoped_and_read_only():
    sql = queries.month_to_date_spend(T)
    assert sql.count("organization_id = @organization_id AND workspace_id = @workspace_id") >= 5
    assert "ai_spend" in sql and not any(w in sql.upper() for w in ("INSERT", "UPDATE", "DELETE", "MERGE"))
    assert Tenant("o", "w").params() == {"organization_id": "o", "workspace_id": "w"}
