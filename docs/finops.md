# FinOps guardrails

Costs depend on message volume, BigQuery bytes scanned, Cloud Run CPU/memory/time, Pub/Sub, Cloud Scheduler, networking, logs, and OpenAI token charges. **No universal fixed monthly cost can be promised.**

- Preflight every historical job: session count, estimated token range, query dry-run bytes, expected Cloud Run runtime, maximum authorized USD.
- Hard internal gates: max sessions/run, max analyses/session/hour, tokens/request, concurrency, tenant daily/monthly budget. Cloud Billing budgets alert but do not automatically cap spend.
- Historical: partition-pruned scans, grouped session fetch, bounded parallelism, checkpointed batches; avoid per-session BigQuery queries.
- Live: event-driven with debounce and hash-based dedupe; no per-message OpenAI call by default.
- Cache published rubrics and immutable evaluations; cache keys include tenant, session hash, rubric version, provider/model/prompt version.
- Write results using bounded batches/Storage Write API; avoid row-by-row DML and repeated MERGE.
- BigQuery: partitions and clustering, max_bytes_billed, dry run, aggregate dashboard tables, no SELECT * in production.
- Budget guard must fail closed for optional analysis; never drop incoming events without trace.

## Controls implemented (dev)
| Control | Where | What it stops |
|---|---|---|
| `ai_spend` ledger | every paid call, recorded when the provider answers (before the result is scored or stored) | spend that the stored analyses alone would not show (a failed write, a concurrent twin) |
| Live monthly cap (`live_monthly_budget_usd`) | live worker, reads the ledger | live analyses once the month's spend is reached (`BUDGET_BLOCKED`) |
| Executor monthly budget (`executor_monthly_budget_usd`) | executor, reads the same ledger | a request whose ceiling would not fit what is left of the month (refused with the numbers) |
| Ceiling per request / per run of a schedule | console and executor (`executor_max_cost_ceiling`, per-request cap) | one run spending more than approved |
| Estimate before asking, preflight before running | console, jobs | surprises: the request is refused if the worst case passes its ceiling |
| Content-hash dedupe | live, historical, executor | paying twice for the same content: a schedule only pays for new or changed sessions |
| Kill switches | `live_ai_enabled`, `executor_ai_enabled`, Scheduler job, schedules | everything above, by hand |
Infrastructure costs stay near zero by design: scale-to-zero compute, an executor poll inside the free tier, the first Cloud Scheduler job free, small append-only tables. `gold_cost_daily` counts STORED analyses; the complete spend is the ledger.

## Cost model
`monthly_estimate = BQ_query_TB * price_per_TB + CloudRun_vCPU_seconds * cpu_rate + CloudRun_GiB_seconds * mem_rate + PubSub_GiB * pubsub_rate + OpenAI_input_tokens/1e6 * input_rate + OpenAI_output_tokens/1e6 * output_rate + storage + logs + networking`.
Populate rates from official current pricing, including free tiers, region, cached tokens, and actual model behavior. Do not hardcode earlier conversational price claims.

## Evidence step (live, optional)
With `live_evidence_model` set, each live analysis makes a second call (Responses API, `gpt-4o-mini` by default recommendation): roughly the conversation again plus the criteria and answers as input (about 1.3 to 2x the tokens of the analysis) and at most 800 tokens out. For the sample conversation (about 500 tokens in) that is about USD 0.0001 more on top of USD 0.00015, so about USD 0.00025 per analysis, still far under the monthly cap of USD 0.50. The caps and gates price both calls (`sci_openai.pricing.with_evidence`), so turning it on can only make the gate stricter.

