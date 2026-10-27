# Sales Conversation Intelligence — GCP Monorepo

Starter kit for an AI coding agent. **Not production-ready without completing the tasks in `AGENTS.md`.** All conversation source data and analytical results live in BigQuery. Rubrics and weights are user-managed in BigQuery; no PostgreSQL is required for conversation copies.

## Architecture
- BigQuery source: `commerce.sessions`, `commerce.messages`, `commerce.participants` (canonical, adapt via views).
- BigQuery config: `conversation_config.evaluation_rubrics`, `evaluation_criteria`, `evaluation_policies`.
- BigQuery results: `conversation_analytics.session_analyses`, `session_criterion_results`, `analysis_runs`.
- Cloud Run API: health, evaluation preview (local dry-run), run-request API (to implement).
- Cloud Run Job: historical session batches (to implement).
- Pub/Sub -> Cloud Run worker: live events by session_id (to implement; do not assume BigQuery emits row events).
- OpenAI Decisions/Responses APIs: provider adapter interface; verify current schema and pricing before enabling production calls.
- Cloud Scheduler: optional bounded incremental scan, not full table polling.

## Start here
1. Read `AGENTS.md`, `docs/architecture.md`, `docs/finops.md`, `docs/security.md`.
2. Run `make install && make test` (Python 3.12+).
3. Review `infra/terraform/README.md`, then `terraform plan` with your own GCP project. **Never apply without approval.**
4. Replace canonical sample schema with source views mapping to actual BigQuery tables.
5. Validate API contracts, load test, and enable budget enforcement before production.

## Local demo
```bash
python -m venv .venv && source .venv/bin/activate
pip install -e 'apps/api[dev]'
pytest -q
uvicorn sci_api.main:app --app-dir apps/api/src --reload
```

No paid resources are provisioned by this repository automatically.
