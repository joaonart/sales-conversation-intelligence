SELECT
 organization_id, workspace_id, DATE(created_at) AS day, processing_mode, run_status,
 COUNT(*) AS runs,
 SUM(sessions_processed) AS sessions_processed,
 SUM(sessions_failed) AS sessions_failed,
 SUM(sessions_skipped) AS sessions_skipped,
 SUM(actual_cost_usd) AS actual_cost_usd
FROM `${project}.${dataset}.latest_analysis_runs`
GROUP BY organization_id, workspace_id, day, processing_mode, run_status
