SELECT * EXCEPT(rn) FROM (
 SELECT a.*, ROW_NUMBER() OVER (
 PARTITION BY organization_id, workspace_id, session_id, rubric_id
 ORDER BY rubric_version DESC, completed_at DESC, analysis_id DESC
 ) AS rn
 FROM `${project}.${dataset}.latest_session_analyses` a
) WHERE rn = 1
