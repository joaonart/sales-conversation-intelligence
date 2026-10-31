CREATE SCHEMA IF NOT EXISTS `PROJECT_ID.conversation_analytics` OPTIONS(location='US');
CREATE TABLE IF NOT EXISTS `PROJECT_ID.conversation_analytics.session_analyses` (
 analysis_id STRING NOT NULL, organization_id STRING NOT NULL, workspace_id STRING NOT NULL,
 session_id STRING NOT NULL, rubric_id STRING NOT NULL, rubric_version INT64 NOT NULL,
 analysis_mode STRING NOT NULL, session_content_hash STRING NOT NULL,
 analysis_status STRING NOT NULL, overall_score FLOAT64, approval_status STRING,
 model STRING, prompt_version STRING, estimated_cost_usd NUMERIC,
 processing_duration_ms INT64, started_at TIMESTAMP, completed_at TIMESTAMP,
 approval_reason JSON  -- appended last: BigQuery only allows new columns at the end
) PARTITION BY DATE(started_at) CLUSTER BY organization_id, workspace_id, session_id, rubric_id;
CREATE TABLE IF NOT EXISTS `PROJECT_ID.conversation_analytics.session_criterion_results` (
 analysis_id STRING NOT NULL, organization_id STRING NOT NULL, workspace_id STRING NOT NULL,
 session_id STRING NOT NULL, criterion_id STRING NOT NULL, criterion_weight NUMERIC,
 evaluation_result JSON, normalized_score FLOAT64, weighted_score FLOAT64,
 applicability_status STRING, confidence FLOAT64, evidence_message_ids ARRAY<STRING>,
 evaluated_at TIMESTAMP NOT NULL
) PARTITION BY DATE(evaluated_at) CLUSTER BY organization_id, workspace_id, session_id;
CREATE TABLE IF NOT EXISTS `PROJECT_ID.conversation_analytics.analysis_runs` (
 run_id STRING NOT NULL, organization_id STRING NOT NULL, workspace_id STRING NOT NULL,
 rubric_id STRING, rubric_version INT64, processing_mode STRING, run_status STRING,
 sessions_total INT64, sessions_processed INT64, sessions_failed INT64, sessions_skipped INT64,
 estimated_cost_usd NUMERIC, actual_cost_usd NUMERIC, checkpoint STRING,
 created_at TIMESTAMP NOT NULL, finished_at TIMESTAMP
) PARTITION BY DATE(created_at) CLUSTER BY organization_id, workspace_id;
-- Routing: which rubric each session was sent to (or none), by which model and route definitions. Append-only; the view picks the latest decision.
CREATE TABLE IF NOT EXISTS `PROJECT_ID.conversation_analytics.session_routes` (
 route_id STRING NOT NULL, organization_id STRING NOT NULL, workspace_id STRING NOT NULL,
 session_id STRING NOT NULL, session_content_hash STRING NOT NULL,
 route_key STRING NOT NULL, rubric_id STRING, rubric_version INT64, route_state STRING NOT NULL,
 model STRING, prompt_version STRING, input_tokens INT64, output_tokens INT64, estimated_cost_usd NUMERIC,
 decided_at TIMESTAMP NOT NULL
) PARTITION BY DATE(decided_at) CLUSTER BY organization_id, workspace_id, session_id;
