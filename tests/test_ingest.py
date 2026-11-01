"""Conversation ingestion: contract, rules, order of effects, idempotency, tenant isolation, SQL and HTTP."""
import base64
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from sci_bq import queries
from sci_bq.source import BigQuerySource, Tenant
from sci_bq.source_writer import BigQuerySourceWriter, SourceWriteError, merge_session_sql, message_row_id
from sci_bq.tables import Tables
from sci_workers.ingest import ConversationEvent, IngestProcessor, InvalidConversation, UnauthorizedTenant
from sci_workers.ingest_app import create_app
from sci_workers.live import SessionUpdateEvent
from sci_workers.live_auth import AuthError
from sci_workers.pubsub import PublishError, PubSubPublisher
from tests.duck import DuckBQ, DuckRunner

ROOT = Path(__file__).parent.parent
NOW = datetime(2026, 11, 1, 15, 0, tzinfo=UTC)
T = Tables("proj-123456")
TENANT = Tenant("synthetic-a", "default")


def payload(**over):
    p = json.loads((ROOT / "contracts" / "conversation-event.example.json").read_text())
    p.update(over)
    return p


def event(**over):
    return ConversationEvent.model_validate(payload(**over))


class Calls:
    def __init__(self):
        self.log = []


class FakeWriter(Calls):
    def __init__(self, calls, changed=True, fail=None):
        self.log, self.changed, self.fail, self.messages, self.sessions = calls, changed, fail, [], []

    async def write_messages(self, tenant, session_id, messages):
        self.log.append("messages")
        if self.fail == "messages":
            raise SourceWriteError("x")
        self.messages += list(messages)

    async def upsert_session(self, tenant, session):
        self.log.append("session")
        if self.fail == "session":
            raise SourceWriteError("x")
        self.sessions.append(session)
        return self.changed


class FakePublisher(Calls):
    def __init__(self, calls, fail=False):
        self.log, self.fail, self.sent = calls, fail, []

    async def publish(self, topic, body, attributes=None):
        self.log.append("publish")
        if self.fail:
            raise PublishError("x")
        self.sent.append((topic, body, attributes))
        return "id-1"


def processor(changed=True, fail=None, publish_fails=False, tenants=frozenset({("synthetic-a", "default")})):
    calls = []
    w, p = FakeWriter(calls, changed, fail), FakePublisher(calls, publish_fails)
    return IngestProcessor(tenants=tenants, writer=w, publisher=p, events_topic="sci-dev-session-updates", clock=lambda: NOW), w, p, calls


# ---- contract ----
def test_the_published_example_is_a_valid_conversation():
    e = event()
    assert (e.session.session_id, len(e.messages)) == ("s9001", 2) and e.session.updated_at.tzinfo is not None


def test_the_json_schema_and_the_model_agree_on_what_is_required():
    schema = json.loads((ROOT / "contracts" / "conversation-event.schema.json").read_text())
    assert set(schema["required"]) == {"event_id", "organization_id", "workspace_id", "session"}
    assert set(schema["properties"]["session"]["required"]) == {"session_id", "started_at", "updated_at"}
    assert set(schema["properties"]["messages"]["items"]["required"]) == {"message_id", "content", "created_at"}
    assert schema["properties"]["messages"]["maxItems"] == 500 and schema["additionalProperties"] is False
    for name, model in (("session", ConversationEvent.model_fields["session"].annotation), ("messages", None)):
        if model:  # every field the schema allows for a session is a field of the model, and the other way round
            assert set(schema["properties"][name]["properties"]) == set(model.model_fields)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.pop("event_id"),
        lambda p: p.__setitem__("extra", 1),  # unknown top-level field
        lambda p: p["session"].__setitem__("started_at", "2026-11-01T14:00:00"),  # no timezone
        lambda p: p["session"].__setitem__("status", "finished"),
        lambda p: p["messages"][0].__setitem__("sender_type", "robot"),
        lambda p: p["messages"][0].pop("content"),
        lambda p: p["messages"][0].__setitem__("created_at", "not a date"),
        lambda p: p["messages"][0].__setitem__("content", "x" * 100_001),
        lambda p: p.__setitem__("messages", [dict(p["messages"][0], message_id=f"m{i}") for i in range(501)]),
        lambda p: p["session"].__setitem__("updated_at", "2026-11-01T13:00:00Z"),  # before it started
    ],
)
def test_a_malformed_conversation_is_refused(mutate):
    p = payload()
    mutate(p)
    with pytest.raises(ValidationError):
        ConversationEvent.model_validate(p)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p["messages"][1].__setitem__("message_id", "m1"),  # the same id twice in one event
        lambda p: p["messages"][0].__setitem__("created_at", "2026-10-30T10:00:00Z"),  # before the session's day: it would never be read
        lambda p: p["messages"][0].__setitem__("created_at", "2026-12-25T10:00:00Z"),  # in the future
        lambda p: p["session"].__setitem__("updated_at", "2027-03-01T00:00:00Z"),
    ],
)
async def test_a_conversation_that_would_be_stored_but_never_read_or_is_not_credible_is_refused(mutate):
    p = payload()
    mutate(p)
    proc, w, pub, calls = processor()
    with pytest.raises(InvalidConversation):
        await proc.process(ConversationEvent.model_validate(p))
    assert calls == []  # nothing was stored and nothing was announced


# ---- order of effects, idempotency ----
async def test_it_stores_the_messages_then_the_session_and_only_then_announces_it():
    proc, w, pub, calls = processor()
    r = await proc.process(event())
    assert calls == ["messages", "session", "publish"]  # the event never precedes the data
    assert (r.messages, r.session_changed, r.announced) == (2, True, True)
    topic, body, attrs = pub.sent[0]
    assert topic == "sci-dev-session-updates" and attrs == {"origin": "ingest"}
    assert body["source_updated_at"] == "2026-11-01T14:07:30+00:00"  # the stored updated_at: the worker's "source behind the event" check passes
    SessionUpdateEvent.model_validate(body)  # exactly the contract the live worker consumes


async def test_the_announcement_carries_the_ingest_event_id_so_a_repeat_is_absorbed_by_the_debounce():
    proc, _, pub, _ = processor()
    await proc.process(event())
    await proc.process(event())
    first, second = pub.sent[0][1], pub.sent[1][1]
    assert first == second  # same id and same source_updated_at: same Cloud Tasks task name, no second analysis


async def test_a_repeat_is_announced_even_if_nothing_changed():
    """The previous delivery may have stored everything and failed before publishing."""
    proc, w, pub, calls = processor(changed=False)
    r = await proc.process(event())
    assert r.session_changed is False and r.announced is True and calls[-1] == "publish"


async def test_a_session_without_new_messages_still_updates_and_announces():
    proc, w, pub, calls = processor()
    await proc.process(event(messages=[]))
    assert calls == ["session", "publish"]


@pytest.mark.parametrize("fail", ["messages", "session"])
async def test_a_failed_write_announces_nothing_and_lets_pubsub_retry(fail):
    proc, w, pub, calls = processor(fail=fail)
    with pytest.raises(SourceWriteError):
        await proc.process(event())
    assert "publish" not in calls


async def test_a_failed_announcement_raises_after_the_data_is_stored_and_the_retry_is_harmless():
    proc, w, pub, calls = processor(publish_fails=True)
    with pytest.raises(PublishError):
        await proc.process(event())
    assert calls == ["messages", "session", "publish"]  # stored; Pub/Sub redelivers; the writes are idempotent


# ---- tenant isolation ----
async def test_a_workspace_outside_the_allowlist_is_refused_before_anything_is_written():
    proc, w, pub, calls = processor(tenants=frozenset({("other-org", "default")}))
    with pytest.raises(UnauthorizedTenant):
        await proc.process(event())
    assert calls == []


async def test_the_tenant_comes_from_the_event_and_the_rows_carry_it():
    proc, w, pub, _ = processor()
    await proc.process(event())
    assert {m["organization_id"] for m in w.messages} == {"synthetic-a"} and w.sessions[0]["workspace_id"] == "default"
    assert [m["message_id"] for m in w.messages] == ["m1", "m2"] and w.sessions[0]["session_id"] == "s9001"


# ---- BigQuery writer ----
def test_the_merge_is_tenant_scoped_bounded_by_the_partition_and_only_moves_a_session_forward():
    sql = merge_session_sql(T)
    assert "MERGE `proj-123456.commerce.sessions` T" in sql
    assert "T.organization_id = S.organization_id AND T.workspace_id = S.workspace_id AND T.session_id = S.session_id" in sql
    assert "DATE(T.started_at) = @day" in sql  # prunes the partition
    assert "WHEN MATCHED AND S.updated_at > T.updated_at THEN UPDATE" in sql  # a replay or an older delivery changes nothing
    assert "started_at = S.started_at" not in sql  # the partition key never changes
    assert "DELETE" not in sql.upper().replace("DELETED", "")


class FakeBQ:
    def __init__(self, affected=1, errors=None, raises=None):
        self.affected, self.errors, self.raises, self.queries, self.inserts = affected, errors or [], raises, [], []

    def query(self, sql, job_config=None):
        if self.raises:
            raise self.raises
        self.queries.append((sql, job_config))
        outer = self

        class Job:
            num_dml_affected_rows = outer.affected

            def result(self):
                return []

        return Job()

    def insert_rows_json(self, table, rows, row_ids=None):
        self.inserts.append((table, rows, row_ids))
        return self.errors


async def test_the_session_merge_passes_typed_parameters_and_reports_whether_it_changed():
    bq = FakeBQ(affected=1)
    w = BigQuerySourceWriter(T, "US", client=bq)
    row = {"session_id": "s9001", "channel": "whatsapp", "status": "closed", "started_at": "2026-11-01T23:30:00-03:00",
           "updated_at": "2026-11-02T03:00:00+00:00", "closed_at": None, "metadata": {"a": 1}}
    assert await w.upsert_session(TENANT, row) is True
    params = {p.name: p for p in bq.queries[0][1].query_parameters}
    assert params["organization_id"].value == "synthetic-a" and params["closed_at"].value is None
    assert params["day"].value.isoformat() == "2026-11-02"  # the UTC day of started_at (23:30 at -03:00), which is what DATE(started_at) is in BigQuery
    assert json.loads(params["metadata"].value) == {"a": 1}
    assert await BigQuerySourceWriter(T, "US", client=FakeBQ(affected=0)).upsert_session(TENANT, row) is False  # an older or equal updated_at: no change


async def test_message_rows_carry_an_id_that_de_duplicates_a_redelivery():
    bq = FakeBQ()
    w = BigQuerySourceWriter(T, "US", client=bq)
    await w.write_messages(TENANT, "s9001", [{"message_id": "m1", "content": "oi", "metadata": {"k": "v"}}, {"message_id": "m2", "content": "ola"}])
    table, rows, ids = bq.inserts[0]
    assert table == "proj-123456.commerce.messages" and ids == [message_row_id(TENANT, "s9001", "m1"), message_row_id(TENANT, "s9001", "m2")]
    assert ids[0] == "synthetic-a|default|s9001|m1" and json.loads(rows[0]["metadata"]) == {"k": "v"} and rows[1]["metadata"] is None


async def test_write_errors_become_retryable_errors_that_never_carry_the_message_text():
    secret = "o cliente disse algo privado"
    w = BigQuerySourceWriter(T, "US", client=FakeBQ(errors=[{"index": 0, "errors": [{"reason": "invalid", "message": secret}]}]))
    with pytest.raises(SourceWriteError) as e:
        await w.write_messages(TENANT, "s", [{"message_id": "m", "content": secret}])
    assert secret not in str(e.value) and "invalid" in str(e.value)
    with pytest.raises(SourceWriteError) as e2:
        await BigQuerySourceWriter(T, "US", client=FakeBQ(raises=RuntimeError(secret))).upsert_session(
            TENANT, {"session_id": "s", "started_at": "2026-11-01T00:00:00+00:00", "updated_at": "2026-11-01T00:00:00+00:00"})
    assert secret not in str(e2.value)


# ---- reader: at-least-once delivery must not duplicate the conversation ----
async def test_the_reader_counts_a_message_stored_twice_once_and_keeps_tenants_apart():
    db = DuckBQ()
    base = {"session_id": "s1", "sender_type": "customer", "content": "oi", "created_at": datetime(2026, 11, 1, 14, 0, tzinfo=UTC), "sequence_number": 1}
    db.insert("messages", [
        {**base, "organization_id": "o", "workspace_id": "w", "message_id": "m1"},
        {**base, "organization_id": "o", "workspace_id": "w", "message_id": "m1"},  # redelivery: the same message stored twice
        {**base, "organization_id": "o", "workspace_id": "w", "message_id": "m2", "sequence_number": 2},
        {**base, "organization_id": "other", "workspace_id": "w", "message_id": "m1"},  # another tenant's message with the same ids
    ])
    out = await BigQuerySource(DuckRunner(db), T).get_messages(
        Tenant("o", "w"), ["s1"], start_date=datetime(2026, 11, 1).date(), end_date=datetime(2026, 11, 2).date())
    assert [m["message_id"] for m in out["s1"]] == ["m1", "m2"]
    assert "QUALIFY ROW_NUMBER() OVER (PARTITION BY session_id, message_id" in queries.messages_for_sessions(T)


# ---- HTTP ----
class Verifier:
    def verify(self, auth):
        if auth != "Bearer good":
            raise AuthError("no")
        return "sa@x"


def http(**kw):
    proc, w, pub, calls = processor(**kw)
    return TestClient(create_app(processor=proc, push_verifier=Verifier())), w, pub, calls


def push(client, body, token="good"):
    data = base64.b64encode(body if isinstance(body, bytes) else json.dumps(body).encode()).decode()
    return client.post("/pubsub/push", json={"message": {"data": data, "messageId": "1"}}, headers={"authorization": f"Bearer {token}"})


def test_the_service_answers_204_and_stores_a_valid_conversation():
    c, w, pub, calls = http()
    assert push(c, payload()).status_code == 204 and calls == ["messages", "session", "publish"]
    assert c.get("/health").json() == {"status": "ok"}


def test_every_failure_is_a_non_2xx_so_pubsub_retries_and_then_parks_it():
    c, *_ = http()
    assert push(c, payload(), token="bad").status_code == 401
    assert push(c, b"not json at all").status_code == 400
    assert push(c, {**payload(), "extra": 1}).status_code == 400
    assert c.post("/pubsub/push", json={"message": {"data": "%%%"}}, headers={"authorization": "Bearer good"}).status_code == 400
    assert push(http(tenants=frozenset({("other", "w")}))[0], payload()).status_code == 403
    p = payload()
    p["messages"][1]["message_id"] = "m1"
    assert push(c, p).status_code == 422
    assert push(http(fail="session")[0], payload()).status_code == 503
    assert push(http(publish_fails=True)[0], payload()).status_code == 503


def test_the_response_and_the_logs_never_echo_the_conversation(caplog):
    text = "segredo-do-cliente-12345"
    p = payload()
    p["messages"][0]["content"] = text
    p["messages"][1]["message_id"] = "m1"  # makes it invalid on purpose
    c, *_ = http()
    with caplog.at_level("DEBUG"):
        r = push(c, p)
    assert r.status_code == 422 and text not in r.text and text not in caplog.text


# ---- Pub/Sub publisher ----
class FakeSession:
    def __init__(self, status=200):
        self.status, self.posts = status, []

    def post(self, url, json=None, timeout=None):
        self.posts.append((url, json))
        outer = self

        class R:
            status_code = outer.status

            def json(self):
                return {"messageIds": ["77"]}

        return R()


async def test_the_publisher_posts_base64_json_to_the_named_topic_and_returns_the_id():
    s = FakeSession()
    mid = await PubSubPublisher("proj-123456", session=s).publish("sci-dev-session-updates", {"a": 1}, {"origin": "ingest"})
    url, body = s.posts[0]
    assert mid == "77" and url == "https://pubsub.googleapis.com/v1/projects/proj-123456/topics/sci-dev-session-updates:publish"
    assert json.loads(base64.b64decode(body["messages"][0]["data"])) == {"a": 1} and body["messages"][0]["attributes"] == {"origin": "ingest"}


async def test_a_refused_publish_is_an_error_without_the_payload():
    with pytest.raises(PublishError) as e:
        await PubSubPublisher("p", session=FakeSession(status=403)).publish("t", {"secret": "x"})
    assert "403" in str(e.value) and "secret" not in str(e.value)
