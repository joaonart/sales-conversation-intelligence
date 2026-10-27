SELECT organization_id, workspace_id, session_id, rubric_id, rubric_version, analysis_id, completed_at
FROM `${project}.${dataset}.current_session_results`
WHERE analysis_status = 'NEEDS_REVIEW'
