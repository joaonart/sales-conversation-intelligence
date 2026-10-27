-- Replace PROJECT_ID; append-only results can be duplicated by retries.
CREATE OR REPLACE VIEW `PROJECT_ID.conversation_analytics.latest_session_analyses` AS
SELECT * EXCEPT(rn) FROM (
 SELECT a.*, ROW_NUMBER() OVER (
 PARTITION BY organization_id, workspace_id, session_id, rubric_id, rubric_version, session_content_hash
 ORDER BY completed_at DESC, analysis_id DESC
 ) AS rn
 FROM `PROJECT_ID.conversation_analytics.session_analyses` a
 WHERE analysis_status='COMPLETED'
) WHERE rn=1;
