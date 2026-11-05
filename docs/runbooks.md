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
(The event topic has `sci-<env>-session-updates-dlq-hold`; the conversation ingest has its own, `sci-<env>-conversations-dlq-hold`, whose payloads are whole conversations: handle them as personal data.)
1. Pull a few messages from the DLQ hold subscription; the event payloads contain ids only.
2. `malformed_event` => fix the producer against `contracts/session-update.schema.json`. `tenant_rejected` => add the tenant to `tenants_json` only after confirming authorisation.
3. Replay: publish the corrected events to the main topic (idempotent: same content hash is skipped, no duplicate cost). For the ingest: `malformed`/422 means the producer broke the contract (`docs/ingest.md`), 403 a workspace that is not on the ingest allowlist; fix and republish, it is idempotent.

## Unexpected spend
1. The complete spend is the ledger: `SELECT kind, mode, model, COUNT(*) calls, SUM(cost_usd) usd FROM conversation_analytics.ai_spend WHERE organization_id = ... AND workspace_id = ... AND DATE(occurred_at) >= ... GROUP BY 1,2,3`. `gold_cost_daily` counts only stored analyses; `gold_run_health` shows runaway runs.
2. Kill switches (plan/apply by an approver): `live_ai_enabled=false`, `executor_ai_enabled=false`, pause the Cloud Scheduler job `sci-<env>-executor-poll`, archive the schedules in the console, or scale the live service to 0; cancel Cloud Run Job executions.
3. Monthly budgets block further spend: the live worker records `BUDGET_BLOCKED` rows in `analysis_runs`; the executor refuses a request whose ceiling does not fit what is left of the month (the request ends `FAILED` with the numbers); a run stops at its ceiling (`--max-cost-usd` or the request's).

## A request stays "Aguardando executor" (nothing picks it up)
The console flags it ("Pedido parado" on the executor node of the architecture) after 30 minutes. Check in this order:
1. **The trigger.** Cloud Scheduler job `sci-<env>-executor-poll`: `lastAttemptTime` and `status` (a non-empty status is an error). Logs: `resource.type="cloud_scheduler_job"` (an `AttemptFinished` with an error says the HTTP status).
2. **The job's state.** HTTP 400 `FAILED_PRECONDITION ... in an error state` means the job's `Ready` condition failed. Read it (`gcloud run jobs describe` or the Cloud Run Admin API). `SECRETS_ACCESS_CHECK_FAILED` means its identity could not read the OpenAI key when that revision was created; Cloud Run does **not** re-evaluate it after the grant is added, so once the grant exists, recreate the job with the same configuration (`terraform apply -replace='module.platform.google_cloud_run_v2_job.executor[0]'`, which also restores the job-level invoker grant of the Scheduler's identity).
3. **The gates.** An executor with `AI_ENABLED=false` refuses a waiting request (exit 3) and leaves it untouched; without `EXECUTOR_MONTHLY_BUDGET_USD` it refuses to run (exit 7); a request of a workspace that is not in `executor_tenants` is never seen.
4. **The request itself.** Once picked up, a request that cannot run ends `FAILED` with the reason in the console (requester no longer an active ADMIN, ceiling above the executor's, monthly budget, window or model refused).

## A schedule did not run
Only the LAST due slot is ever run, never from before the schedule was created, edited or resumed, never while the previous run of the same schedule is waiting or running, and not while the workspace already has 3 active requests; a paused or archived schedule does nothing. See `docs/scheduling.md`.

## The producer's key leaked
Delete it at once (`gcloud iam service-accounts keys delete KEY_ID --iam-account=sci-<env>-producer@PROJECT.iam.gserviceaccount.com`) and issue another through a secure channel. The identity can only publish to the conversations topic; check the ingest dead-letter hold and the sessions of the workspaces on the allowlist for events that were not the producer's.

## Historical run
Preflight -> review `approvable`, token and cost range -> approval -> `run --approved`. Resume: relaunch with the same arguments (deterministic `run_id`). Statuses: `BUDGET_STOPPED`, `SESSION_GATE_STOPPED`, `FAILED` are resumable after raising the approved cap or fixing the cause. Never edit past results; a new rubric version creates new analyses.

## Rubric change
Publish a new `version` (published versions are immutable). Live picks it up after the loader TTL (60 s) when the tenant uses "latest". `current_session_results` prefers the highest version.

## Provider contract change / incident
Re-run `docs/openai-validation.md` checks. The adapter rejects unknown answer shapes (`InvalidProviderResponse`) rather than guessing; failures are charged at worst case in the run budget.

## Data subject request (LGPD)
See `docs/privacy.md`: locate by `session_id` in `session_analyses` / `session_criterion_results`; results hold ids, scores and evidence message ids, not message text.

## General evaluation not written (`summary_failed`, `summary_not_written`)
**What it means:** the analysis was stored normally, but the general evaluation could not be written. `summary_not_written` (from the provider adapter) carries the error type: `ProviderRequestError`/`TransientProviderError`/`CircuitOpen`/`QuotaExceeded` (the call failed, nothing was charged), `InvalidProviderResponse` or `Refusal` (an answer was received and charged but unusable). `summary_failed` is the engine's net for anything unexpected.
**What to do:** nothing is lost and no score is affected. Check the provider status and the quota; a single occurrence is noise. The analysis stays without a summary: because the same content is not analysed again, it is written only when the session changes, when the rubric has a new version or when the engine's identity changes. If it keeps happening, switch the summary off (`live_summary_model = ""`) and the worker goes back to one call per analysis.
