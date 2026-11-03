"""A session is read ONCE, from its latest row, whatever the source left in `sessions` (the ingest once wrote two rows for a session when its
first events arrived at the same time). Run on DuckDB with the project's real SQL."""
from datetime import UTC, date, datetime

import pytest

from sci_bq.source import BigQuerySource, Cursor, Tenant
from sci_bq.tables import Tables
from tests.duck import DuckBQ, DuckRunner

T = Tables(project="my-proj-123")
A, B = Tenant("orgA", "ws1"), Tenant("orgB", "ws1")
T0 = datetime(2026, 3, 1, 10, tzinfo=UTC)
T1, T2 = datetime(2026, 3, 1, 10, 4, tzinfo=UTC), datetime(2026, 3, 1, 10, 7, tzinfo=UTC)
EPOCH = Cursor(datetime(1970, 1, 1, tzinfo=UTC))
WINDOW = dict(start_date=date(2026, 3, 1), end_date=date(2026, 3, 2), cursor=EPOCH)


def row(tenant, sid, status, updated, closed=None):
    return dict(organization_id=tenant.organization_id, workspace_id=tenant.workspace_id, session_id=sid, status=status, started_at=T0, updated_at=updated,
                closed_at=closed)


@pytest.fixture
def src():
    db = DuckBQ()
    db.insert("sessions", [
        row(A, "s1", "open", T1), row(A, "s1", "closed", T2, T2),   # the very case: two rows for one session, the older one open
        row(A, "s2", "closed", T1, T1),                              # an ordinary session
        row(A, "s3", "closed", T1, T1), row(A, "s3", "open", T2),    # a stale CLOSED row and a newer OPEN one: the session is open
        row(A, "s4", "open", T2), row(A, "s4", "closed", T2, T2),    # same updated_at: the closed row wins
        row(B, "s1", "open", T1),                                    # the same id in another tenant is another session
    ])
    return BigQuerySource(DuckRunner(db), T)


async def page(src, tenant=A, **kw):
    return (await src.list_sessions(tenant, **{**WINDOW, **kw})).sessions


async def test_a_session_with_two_rows_is_listed_once_with_its_latest_state(src):
    rows = await page(src)
    assert sorted(r["session_id"] for r in rows) == ["s1", "s2", "s3", "s4"]
    s1 = next(r for r in rows if r["session_id"] == "s1")
    assert s1["status"] == "closed" and s1["updated_at"] == T2


async def test_the_status_filter_applies_to_the_latest_row_never_to_a_stale_one(src):
    closed = {r["session_id"] for r in await page(src, status="closed")}
    assert closed == {"s1", "s2", "s4"}  # s3 has a stale closed row but is open now
    assert {r["session_id"] for r in await page(src, status="open")} == {"s3"}  # s1 and s4 have a stale open row but are closed now


async def test_when_two_rows_have_the_same_update_time_the_closed_one_wins(src):
    s4 = next(r for r in await page(src) if r["session_id"] == "s4")
    assert s4["status"] == "closed"


async def test_paging_with_a_small_page_shows_every_session_exactly_once(src):
    seen, cursor = [], EPOCH
    for _ in range(10):
        res = await src.list_sessions(A, start_date=WINDOW["start_date"], end_date=WINDOW["end_date"], cursor=cursor, page_size=1)
        seen += [r["session_id"] for r in res.sessions]
        if res.next_cursor is None:
            break
        cursor = res.next_cursor
    assert sorted(seen) == ["s1", "s2", "s3", "s4"] and len(seen) == 4


async def test_one_session_by_id_and_the_other_tenant_stay_correct(src):
    assert (await src.get_session(A, "s1", lookback_days=365, today=date(2026, 3, 2)))["status"] == "closed"
    assert [r["status"] for r in await page(src, tenant=B)] == ["open"]
    only = await page(src, only_session="s1")
    assert [r["session_id"] for r in only] == ["s1"]
