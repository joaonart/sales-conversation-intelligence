# Runbooks
All commands are operator actions; none are executed by this repository. Always scope by tenant and bound by date.

## Signals
Logs are JSON, metadata-only (`event`, `outcome`, `latency_ms`, `cost_usd`, ids). Useful filters in Logs Explorer:
`jsonPayload.event="live_event" jsonPayload.outcome="BUDGET_BLOCKED"`, `jsonPayload.event="session_failed"`, `jsonPayload.event="task_retry"`.

## Backlog growing / oldest unacked age alert
1. Check `jsonPayload.event="task_retry"` by `error_type`. `NotReady` => source lag (check ingestion freshness); `AIDisabled` => AI switched off (expected, backlog is retained); `QueryTooExpensive` => a bytes cap is too low or a filter lost partition pruning.
2. Provider errors: `TransientProviderError`/`CircuitOpen` => OpenAI degraded; do nothing, retries back off and the circuit recovers; if > 1 h, set `ai_enabled=false` to stop retry churn.
3. Never purge the subscription. Backlog retention is 7 days.

## DLQ not empty
1. Pull a few messages from the DLQ hold subscription; payloads contain ids only.
2. `malformed_event` => fix the producer against `contracts/session-update.schema.json`. `tenant_rejected` => add the tenant to `tenants_json` only after confirming authorisation.
3. Replay: publish the corrected events to the main topic (idempotent: same content hash is skipped, no duplicate cost).

## Unexpected spend
1. `gold_cost_daily` by `analysis_mode`, `model`; `gold_run_health` for runaway runs.
2. Kill switch: `ai_enabled=false` (plan/apply by an approver) or scale the live service to 0; cancel Cloud Run Job executions.
3. Tenant monthly budgets block further live analysis (`BUDGET_BLOCKED` rows in `analysis_runs`); historical runs stop at `--max-cost-usd`.

## Historical run
Preflight -> review `approvable`, token and cost range -> approval -> `run --approved`. Resume: relaunch with the same arguments (deterministic `run_id`). Statuses: `BUDGET_STOPPED`, `SESSION_GATE_STOPPED`, `FAILED` are resumable after raising the approved cap or fixing the cause. Never edit past results; a new rubric version creates new analyses.

## Rubric change
Publish a new `version` (published versions are immutable). Live picks it up after the loader TTL (60 s) when the tenant uses "latest". `current_session_results` prefers the highest version.

## Provider contract change / incident
Re-run `docs/openai-validation.md` checks. The adapter rejects unknown answer shapes (`InvalidProviderResponse`) rather than guessing; failures are charged at worst case in the run budget.

## Data subject request (LGPD)
See `docs/privacy.md`: locate by `session_id` in `session_analyses` / `session_criterion_results`; results hold ids, scores and evidence message ids, not message text.
