SELECT * EXCEPT(rn) FROM (
 SELECT r.*, ROW_NUMBER() OVER (PARTITION BY organization_id, workspace_id, run_id ORDER BY created_at DESC) AS rn
 FROM `${project}.${dataset}.analysis_runs` r
) WHERE rn = 1
