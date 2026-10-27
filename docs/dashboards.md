# Dashboards (cost and quality)
BI tools (Looker Studio / React) read **gold views only** and must filter `organization_id` and `workspace_id` plus a date range. Views are not tenant-scoped by themselves; use authorized views or row access policies for end users. Gold views are plain views over partitioned tables: if dashboard bytes scanned become material, materialise them with a bounded scheduled query (requires approval, see `finops.md`).

| Tile | View | Notes |
|---|---|---|
| Average score, approval rate, sessions per day | `gold_daily_quality` | `approval_rate` ignores unscored sessions |
| Needs-review backlog | `review_queue` | drives human review |
| Criterion health (avg score, insufficient-evidence rate) | `gold_criterion_daily` | high `insufficient_rate` suggests unclear instructions |
| Spend per day / model / mode | `gold_cost_daily` | counts every written analysis |
| Run outcomes and cost | `gold_run_health` | latest checkpoint row per run |
| Current result per session | `current_session_results` | highest rubric version wins |
| Per-criterion rows with evidence ids | `latest_criterion_results` | deduplicated per analysis and criterion |

The SQL is generated into `sql/06_gold_views.sql` (`python scripts/gen_view_sql.py`) from the same files Terraform deploys; a test fails if they drift.
