# Sales Conversation Intelligence — GCP Monorepo

Implemented per `AGENTS.md` milestones 1-6 (code, tests, IaC, runbooks). **Dev (project `jnart-intelligence-513001`) runs end to end on GCP: the live worker (Cloud Run, scale to zero, real AI behind a monthly cap), the conversation ingest (Pub/Sub topic, push subscription and Cloud Run service) with a dedicated producer identity, the Pub/Sub event topic with its dead-letter holds, the Cloud Tasks wait queue, the console executor (Cloud Run Job, real AI behind per-request ceilings and a monthly budget) woken every 10 minutes by Cloud Scheduler, recurring schedules, the `ai_spend` ledger and the admin console (Apps Script). The historical job runs through the executor or the command line; prod is prepared and never applied. Every deployment and every real AI run needed an approved plan and cost estimate (`docs/deployment-plan.md`).** All conversation source data and analytical results live in BigQuery. Rubrics and weights are user-managed in BigQuery; no PostgreSQL is required for conversation copies.

## Architecture
Details and the live path: `docs/architecture.md`; how work is triggered: `docs/scheduling.md`.
- BigQuery source: `commerce.sessions` and `commerce.messages` (canonical, adapt via views). The platform reads and writes nothing else of the source: the sample DDL also has a `participants` table, but nothing uses it and the dev dataset does not have it. Written by the producer's own pipeline or by the ingest service.
- BigQuery config: `conversation_config.evaluation_rubrics`, `evaluation_criteria`, `evaluation_policies`, plus the console tables (`app_users`, `audit_log`, `review_decisions`, `run_requests`, `run_schedules`).
- BigQuery results: `conversation_analytics.session_analyses`, `session_criterion_results`, `session_summaries` (the optional general evaluation: positives, negatives and opportunities, written after the score, driven by a prompt the rubric carries), `analysis_runs`, `session_routes`, `run_failures`, `ai_spend` (every paid call, recorded when the provider answers) and the views (`latest_*`, `current_*`, `gold_*`, `review_queue`).
- Conversation ingest (Cloud Run): producers publish conversations to a Pub/Sub topic; the service validates and stores them idempotently and announces them for analysis (`docs/ingest.md`, `docs/producer-guide.md`).
- Live worker (Cloud Run): Pub/Sub push, debounce in Cloud Tasks, bounded reads of one session, content-hash dedupe, monthly AI budget; live events by `session_id` (BigQuery row events are never assumed).
- Console executor (Cloud Run Job): runs the requests and schedules made in the console, under its own gates (`docs/scheduling.md`); Cloud Scheduler wakes it.
- Historical processing: session batches with checkpoints (`historical_main`). In dev it runs **through the console executor or from the command line**; the separate Cloud Run Job `sci-dev-historical` is defined in Terraform but **not deployed** (it exists only if `historical_image` is set).
- Cloud Run API: health and evaluation preview (local dry-run); the run-request API is not implemented (the console and the executor cover it).
- OpenAI Decisions/Responses APIs: provider adapter interface, closed model catalog, prices checked per `docs/openai-validation.md`. What is sent to OpenAI and why, in plain language (pt-BR): `docs/openai-requests.pt-BR.md`.

## Status
| Area | Where | State |
|---|---|---|
| Rubrics, scoring, engine, PII masking, budget gate | `packages/evaluation-core` | done, tested |
| BigQuery adapter (tenant-scoped, bounded, cost-capped) | `packages/bigquery-adapter` | done, tested incl. SQL semantics on DuckDB |
| OpenAI Decisions + Responses adapter | `packages/openai-adapter` | validated against the docs (`docs/openai-validation.md`); wired into the historical job behind approval gates; pilot on synthetic data (`docs/operations.md`) |
| Historical processing / live worker / executor | `apps/workers`, `apps/console-executor` | historical processing runs for real on dev (command line and executor; no separate historical Cloud Run Job is deployed); live worker deployed in dev with AI on (`gpt-6-luna`, monthly cap US$ 0.50), tested end to end with real events; executor deployed in dev with AI on (ceiling US$ 0.10 per request, monthly budget US$ 1.00) and a 10-minute Cloud Scheduler wake-up, first request ran on its own (2026-11-02) |
| Conversation ingest and producer identity | `apps/workers` (`ingest*`), `contracts/`, `docs/ingest.md`, `docs/producer-guide.md` | deployed in dev and tested end to end with real events; producer service account `sci-dev-producer` created (its key is created by a person), test workspace `org-test/default` |
| Analytics views, observability, SLOs, runbooks | `infra/.../views`, `sci_core.obs`, `docs/` | done |
| Terraform dev/prod | `infra/terraform` | dev applied: datasets, tables, views, console tables, live worker and event path, ingest, executor job and scheduler, producer identity, GitHub federation for image builds; prod never applied; state is local |
| Session router (one tiny classification picks the rubric per session; historical `routing_main` + `--only-routed`, live routing) | `sci_core.routing`, `apps/workers`, `docs/routing.md` | applied in dev; the routing pass has run for real (command line and executor); live routing is implemented but enabled for no tenant yet |
| Spend ledger (`ai_spend`) and monthly budgets | `sci_core.spend`, `sci_bq`, `docs/finops.md` | applied in dev; every paid call is recorded before the result is stored; the live cap and the executor budget read it |
| Admin console (Apps Script web app, **optional**) | `apps/admin-console`, `docs/admin-console.md` | deployed in dev (`clasp`); the platform runs without it |

## Samples
`samples/producer-python`: a working Python producer (validates conversations and publishes them to the ingest topic) for whoever integrates a system with the platform. Guides in English (`docs/producer-guide.md`, `samples/producer-python/README.md`) and Portuguese (`*.pt-BR.md`).

## Start here
1. Read `AGENTS.md`, `docs/architecture.md`, `docs/finops.md`, `docs/security.md`.
2. Run `make install && make lint typecheck test` (Python 3.12+).
3. Review `infra/terraform/README.md`, then `terraform plan` with your own GCP project. **Never apply without approval.**
4. Replace canonical sample schema with source views mapping to actual BigQuery tables.
5. Validate API contracts, load test, and enable budget enforcement before production.

## Local demo
```bash
python -m venv .venv && source .venv/bin/activate
make install   # editable installs of the local packages (sci-core is not on PyPI)
make lint typecheck test
uvicorn sci_api.main:app --app-dir apps/api/src --reload
```

No paid resources are provisioned by this repository automatically.
