SELECT
 organization_id, workspace_id, rubric_id, rubric_version, DATE(completed_at) AS day,
 COUNT(*) AS sessions,
 COUNTIF(overall_score IS NOT NULL) AS scored_sessions,
 AVG(overall_score) AS avg_score,
 COUNTIF(approval_status = 'APPROVED') AS approved,
 COUNTIF(approval_status = 'REJECTED') AS rejected,
 COUNTIF(analysis_status = 'NEEDS_REVIEW') AS needs_review,
 COUNTIF(analysis_status = 'NOT_EVALUABLE') AS not_evaluable,
 SAFE_DIVIDE(COUNTIF(approval_status = 'APPROVED'), COUNTIF(overall_score IS NOT NULL)) AS approval_rate
FROM `${project}.${dataset}.current_session_results`
GROUP BY organization_id, workspace_id, rubric_id, rubric_version, day
