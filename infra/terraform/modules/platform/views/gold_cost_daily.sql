SELECT
 organization_id, workspace_id, DATE(started_at) AS day, analysis_mode, model,
 COUNT(DISTINCT analysis_id) AS analyses,
 SUM(estimated_cost_usd) AS cost_usd,
 AVG(processing_duration_ms) AS avg_duration_ms
FROM `${project}.${dataset}.session_analyses`
GROUP BY organization_id, workspace_id, day, analysis_mode, model
