"""The live debounce: one task per session and arrival window, and two tasks of a session never overlap (so the AI is never paid twice for one conversation)."""
from datetime import UTC, datetime, timedelta

import pytest

from sci_workers.live import SessionUpdateEvent
from sci_workers.scheduling import CloudTasksScheduler, plan_task

W, DELAY = 60, 60
T0 = datetime(2026, 11, 3, 13, 15, 19, 400000, tzinfo=UTC)  # the instant of the real burst that paid three times


def ev(session="s1", org="o", updated=T0, eid="e"):
    return SessionUpdateEvent(event_id=eid, organization_id=org, workspace_id="w", session_id=session, source_updated_at=updated, source_version="v1")


def test_the_real_burst_becomes_one_task_and_one_run_time():
    """Three events stamped 14:01, 14:04 and 14:07 that arrive within 65 ms of each other."""
    stamps = [datetime(2026, 11, 2, 14, m, tzinfo=UTC) for m in (1, 4, 7)]
    plans = {plan_task(ev(updated=u, eid=f"e{i}"), W, DELAY, T0 + timedelta(milliseconds=30 * i)) for i, u in enumerate(stamps)}
    assert len(plans) == 1  # one key and one run time: ONE evaluation


def test_the_task_runs_one_wait_after_its_window_ends():
    key, when = plan_task(ev(), W, DELAY, datetime(2026, 11, 3, 13, 15, 19, tzinfo=UTC))
    assert when == datetime(2026, 11, 3, 13, 17, 0, tzinfo=UTC)  # the window is 13:15:00-13:16:00, it ends 13:16:00, the wait is 60 s
    assert key.startswith("ev-")


@pytest.mark.parametrize("second", range(0, 60, 7))
def test_the_wait_is_never_shorter_than_the_configured_wait_and_never_longer_than_wait_plus_a_window(second):
    arrived = datetime(2026, 11, 3, 13, 15, second, tzinfo=UTC)
    _, when = plan_task(ev(), W, DELAY, arrived)
    assert timedelta(seconds=DELAY) <= when - arrived <= timedelta(seconds=DELAY + W)


def test_two_tasks_of_the_same_session_are_a_whole_window_apart_even_when_the_notices_straddle_a_boundary():
    """Notices at 13:15:59.9 and 13:16:00.1: two tasks (two windows), but never close in time: the second runs a full window after the first."""
    k1, t1 = plan_task(ev(eid="a"), W, DELAY, datetime(2026, 11, 3, 13, 15, 59, 900000, tzinfo=UTC))
    k2, t2 = plan_task(ev(eid="b"), W, DELAY, datetime(2026, 11, 3, 13, 16, 0, 100000, tzinfo=UTC))
    assert k1 != k2 and t2 - t1 == timedelta(seconds=W)  # an evaluation takes seconds: they never overlap


def test_other_sessions_and_tenants_have_their_own_tasks():
    keys = {plan_task(e, W, DELAY, T0)[0] for e in (ev(), ev(session="s2"), ev(org="other"))}
    assert len(keys) == 3


class FakeTasks:
    class HttpMethod:
        POST = "POST"

    def __init__(self):
        self.created, self.exists = [], set()

    def create_task(self, request):
        name = request["task"]["name"]
        if name in self.exists:
            from google.api_core.exceptions import AlreadyExists

            raise AlreadyExists("dup")
        self.exists.add(name)
        self.created.append(request["task"])


def scheduler(client, clock):
    s = CloudTasksScheduler.__new__(CloudTasksScheduler)  # no Google client: the Cloud Tasks module is only needed for the HTTP method enum
    s._tasks, s._client, s._window, s._clock = FakeTasks, client, W, clock
    s._parent, s._url, s._sa, s._aud = "projects/p/locations/l/queues/q", "https://w/tasks/evaluate", "sa@p", "https://w"
    return s


async def test_the_burst_creates_one_cloud_task_and_the_others_are_debounced(monkeypatch):
    pytest.importorskip("google.cloud.tasks_v2", reason="the scheduler imports the Cloud Tasks protobuf types")
    client = FakeTasks()
    results = []
    for i in range(3):
        sched = scheduler(client, lambda i=i: T0 + timedelta(milliseconds=30 * i))
        results.append(await sched.schedule(ev(updated=datetime(2026, 11, 2, 14, 1 + 3 * i, tzinfo=UTC), eid=f"e{i}"), DELAY))
    assert results == [True, False, False] and len(client.created) == 1
    assert client.created[0]["name"].startswith("projects/p/locations/l/queues/q/tasks/ev-")
