-- Example canonical source DDL. Adapt via views to real existing tables; do not run against production blindly.
CREATE SCHEMA IF NOT EXISTS `PROJECT_ID.commerce` OPTIONS(location='US');
CREATE TABLE IF NOT EXISTS `PROJECT_ID.commerce.sessions` (
 organization_id STRING NOT NULL, workspace_id STRING NOT NULL, session_id STRING NOT NULL,
 channel STRING, customer_id STRING, seller_id STRING, status STRING,
 started_at TIMESTAMP, updated_at TIMESTAMP, closed_at TIMESTAMP, metadata JSON
) PARTITION BY DATE(started_at) CLUSTER BY organization_id, workspace_id, session_id;
CREATE TABLE IF NOT EXISTS `PROJECT_ID.commerce.messages` (
 organization_id STRING NOT NULL, workspace_id STRING NOT NULL, session_id STRING NOT NULL,
 message_id STRING NOT NULL, sender_id STRING, sender_type STRING, message_type STRING,
 content STRING, created_at TIMESTAMP NOT NULL, sequence_number INT64, metadata JSON
) PARTITION BY DATE(created_at) CLUSTER BY organization_id, workspace_id, session_id;
CREATE TABLE IF NOT EXISTS `PROJECT_ID.commerce.participants` (
 organization_id STRING NOT NULL, workspace_id STRING NOT NULL, session_id STRING NOT NULL,
 participant_id STRING NOT NULL, participant_type STRING, joined_at TIMESTAMP, left_at TIMESTAMP
) PARTITION BY DATE(joined_at) CLUSTER BY organization_id, workspace_id, session_id;
