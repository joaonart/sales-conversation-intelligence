SELECT * EXCEPT(rn) FROM (
 SELECT a.*, ROW_NUMBER() OVER (
 PARTITION BY organization_id, workspace_id, session_id, rubric_id, rubric_version, session_content_hash
 ORDER BY completed_at DESC, analysis_id DESC
 ) AS rn
 FROM `${project}.${dataset}.session_analyses` a
 WHERE analysis_status != 'FAILED'
) WHERE rn=1
