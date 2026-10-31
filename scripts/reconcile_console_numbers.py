"""Checks that the numbers the admin console shows agree with each other, against a real BigQuery project (read-only).

The console uses one vocabulary: SESSION (a conversation), CURRENT analysis (the latest one per session and rubric: the unit of the score, the approval rate,
the review queue and the Sessões list) and EXECUTED analysis (everything that ran and was paid, including the replaced ones). The identities below must hold;
a failure means two screens would disagree.

    python scripts/reconcile_console_numbers.py --project my-project --tenant synthetic-a/default --tenant synthetic-b/default [--days 7 30 180]
"""

from __future__ import annotations

import argparse
import sys

from google.cloud import bigquery

EXIT_MISMATCH = 1


def run(project: str, org: str, ws: str, days: int) -> list[tuple[str, bool, str]]:
    c = bigquery.Client(project=project)
    a = f"`{project}.conversation_analytics"
    s = f"`{project}.commerce.sessions`"
    cfg = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("org", "STRING", org),
            bigquery.ScalarQueryParameter("ws", "STRING", ws),
            bigquery.ScalarQueryParameter("days", "INT64", days),
        ]
    )
    t = "organization_id = @org AND workspace_id = @ws"

    def one(sql: str) -> dict:
        return dict(next(iter(c.query(sql, job_config=cfg).result())))

    since = "DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)"
    # Painel tiles (same SQL as DashboardService.summary)
    quality = one(
        f"SELECT IFNULL(SUM(sessions),0) cur, IFNULL(SUM(scored_sessions),0) scored, IFNULL(SUM(approved),0) appr, IFNULL(SUM(rejected),0) rej, "
        f"IFNULL(SUM(needs_review),0) rev, IFNULL(SUM(not_evaluable),0) nev FROM {a}.gold_daily_quality` WHERE {t} AND day >= {since}"
    )
    cov = one(
        f"SELECT (SELECT COUNT(*) FROM {s} WHERE {t} AND DATE(started_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 365 DAY)) AS sessions, "
        f"(SELECT COUNT(DISTINCT r.session_id) FROM {a}.current_session_results` r JOIN {s} s ON s.organization_id = @org AND s.workspace_id = @ws AND s.session_id = r.session_id "
        f"WHERE r.organization_id = @org AND r.workspace_id = @ws AND DATE(s.started_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 365 DAY) AND DATE(r.completed_at) >= {since}) AS analysed"
    )
    models = one(
        f"SELECT IFNULL(SUM(n),0) executed, IFNULL(SUM(cur),0) current_, IFNULL(ROUND(SUM(cost),6),0) cost FROM (SELECT model, COUNT(DISTINCT analysis_id) n, "
        f"COUNT(DISTINCT IF(analysis_id IN (SELECT analysis_id FROM {a}.current_session_results` WHERE {t}), analysis_id, NULL)) cur, SUM(estimated_cost_usd) cost "
        f"FROM {a}.session_analyses` WHERE {t} AND DATE(started_at) >= {since} GROUP BY model)"
    )
    kpi_cost = one(
        f"SELECT IFNULL(ROUND(SUM(cost_usd),6),0) cost, IFNULL(SUM(analyses),0) executed FROM {a}.gold_cost_daily` WHERE {t} AND day >= {since}"
    )
    # Sessões list (same joins as SessionsService), filtered the way the tiles open it
    lst = one(
        f"SELECT COUNT(*) rows_, COUNT(DISTINCT s.session_id) sessions FROM {s} s LEFT JOIN {a}.current_session_results` r ON r.organization_id = @org AND r.workspace_id = @ws "
        f"AND r.session_id = s.session_id WHERE s.organization_id = @org AND s.workspace_id = @ws AND DATE(s.started_at) BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 365 DAY) AND CURRENT_DATE() "
        f"AND r.analysis_id IS NOT NULL AND DATE(r.completed_at) BETWEEN {since} AND CURRENT_DATE()"
    )
    # Como funciona (all time, same SQL as PipelineService.overview)
    ov = one(
        f"SELECT (SELECT COUNT(*) FROM {s} WHERE {t} AND DATE(started_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 365 DAY)) sessions, "
        f"(SELECT IFNULL(SUM(analyses),0) FROM {a}.gold_cost_daily` WHERE {t}) executed, (SELECT COUNT(*) FROM {a}.current_session_results` WHERE {t}) current_"
    )

    cur, decided = int(quality["cur"]), int(quality["appr"]) + int(quality["rej"])
    return [
        ("tile 'Análises vigentes' = rows of the Sessões list it opens", cur == int(lst["rows_"]), f"{cur} vs {lst['rows_']}"),
        (
            "tile 'Sessões analisadas' = distinct sessions of that list",
            int(cov["analysed"]) == int(lst["sessions"]),
            f"{cov['analysed']} vs {lst['sessions']}",
        ),
        ("sessions analysed <= current analyses <= (one per rubric)", int(cov["analysed"]) <= cur, f"{cov['analysed']} <= {cur}"),
        (
            "sessions analysed <= sessions of the workspace",
            int(cov["analysed"]) <= int(cov["sessions"]),
            f"{cov['analysed']} <= {cov['sessions']}",
        ),
        (
            "approved + rejected + in review + not evaluable = current analyses",
            decided + int(quality["rev"]) + int(quality["nev"]) == cur,
            f"{quality['appr']}+{quality['rej']}+{quality['rev']}+{quality['nev']} = {decided + int(quality['rev']) + int(quality['nev'])} vs {cur}",
        ),
        ("scored analyses <= current analyses", int(quality["scored"]) <= cur, f"{quality['scored']} <= {cur}"),
        (
            "executed (models table) = executed (daily cost view)",
            int(models["executed"]) == int(kpi_cost["executed"]),
            f"{models['executed']} vs {kpi_cost['executed']}",
        ),
        (
            "cost (models table) = cost tile",
            abs(float(models["cost"]) - float(kpi_cost["cost"])) < 1e-6,
            f"{models['cost']} vs {kpi_cost['cost']}",
        ),
        (
            "current inside executed <= executed",
            int(models["current_"]) <= int(models["executed"]),
            f"{models['current_']} <= {models['executed']}",
        ),
        (
            "Como funciona: executed >= current (replaced = executed - current >= 0)",
            int(ov["executed"]) >= int(ov["current_"]),
            f"{ov['executed']} >= {ov['current_']} (replaced {int(ov['executed']) - int(ov['current_'])})",
        ),
    ]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", required=True)
    ap.add_argument("--tenant", action="append", required=True, help="organization/workspace (repeatable)")
    ap.add_argument("--days", type=int, nargs="+", default=[7, 30, 90, 180])
    a = ap.parse_args()
    bad = 0
    for tenant in a.tenant:
        org, ws = tenant.split("/", 1)
        for days in a.days:
            print(f"== {tenant} · {days} days")
            for name, ok, detail in run(a.project, org, ws, days):
                print(f"  {'OK  ' if ok else 'FAIL'} {name}: {detail}")
                bad += 0 if ok else 1
    print("all numbers agree" if not bad else f"{bad} identities do not hold")
    return 0 if not bad else EXIT_MISMATCH


if __name__ == "__main__":
    sys.exit(main())
