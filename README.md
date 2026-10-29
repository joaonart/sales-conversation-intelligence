# Sales Conversation Intelligence — GCP Monorepo

Implemented per `AGENTS.md` milestones 1-6 (code, tests, IaC, runbooks). **Nothing is deployed and real AI calls are disabled: enabling them requires the approved deployment plan and cost estimate.** All conversation source data and analytical results live in BigQuery. Rubrics and weights are user-managed in BigQuery; no PostgreSQL is required for conversation copies.

## Architecture
- BigQuery source: `commerce.sessions`, `commerce.messages`, `commerce.participants` (canonical, adapt via views).
- BigQuery config: `conversation_config.evaluation_rubrics`, `evaluation_criteria`, `evaluation_policies`.
- BigQuery results: `conversation_analytics.session_analyses`, `session_criterion_results`, `analysis_runs`.
- Cloud Run API: health, evaluation preview (local dry-run), run-request API (to implement).
- Cloud Run Job: historical session batches (to implement).
- Pub/Sub -> Cloud Run worker: live events by session_id (to implement; do not assume BigQuery emits row events).
- OpenAI Decisions/Responses APIs: provider adapter interface; verify current schema and pricing before enabling production calls.
- Cloud Scheduler: optional bounded incremental scan, not full table polling.

## Status
| Area | Where | State |
|---|---|---|
| Rubrics, scoring, engine, PII masking, budget gate | `packages/evaluation-core` | done, tested |
| BigQuery adapter (tenant-scoped, bounded, cost-capped) | `packages/bigquery-adapter` | done, tested incl. SQL semantics on DuckDB |
| OpenAI Decisions + Responses adapter | `packages/openai-adapter` | validated against the docs (`docs/openai-validation.md`); wired into the historical job behind approval gates; pilot on synthetic data (`docs/operations.md`) |
| Historical job / live worker | `apps/workers` | historical runs for real on dev (gated); live worker has AI disabled and is not deployed |
| Analytics views, observability, SLOs, runbooks | `infra/.../views`, `sci_core.obs`, `docs/` | done |
| Terraform dev/prod | `infra/terraform` | dev minimal profile applied (no Cloud Run, no AI); prod never applied |
| Admin console (Apps Script web app, **optional**) | `apps/admin-console`, `docs/admin-console.md` | built and tested locally; **not deployed**; the platform runs without it |

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
