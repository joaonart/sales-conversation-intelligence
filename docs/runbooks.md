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

## Start a test from an empty workspace (data, then audit)
**Data:** `python scripts/clean_workspace.py --project P --org org-test --workspace default` (dry run; add `--apply`). It deletes the conversations and everything produced from them (including the results of "Melhorar prompt" and the text of any prompt that was not kept; a kept prompt and the suggestion requests stay) and, last, the workspace's lines of the spend ledger (`ai_spend`, so the Painel's cost tab starts empty too; the dry run says how much recorded spend that is, and `--keep-spend` keeps it), and never the rubrics, users, schedules or the audit trail. Recent spend is written by a streaming insert and cannot be deleted for about 90 minutes: the data is then cleaned and the script says to run it again later for the ledger. The ledger of an organization that is not a test one is never cleared, not even with `--allow-any-tenant`.
**Audit trail (a separate process, on purpose):** `python scripts/clean_audit.py --project P --org org-test --workspace default` (dry run; add `--apply`; `--before YYYY-MM-DD` clears only older events). It deletes that workspace's rows of `audit_log` and then writes one `audit.clean` event (actor `script:clean_audit`, rows removed, cut-off) so the trail always says it was cleared and when.
Only test organizations (`synthetic-*`, `org-test`) are accepted by either script for the audit: `clean_audit.py` has no flag for any other organization. Both are dry runs by default, filter by organization and workspace with bound parameters, and BigQuery time travel can bring the rows back for 48 hours. Cleaning the data does not clear the audit, and the other way round: do them in the order you need, each is its own decision.

## A request for suggestions on a prompt (Melhorar prompt) does not finish
It uses the same worker, trigger and gates as the execution requests (see "A request stays Aguardando executor"); it only adds what is below.
1. **Stays "Aguardando worker":** the worker passes every 10 minutes (`sci-<env>-executor-poll`) and takes at most `executor_limit` requests per pass, executions first. Wait one pass; if nothing moves, follow the runbook above.
2. **Ends "Falha":** the reason is in the list. "Faça o pedido de novo": the request was made before the numbers were stored with it (v0.59.0) or its prompt text is gone. "Pré-voo não aprovado": the ceiling is below the worst case of the real text (raise it or shorten the prompt). "teto mensal": the month's AI budget has no room. "A IA não devolveu sugestões utilizáveis (Tipo)": the provider refused or answered unusably; if it answered, the cost is on the request and in the ledger (`kind = SUGGESTION`); ask again.
3. **Stays "Em andamento" for long:** the worker died after taking it (it never retries by itself). The request cannot be cancelled while RUNNING; it stays so. Its prompt text (when not kept) stays too: `scripts/clean_workspace.py` removes it, or run the delete of `agent_prompts` rows `NOT retained` of that workspace.
4. **Money:** the ledger line has `subject_id` = the request id and no session; the Painel shows it as "Sugestões de prompt". A call that got no answer has no line and costs nothing.
