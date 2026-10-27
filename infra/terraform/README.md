# Terraform
`modules/platform` is the single module; `environments/dev` and `environments/prod` are thin wrappers.
**Plan only. Never `apply` without the approved deployment plan** (see AGENTS.md).

## What exists
| Area | Resources |
|---|---|
| Data | `conversation_config` / `conversation_analytics` datasets (no env prefix: BigQuery ids cannot contain hyphens; dev and prod are separate projects), 6 tables with schemas generated from `sql/*.sql`, `latest_session_analyses` view, 48h time travel |
| Messaging | session-updates topic, DLQ topic + 7-day hold subscription, push subscription (only when `live_image` is set) with backoff retry and dead-lettering, Cloud Tasks debounce queue with rate limits |
| Runtime (all opt-in by image) | live Cloud Run service (min 0, capped max instances), API service (internal LB only), historical Cloud Run Job (manual execution, no scheduler) |
| Identity | one service account per workload; BigQuery access at dataset scope, custom append-only writer role, queue/service/secret-scoped grants; no keys, no `allUsers`, no primitive roles |
| Secrets | empty OpenAI key secret (region-pinned replica); value added out-of-band; mounted only if `attach_openai_secret = true` |
| FinOps | optional billing budget (alerts only), optional alert policies (backlog age, DLQ), Artifact Registry cleanup of untagged images |

## Cost posture
With no images set the plan creates **no compute**: only APIs, datasets/tables, topics, a queue, IAM, an empty secret and an Artifact Registry repo. Cloud Run scales to zero. Real costs (BigQuery bytes, Cloud Run seconds, Pub/Sub, Tasks, logs, OpenAI tokens) are in the deployment plan, not here.

## Commands
```bash
make terraform-validate        # fmt check + validate dev and prod (no credentials)
make terraform-plan-offline    # dummy-token plan of dev, no cloud calls
# Real plan (needs your project + credentials; still no apply):
cd infra/terraform/environments/dev
cp terraform.tfvars.example terraform.tfvars   # edit; the file is git-ignored
terraform init && terraform plan -out=tfplan
```
Prod: `terraform init -backend-config="bucket=<state-bucket>" -backend-config="prefix=sci/prod"`.

## Manual steps Terraform does not do
1. Create the source views (`sql/05_source_views_template.sql`) in `source_dataset`; its location must equal `bq_location`.
2. Set a project BigQuery daily query quota (the override resource is `google-beta` only):
   `gcloud services quota list --service=bigquery.googleapis.com --consumer=projects/PROJECT` to find the `QueryUsagePerDay` metric, then `gcloud alpha services quota update ...` (verify names first).
3. Add the OpenAI key: `printf %s "$KEY" | gcloud secrets versions add <openai_secret_id> --data-file=-`.
4. Billing budgets only alert. The kill switches are `ai_enabled=false`, `max_cost_usd` per run, tenant monthly budgets, and scaling `live_max_instances` to 0.
