-- Prompt improvement (console, EDITOR or ADMIN): the person gives the prompt of an agent and the platform suggests how to change it, from the analyses
-- that already exist (aggregated in BigQuery first, then ONE AI call over that summary). OPTIONAL tables used only by the admin console and the
-- on-demand executor; the evaluation engine never touches them. Stage 1 (the free preview) only reads existing tables; these three are created now
-- (empty tables cost nothing) so the contract is fixed before anything writes to them.

-- Prompts given by people, versioned per prompt_id (append-only: a new text is a new version). `retained` = the person chose to keep it (true), or it
-- exists only for ONE request and is deleted when that request ends (false). The text is never written to a log or to the audit trail (only its hash).
CREATE TABLE IF NOT EXISTS `PROJECT_ID.conversation_config.agent_prompts` (
 prompt_id STRING NOT NULL, organization_id STRING NOT NULL, workspace_id STRING NOT NULL, version INT64 NOT NULL,
 name STRING NOT NULL, content STRING NOT NULL, content_hash STRING NOT NULL, retained BOOL NOT NULL,
 created_by STRING NOT NULL, created_at TIMESTAMP NOT NULL
) PARTITION BY DATE(created_at) CLUSTER BY organization_id, workspace_id, prompt_id;

-- Suggestion requests. Append-only like run_requests: every status change is a new row and the latest row per request_id wins. The window is the
-- rubric version + period (+ optional seller) the aggregate was computed for; `prompt_hash` ties the request to the text it was made for.
-- Statuses: REQUESTED, RUNNING, COMPLETED, FAILED, CANCELLED. Costs are the preflight estimate (low/high), the cap approved for the request and what it spent.
-- `aggregate` is the numbers the person saw and approved the cost on (the preview without its examples: no conversation text), written by the console when the
-- request is made and carried by every later row; the executor sends exactly that to the AI, so what was approved is what is sent. Added in console v0.60.0
-- (a nullable column at the end: a table created before it is updated in place, and a request without it is refused by the executor).
CREATE TABLE IF NOT EXISTS `PROJECT_ID.conversation_config.prompt_improvement_requests` (
 request_id STRING NOT NULL, changed_at TIMESTAMP NOT NULL, organization_id STRING NOT NULL, workspace_id STRING NOT NULL, status STRING NOT NULL,
 rubric_id STRING NOT NULL, rubric_version INT64 NOT NULL, period_from DATE NOT NULL, period_to DATE NOT NULL, seller_id STRING,
 prompt_id STRING NOT NULL, prompt_hash STRING NOT NULL, sample_analyses INT64 NOT NULL, sample_sessions INT64 NOT NULL,
 max_cost_usd FLOAT64 NOT NULL, estimate_low_usd FLOAT64, estimate_high_usd FLOAT64, actual_cost_usd FLOAT64,
 provider STRING, model STRING, system_prompt_version STRING,
 requested_by STRING NOT NULL, requested_at TIMESTAMP NOT NULL, changed_by STRING NOT NULL, error STRING,
 aggregate JSON
) PARTITION BY DATE(requested_at) CLUSTER BY organization_id, workspace_id, request_id;

-- What a completed request produced: the aggregate that was sent (so the numbers can be audited), the suggestions (validated against a fixed schema,
-- one block per criterion of the rubric) and the model, prompt version and tokens it took.
CREATE TABLE IF NOT EXISTS `PROJECT_ID.conversation_config.prompt_improvement_results` (
 request_id STRING NOT NULL, organization_id STRING NOT NULL, workspace_id STRING NOT NULL, created_at TIMESTAMP NOT NULL,
 aggregate JSON NOT NULL, suggestions JSON NOT NULL,
 model STRING NOT NULL, system_prompt_version STRING NOT NULL, input_tokens INT64, output_tokens INT64, cost_usd FLOAT64
) PARTITION BY DATE(created_at) CLUSTER BY organization_id, workspace_id, request_id;
