SELECT * EXCEPT(rn) FROM (
 SELECT r.*, ROW_NUMBER() OVER (PARTITION BY organization_id, workspace_id, session_id ORDER BY decided_at DESC, route_id DESC) AS rn
 FROM `${project}.${dataset}.session_routes` r
) WHERE rn = 1
