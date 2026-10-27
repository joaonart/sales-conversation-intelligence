-- TEMPLATE: map your real tables to the canonical contract read by packages/bigquery-adapter.
-- Replace SOURCE_* placeholders. Keep partitioning on the underlying tables (views inherit pruning
-- when predicates are on the partition column: started_at / created_at). Never SELECT * in the view.
CREATE OR REPLACE VIEW `PROJECT_ID.commerce.sessions` AS
SELECT
  tenant_id AS organization_id, workspace_id, CAST(id AS STRING) AS session_id,
  channel, customer_id, seller_id, status, started_at, updated_at, closed_at, metadata
FROM `PROJECT_ID.SOURCE_DATASET.SOURCE_SESSIONS`;

CREATE OR REPLACE VIEW `PROJECT_ID.commerce.messages` AS
SELECT
  tenant_id AS organization_id, workspace_id, CAST(session_id AS STRING) AS session_id,
  CAST(id AS STRING) AS message_id, sender_id, sender_type, message_type,
  body AS content, created_at, sequence_number, metadata
FROM `PROJECT_ID.SOURCE_DATASET.SOURCE_MESSAGES`;
