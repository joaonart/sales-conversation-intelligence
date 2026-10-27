SELECT
 organization_id, workspace_id, rubric_id, rubric_version, criterion_id, DATE(evaluated_at) AS day,
 COUNT(*) AS evaluations,
 COUNTIF(applicability_status = 'APPLICABLE') AS applicable,
 COUNTIF(applicability_status = 'NOT_APPLICABLE') AS not_applicable,
 COUNTIF(applicability_status = 'INSUFFICIENT_EVIDENCE') AS insufficient_evidence,
 AVG(IF(applicability_status = 'APPLICABLE', normalized_score, NULL)) AS avg_normalized_score,
 SAFE_DIVIDE(COUNTIF(applicability_status = 'INSUFFICIENT_EVIDENCE'), COUNT(*)) AS insufficient_rate
FROM `${project}.${dataset}.latest_criterion_results`
GROUP BY organization_id, workspace_id, rubric_id, rubric_version, criterion_id, day
