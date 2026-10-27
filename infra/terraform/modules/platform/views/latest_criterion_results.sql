SELECT
 c.analysis_id, c.organization_id, c.workspace_id, c.session_id, a.rubric_id, a.rubric_version, c.criterion_id,
 c.criterion_weight, c.normalized_score, c.weighted_score, c.applicability_status, c.confidence,
 c.evidence_message_ids, c.evaluated_at
FROM `${project}.${dataset}.session_criterion_results` c
JOIN `${project}.${dataset}.latest_session_analyses` a
 ON a.analysis_id = c.analysis_id AND a.organization_id = c.organization_id AND a.workspace_id = c.workspace_id
QUALIFY ROW_NUMBER() OVER (PARTITION BY c.analysis_id, c.criterion_id ORDER BY c.evaluated_at DESC) = 1
