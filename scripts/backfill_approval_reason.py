"""Fill `session_analyses.approval_reason` for analyses written before the column existed.

The reason is recomputed with the same `calculate_score` the engine uses, from what was stored (criterion results, rubric criteria,
policy). A row is only updated when the recomputed overall score and approval status equal the stored ones; anything else is
reported and left alone.
Only the NULL `approval_reason` of the selected tenants changes: scores, statuses and every other column are never touched.

Dry run by default (reads only). `--apply` runs one parameterised UPDATE per analysis.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "packages" / "evaluation-core" / "src"))
from sci_core.scoring import Applicability, CriterionResult, MissingEvidencePolicy, calculate_score  # noqa: E402


def recompute(
    analysis: dict[str, Any], results: list[dict[str, Any]], required: dict[str, bool], policy: dict[str, Any]
) -> tuple[dict[str, Any] | None, str]:
    """(reason, why_not). `reason` is None when it cannot be reproduced exactly."""
    if not results:
        return None, "no criterion results stored (analysis never reached scoring)"
    try:
        crit = [
            CriterionResult(
                criterion_id=r["criterion_id"],
                weight=float(r["criterion_weight"] or 0),
                score=None if r["normalized_score"] is None else float(r["normalized_score"]),
                required=required.get(r["criterion_id"], False),
                applicability=Applicability(r["applicability_status"]),
            )
            for r in results
        ]
        score = calculate_score(crit, float(policy["minimum_approval_score"]), MissingEvidencePolicy(policy["missing_evidence_policy"]))
    except (KeyError, ValueError) as exc:
        return None, f"cannot recompute: {type(exc).__name__}"
    stored = analysis["overall_score"]
    same_score = (score.overall_score is None and stored is None) or (
        score.overall_score is not None and stored is not None and abs(score.overall_score - float(stored)) < 1e-6
    )
    if not same_score or score.approval_status != analysis["approval_status"] or score.status != analysis["analysis_status"]:
        return None, f"recomputed {score.status}/{score.approval_status}/{score.overall_score} differs from stored"
    return score.approval_reason, ""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", required=True)
    ap.add_argument("--location", default="US")
    ap.add_argument("--org-prefix", default="synthetic-", help="only organizations whose id starts with this (default: synthetic tenants)")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()

    from google.cloud import bigquery as bq

    client = bq.Client(project=a.project, location=a.location)
    an = f"`{a.project}.conversation_analytics.session_analyses`"
    cr = f"`{a.project}.conversation_analytics.session_criterion_results`"
    cfg = f"`{a.project}.conversation_config`"
    prefix = bq.ScalarQueryParameter("prefix", "STRING", a.org_prefix)

    def q(sql: str, *params: Any) -> list[Any]:
        return list(client.query(sql, job_config=bq.QueryJobConfig(query_parameters=list(params))).result())

    analyses = q(
        "SELECT analysis_id, organization_id, workspace_id, session_id, rubric_id, rubric_version, analysis_status, overall_score, "
        f"approval_status FROM {an} WHERE STARTS_WITH(organization_id, @prefix) AND approval_reason IS NULL "
        "AND analysis_status != 'FAILED'",
        prefix,
    )
    done = skipped = 0
    for row in analyses:
        key = [
            bq.ScalarQueryParameter("o", "STRING", row.organization_id),
            bq.ScalarQueryParameter("w", "STRING", row.workspace_id),
            bq.ScalarQueryParameter("aid", "STRING", row.analysis_id),
            bq.ScalarQueryParameter("r", "STRING", row.rubric_id),
            bq.ScalarQueryParameter("v", "INT64", row.rubric_version),
        ]
        results = [
            dict(x)
            for x in q(
                f"SELECT criterion_id, criterion_weight, normalized_score, applicability_status FROM {cr} "
                "WHERE organization_id=@o AND workspace_id=@w AND analysis_id=@aid",
                *key,
            )
        ]
        required = {
            x.criterion_id: bool(x.required)
            for x in q(
                f"SELECT criterion_id, required FROM {cfg}.evaluation_criteria WHERE organization_id=@o AND workspace_id=@w "
                "AND rubric_id=@r AND rubric_version=@v",
                *key,
            )
        }
        pol = q(
            f"SELECT minimum_approval_score, missing_evidence_policy FROM {cfg}.evaluation_policies WHERE organization_id=@o "
            "AND workspace_id=@w AND rubric_id=@r AND rubric_version=@v",
            *key,
        )
        if not pol:
            skipped += 1
            print(f"skip {row.organization_id}/{row.session_id}: no policy found")
            continue
        reason, why = recompute(
            dict(row),
            results,
            required,
            {"minimum_approval_score": pol[0].minimum_approval_score, "missing_evidence_policy": pol[0].missing_evidence_policy},
        )
        if reason is None:
            skipped += 1
            print(f"skip {row.organization_id}/{row.session_id}: {why}")
            continue
        done += 1
        codes = ",".join(x["code"] for x in reason["reasons"])
        print(f"{'update' if a.apply else 'would update'} {row.organization_id}/{row.session_id} {row.approval_status}: {codes}")
        if a.apply:
            q(
                f"UPDATE {an} SET approval_reason = PARSE_JSON(@reason) WHERE organization_id=@o AND workspace_id=@w AND analysis_id=@aid "
                "AND approval_reason IS NULL",
                *key,
                bq.ScalarQueryParameter("reason", "STRING", json.dumps(reason)),
            )
    print(json.dumps({"candidates": len(analyses), "updated" if a.apply else "would_update": done, "skipped": skipped}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
