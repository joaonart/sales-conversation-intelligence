SELECT
 organization_id, workspace_id, DATE(decided_at) AS day, model, route_key, route_state,
 COUNT(DISTINCT route_id) AS decisions,
 SUM(estimated_cost_usd) AS cost_usd,
 SUM(input_tokens) AS input_tokens
FROM `${project}.${dataset}.session_routes`
GROUP BY organization_id, workspace_id, day, model, route_key, route_state
