# Terraform
`modules/platform` is the single module; `environments/dev` and `environments/prod` are thin wrappers.
**Plan only. Never `apply` without the approved deployment plan** (see AGENTS.md).

## What exists
| Area | Resources |
|---|---|
| Data | `conversation_config` / `conversation_analytics` datasets (no env prefix: BigQuery ids cannot contain hyphens; dev and prod are separate projects), the tables with schemas generated from `sql/*.sql` (results: `session_analyses`, `session_criterion_results`, `analysis_runs`, `session_routes`, `run_failures`, `ai_spend`; console, only with `enable_admin_console`: `app_users`, `audit_log`, `review_decisions`, `run_requests`, `run_schedules`), the `latest_*`, `current_*`, `gold_*` views and `review_queue`, 48h time travel. The source dataset (`commerce`) is NOT created here: only access is granted |
| Messaging | session-updates topic, DLQ topic + 7-day hold subscription, push subscription (only when `live_image` is set) with backoff retry and dead-lettering, Cloud Tasks debounce queue with rate limits; the same shape for the conversations topic of the ingest (only when `ingest_image` is set) |
| Runtime (all opt-in by image) | live Cloud Run service (min 0, capped max instances), conversation ingest service (min 0), console executor Cloud Run Job (manual or scheduled), API service (internal LB only), historical Cloud Run Job (manual execution) |
| Trigger | Cloud Scheduler job that runs the executor (`executor_schedule`, cron in UTC), with its own service account allowed to run that one job. Refused while the executor's AI gate is closed |
| Identity | one service account per workload, including the producer's (`producer_service_account`: may publish to the conversations topic and nothing else); BigQuery access at dataset or table scope, custom append-only writer roles, queue/service/secret-scoped grants; no `allUsers`, no primitive roles; **no keys in Terraform**: GitHub Actions uses federation, and the one key that exists (the producer's) is created by a person and never enters the state |
| Secrets | empty OpenAI key secret (region-pinned replica); value added out-of-band; mounted only if `attach_openai_secret` (live, historical) or `executor_attach_openai_secret` (executor) is true; a job or service that reads it declares that it waits for its grant |
| FinOps | optional billing budget (alerts only, forecast included), alert policies (failure rate, latency, backlog age, dead letters of both topics), the monthly AI budgets (`live_monthly_budget_usd`, `executor_monthly_budget_usd`), Artifact Registry cleanup of untagged images |

## Cost posture
With no images set the plan creates **no compute**: only APIs, datasets/tables, topics, a queue, IAM, an empty secret and an Artifact Registry repo. Cloud Run scales to zero; the executor's poll (about 144 empty runs a day) stays inside the Cloud Run free tier and the first Cloud Scheduler job of a billing account is free. Real costs (BigQuery bytes, Cloud Run seconds, Pub/Sub, Tasks, logs, OpenAI tokens) are in the deployment plan, not here.

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
4. Billing budgets only alert. The kill switches are `ai_enabled=false`, `live_ai_enabled=false`, `executor_ai_enabled=false`, `max_cost_usd` per run, the monthly AI budgets, pausing the Scheduler job, and scaling `live_max_instances` to 0.
5. Create the producer's key when a producer outside Google Cloud needs one (`docs/producer-guide.pt-BR.md`): `gcloud iam service-accounts keys create ...`, hand it over through a secure channel, rotate it every 90 days.
6. Onboarding a workspace also needs data, not only Terraform: a published rubric (`scripts/copy_rubric_to_workspace.py` copies one as a draft) and the first ADMIN row in `app_users` (see `docs/ingest.md`).
