"""The producer sample: it must validate what the platform validates, retry what is worth retrying and never leak the key."""
import copy
import importlib.util
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

from sci_workers.ingest import ConversationEvent, InvalidConversation

SAMPLE = Path(__file__).parent.parent / "samples" / "producer-python"


def load(name: str):
    spec = importlib.util.spec_from_file_location(f"sample_{name}", SAMPLE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


producer = load("producer")
mapping = load("mapping_example")
EVENTS = sorted((SAMPLE / "events").glob("*.json"))
NOW = datetime(2026, 11, 2, 18, 0, tzinfo=UTC)


def event(i: int = 0) -> dict:
    return json.loads(EVENTS[i].read_text(encoding="utf-8"))


# ---------- the sample events and the contract ----------
def test_the_schema_of_the_sample_is_the_one_of_the_platform():
    assert (SAMPLE / "schema" / "conversation-event.schema.json").read_text() == (SAMPLE.parent.parent / "contracts" / "conversation-event.schema.json").read_text()


def test_there_are_three_events_of_one_conversation_and_updated_at_only_grows():
    assert len(EVENTS) == 3
    evs = [event(i) for i in range(3)]
    assert {e["session"]["session_id"] for e in evs} == {"exemplo-001"}
    assert [e["session"]["updated_at"] for e in evs] == sorted(e["session"]["updated_at"] for e in evs)
    assert len({e["event_id"] for e in evs}) == 3 and len({m["message_id"] for e in evs for m in e["messages"]}) == 6  # nothing repeats by accident
    assert evs[-1]["session"]["status"] == "closed" and evs[-1]["session"]["closed_at"]


@pytest.mark.parametrize("i", [0, 1, 2])
def test_the_sample_events_pass_the_sample_validation_AND_the_platform_ingest_validation(i):
    producer.validate_event(event(i), now=NOW)
    parsed = ConversationEvent.model_validate(event(i))  # the very model the ingest service uses
    parsed.validate_against(NOW)


def test_the_mapping_example_builds_events_the_platform_accepts_and_only_sends_what_is_new():
    first = mapping.chat_to_event(mapping.SAMPLE_CHAT, organization_id="org-test", workspace_id="default")
    producer.validate_event(first, now=NOW)
    ConversationEvent.model_validate(first).validate_against(NOW)
    assert [m["message_id"] for m in first["messages"]] == ["a1", "a2"] and first["session"]["status"] == "open"
    chat = copy.deepcopy(mapping.SAMPLE_CHAT)
    assert mapping.chat_to_event(chat, organization_id="o", workspace_id="w", already_sent=["a1", "a2"]) is None  # nothing new, still open
    chat["messages"].append({"id": "a3", "from": "client", "sender_id": "c", "text": "Obrigado!", "at": "2026-11-02T15:02:10Z"})
    chat["closed_at"] = "2026-11-02T15:02:30Z"
    second = mapping.chat_to_event(chat, organization_id="org-test", workspace_id="default", already_sent=["a1", "a2"])
    producer.validate_event(second, now=NOW)
    assert [m["message_id"] for m in second["messages"]] == ["a3"] and second["messages"][0]["sequence_number"] == 3
    assert second["session"]["status"] == "closed" and second["session"]["updated_at"] > first["session"]["updated_at"]
    assert second["event_id"] != first["event_id"] and mapping.chat_to_event(chat, organization_id="org-test", workspace_id="default", already_sent=["a1", "a2"])["event_id"] == second["event_id"]


# ---------- what is refused (and the platform agrees) ----------
def broken(change) -> dict:
    e = copy.deepcopy(event(0))
    change(e)
    return e


CASES = {
    "an unknown field": lambda e: e.update(extra=1),
    "a missing required field": lambda e: e.pop("event_id"),
    "a wrong sender type": lambda e: e["messages"][0].update(sender_type="vendor"),
    "a status that is not open or closed": lambda e: e["session"].update(status="pending"),
    "a message with no content": lambda e: e["messages"][0].pop("content"),
    "too many messages": lambda e: e.update(messages=[dict(e["messages"][0], message_id=f"x{i}") for i in range(501)]),
    "a date without a timezone": lambda e: e["session"].update(updated_at="2026-11-02T14:01:10"),
    "updated_at before started_at": lambda e: e["session"].update(updated_at="2026-11-02T13:00:00Z"),
    "a duplicated message_id": lambda e: e["messages"][1].update(message_id=e["messages"][0]["message_id"]),
    "a message before the day the session started": lambda e: e["messages"][0].update(created_at="2026-11-01T23:59:00Z"),
    "a date in the future": lambda e: e["session"].update(started_at="2027-01-01T00:00:00Z", updated_at="2027-01-01T00:00:00Z"),
}


@pytest.mark.parametrize("name", list(CASES))
def test_a_broken_event_is_refused_by_the_sample_and_by_the_platform(name):
    e = broken(CASES[name])
    with pytest.raises(producer.InvalidEvent) as err:
        producer.validate_event(e, now=NOW)
    assert err.value.errors
    # the platform refuses the same event (shape errors by the model, the rest by its own rules)
    with pytest.raises((ValueError, InvalidConversation)):
        ConversationEvent.model_validate(e).validate_against(NOW)


def test_the_validation_reports_every_problem_and_never_the_message_text():
    e = broken(lambda x: (x["session"].update(updated_at="2026-11-02T13:00:00Z"), x["messages"][1].update(message_id="m1")))
    with pytest.raises(producer.InvalidEvent) as err:
        producer.validate_event(e, now=NOW)
    text = str(err.value)
    assert "updated_at is before" in text and "appears twice" in text and len(err.value.errors) == 2
    assert "preço do plano" not in text and "R$" not in text


# ---------- sending ----------
class Boom(Exception):
    def __init__(self, code: int | None = None):
        super().__init__(f"boom {code}")
        self.code = code


class FakePublisher:
    def __init__(self, failures=()):
        self.failures, self.calls = list(failures), []

    def publish(self, topic, data):
        self.calls.append((topic, data))
        if self.failures:
            raise self.failures.pop(0)
        return f"msg-{len(self.calls)}"


def sender(pub, **kw):
    kw.setdefault("sleep", lambda s: pub.__dict__.setdefault("slept", []).append(s))
    kw.setdefault("jitter", lambda: 0.0)
    return producer.Sender(pub, "projects/p/topics/t", **kw)


def test_it_publishes_the_event_as_utf8_json_and_returns_the_message_id():
    pub = FakePublisher()
    assert sender(pub).send(event(0)) == "msg-1"
    topic, data = pub.calls[0]
    assert topic == "projects/p/topics/t" and json.loads(data.decode("utf-8")) == event(0) and "preço".encode() in data  # accents are kept, not escaped


def test_an_invalid_event_is_never_published():
    pub = FakePublisher()
    with pytest.raises(producer.InvalidEvent):
        sender(pub).send(broken(CASES["a wrong sender type"]))
    assert pub.calls == []


@pytest.mark.parametrize("failure", [Boom(503), Boom(429), Boom(500), Boom(504), TimeoutError(), ConnectionError()])
def test_a_transient_failure_is_retried_with_a_growing_wait_and_then_succeeds(failure):
    pub = FakePublisher([failure, failure])
    assert sender(pub).send(event(0)) == "msg-3"
    assert pub.slept == [1.0, 2.0]  # exponential: 1 s, 2 s


@pytest.mark.parametrize("failure", [Boom(403), Boom(404), Boom(400), Boom(401), ValueError("x")])
def test_a_failure_that_will_not_fix_itself_is_not_retried(failure):
    pub = FakePublisher([failure])
    with pytest.raises(producer.PublishFailed) as err:
        sender(pub).send(event(0))
    assert len(pub.calls) == 1 and "retrying will not fix it" in str(err.value)


def test_it_gives_up_after_the_retries_and_the_wait_is_capped():
    pub = FakePublisher([Boom(503)] * 20)
    with pytest.raises(producer.PublishFailed) as err:
        sender(pub, retries=4, base_delay=10, max_delay=25).send(event(0))
    assert len(pub.calls) == 5 and "after 4 retries" in str(err.value) and pub.slept == [10.0, 20.0, 25.0, 25.0]


def test_the_jitter_only_adds_up_to_a_quarter_of_the_wait():
    s = producer.Sender(FakePublisher(), "t", base_delay=4, jitter=lambda: 1.0)
    assert s.delay(0) == 5.0 and s.delay(1) == 10.0


# ---------- credentials and the command line ----------
def test_the_key_comes_from_the_environment_and_a_bad_one_is_never_echoed():
    assert producer.load_credentials({}) is None  # no key: Google's default credentials apply
    with pytest.raises(SystemExit) as err:
        producer.load_credentials({"SCI_PUBSUB_KEY_JSON": '{"private_key": "TOP-SECRET-KEY", '})
    assert "TOP-SECRET" not in str(err.value) and "not valid JSON" in str(err.value)


def test_the_topic_can_be_a_short_name_or_a_full_path():
    assert producer.topic_path("proj", "sci-dev-conversations") == "projects/proj/topics/sci-dev-conversations"
    assert producer.topic_path("proj", "projects/other/topics/x") == "projects/other/topics/x"


class Out(list):
    def write(self, s):
        self.append(s)

    def flush(self):
        pass


def run(argv, env=None, publisher=None):
    out = Out()
    made = []

    def make(creds):
        made.append(creds)
        return publisher or FakePublisher()

    code = producer.main(argv, env=env or {}, make_publisher=make, out=out)
    return code, "".join(out), made


def test_without_publish_nothing_is_sent_and_no_publisher_is_even_created():
    code, text, made = run([str(p) for p in EVENTS])
    assert code == 0 and made == [] and "Nothing was sent" in text and text.count("valid ·") == 3


def test_one_invalid_file_stops_everything_before_anything_is_sent(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps(broken(CASES["an unknown field"])))
    pub = FakePublisher()
    code, text, made = run([str(EVENTS[0]), str(bad), "--publish"], env={"SCI_PROJECT": "p", "SCI_TOPIC": "t"}, publisher=pub)
    assert code == 2 and "INVALID" in text and pub.calls == [] and made == []
    broken_json = tmp_path / "x.json"
    broken_json.write_text("{ not json")
    assert run([str(broken_json)])[0] == 2


def test_publish_needs_the_project_and_the_topic():
    code, text, made = run([str(EVENTS[0]), "--publish"])
    assert code == 2 and "SCI_PROJECT" in text and made == []


def test_publish_sends_the_files_in_the_order_given_to_the_full_topic_path():
    pub = FakePublisher()
    code, text, made = run([str(p) for p in EVENTS] + ["--publish"], env={"SCI_PROJECT": "proj", "SCI_TOPIC": "sci-dev-conversations"}, publisher=pub)
    assert code == 0 and text.count("sent ·") == 3
    assert [json.loads(d)["event_id"] for _, d in pub.calls] == ["exemplo-001-evt-1", "exemplo-001-evt-2", "exemplo-001-evt-3"]
    assert {t for t, _ in pub.calls} == {"projects/proj/topics/sci-dev-conversations"}


def test_a_failure_stops_the_remaining_files_and_the_exit_code_says_so(monkeypatch):
    monkeypatch.setattr(producer.time, "sleep", lambda s: None)
    pub = FakePublisher([Boom(403)])
    code, text, _ = run([str(p) for p in EVENTS] + ["--publish"], env={"SCI_PROJECT": "p", "SCI_TOPIC": "t"}, publisher=pub)
    assert code == 1 and "NOT SENT" in text and len(pub.calls) == 1


# ---------- running it from an IDE: no shell expands the patterns ----------
def test_with_no_argument_it_uses_the_sample_events_in_order():
    files = producer.expand_files([])
    assert [f.name for f in files] == ["01-conversa-aberta.json", "02-mais-mensagens.json", "03-conversa-encerrada.json"]


def test_a_pattern_is_expanded_by_the_program_and_kept_in_name_order(monkeypatch):
    monkeypatch.chdir(SAMPLE)
    assert [f.name for f in producer.expand_files(["events/*.json"])] == [p.name for p in EVENTS]
    assert [f.name for f in producer.expand_files(["events/0[12]-*.json"])] == ["01-conversa-aberta.json", "02-mais-mensagens.json"]
    assert producer.expand_files(["a.json", "b.json"]) == [Path("a.json"), Path("b.json")]  # plain names are kept as given, in that order


def test_running_with_no_argument_or_a_star_validates_and_sends_nothing(monkeypatch):
    monkeypatch.chdir(SAMPLE)
    for argv in ([], ["events/*.json"]):
        code, text, made = run(argv)
        assert code == 0 and made == [] and text.count("valid ·") == 3 and "Nothing was sent" in text


def test_a_pattern_that_matches_nothing_is_a_clear_error_not_a_silent_success(monkeypatch):
    monkeypatch.chdir(SAMPLE)
    code, text, made = run(["nada/*.json", "--publish"], env={"SCI_PROJECT": "p", "SCI_TOPIC": "t"})
    assert code == 2 and "No file matches" in text and made == []


def test_publish_alone_sends_the_sample_events(monkeypatch):
    pub = FakePublisher()
    code, _, _ = run(["--publish"], env={"SCI_PROJECT": "proj", "SCI_TOPIC": "t"}, publisher=pub)
    assert code == 0 and [json.loads(d)["event_id"] for _, d in pub.calls] == ["exemplo-001-evt-1", "exemplo-001-evt-2", "exemplo-001-evt-3"]
