-- OPTIONAL: tables used only by the admin console (apps/admin-console). The evaluation engine, the historical job, the live
-- worker and the API never read or write them; skip this file if you do not run the console.
-- Terraform creates them only when enable_admin_console = true.
-- Admin console access control: append-only, the latest row per (organization, workspace, email) wins.
CREATE TABLE IF NOT EXISTS `PROJECT_ID.conversation_config.app_users` (
 organization_id STRING NOT NULL, workspace_id STRING NOT NULL, email STRING NOT NULL,
 role STRING NOT NULL, status STRING NOT NULL, changed_at TIMESTAMP NOT NULL, changed_by STRING NOT NULL
) CLUSTER BY organization_id, workspace_id, email;
-- Admin console audit trail (writes and reads of conversation content). Append-only; no message text is stored.
CREATE TABLE IF NOT EXISTS `PROJECT_ID.conversation_config.audit_log` (
 event_id STRING NOT NULL, occurred_at TIMESTAMP NOT NULL, actor_email STRING NOT NULL,
 organization_id STRING, workspace_id STRING, action STRING NOT NULL, entity_type STRING, entity_id STRING,
 outcome STRING NOT NULL, details JSON, request_id STRING
) PARTITION BY DATE(occurred_at) CLUSTER BY organization_id, workspace_id;
-- Human review decisions on analyses that ended in NEEDS_REVIEW. Append-only and kept NEXT TO the analysis: a decision never changes
-- the analysis, its score or its status (scoring stays deterministic). One decision per analysis_id; a new analysis is a new review.
-- The console hides decided analyses from its queue; the review_queue view itself is untouched.
CREATE TABLE IF NOT EXISTS `PROJECT_ID.conversation_config.review_decisions` (
 decision_id STRING NOT NULL, decided_at TIMESTAMP NOT NULL, organization_id STRING NOT NULL, workspace_id STRING NOT NULL,
 session_id STRING NOT NULL, analysis_id STRING NOT NULL, rubric_id STRING NOT NULL, rubric_version INT64 NOT NULL,
 analysis_status STRING NOT NULL, decision STRING NOT NULL, comment STRING, reviewer_email STRING NOT NULL
) CLUSTER BY organization_id, workspace_id, session_id;
