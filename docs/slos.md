# SLIs and SLOs (proposed; calibrate after real traffic)
| Area | SLI | Objective | Signal / alert |
|---|---|---|---|
| Live freshness | age of oldest unacked event on the live push subscription | 99% of time < 10 min | `oldest_unacked_message_age` alert (Terraform) |
| Live latency | `latency_ms` of `evaluation` log lines (provider + BigQuery reads + write) | p95 < 120 s | `_evaluation_latency_ms` metric + alert |
| Reliability | share of events ending in `EVALUATED`/`DUPLICATE_CONTENT`/other deliberate outcome vs. retried/dead-lettered | >= 99.5% handled without DLQ | DLQ backlog alert; `_failures` metric |
| Correctness | duplicate logical results in `latest_session_analyses` | 0 | scheduled check below |
| Cost | month-to-date spend vs. approved budget | never above the approved cap | `gold_cost_daily`, tenant budget gate, billing budget (alert only) |
| Privacy | log lines containing chat content | 0 | `tests/test_observability_privacy.py`; field allowlist in `sci_core.obs` |

Error budget: 0.5% of live events per 30 days may be retried to DLQ. Exhausting it freezes feature work on the live path until the cause is fixed.

## Periodic checks (run as ad-hoc queries; automate only if justified)
```sql
-- duplicate logical results (must return 0 rows)
SELECT organization_id, workspace_id, session_id, rubric_id, rubric_version, session_content_hash, COUNT(*) n
FROM `PROJECT.conversation_analytics.latest_session_analyses`
GROUP BY 1,2,3,4,5,6 HAVING n > 1;
-- freshness: sessions updated in the last day without a current result
-- (scope by organization_id/workspace_id and a date bound; bytes are capped by max_bytes_billed in the job)
```
