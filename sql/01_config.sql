CREATE SCHEMA IF NOT EXISTS `PROJECT_ID.conversation_config` OPTIONS(location='US');
CREATE TABLE IF NOT EXISTS `PROJECT_ID.conversation_config.evaluation_rubrics` (
 organization_id STRING NOT NULL, workspace_id STRING NOT NULL, rubric_id STRING NOT NULL,
 version INT64 NOT NULL, name STRING, status STRING NOT NULL, published_at TIMESTAMP,
 created_at TIMESTAMP NOT NULL, description STRING
) CLUSTER BY organization_id, workspace_id, rubric_id;
CREATE TABLE IF NOT EXISTS `PROJECT_ID.conversation_config.evaluation_criteria` (
 organization_id STRING NOT NULL, workspace_id STRING NOT NULL, rubric_id STRING NOT NULL,
 rubric_version INT64 NOT NULL, criterion_id STRING NOT NULL, criterion_name STRING,
 evaluation_instructions STRING, evaluation_type STRING NOT NULL,
 weight NUMERIC NOT NULL, required BOOL NOT NULL, enabled BOOL NOT NULL,
 applicability_rule JSON, score_mapping JSON, choices JSON, score_levels JSON,
 display_order INT64
) CLUSTER BY organization_id, workspace_id, rubric_id;
CREATE TABLE IF NOT EXISTS `PROJECT_ID.conversation_config.evaluation_policies` (
 organization_id STRING NOT NULL, workspace_id STRING NOT NULL, rubric_id STRING NOT NULL,
 rubric_version INT64 NOT NULL, minimum_approval_score NUMERIC,
 missing_evidence_policy STRING, not_applicable_policy STRING,
 max_analyses_per_session INT64, max_input_tokens INT64, monthly_budget_usd NUMERIC,
 min_messages INT64, min_customer_messages INT64, min_seller_messages INT64
) CLUSTER BY organization_id, workspace_id, rubric_id;
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
