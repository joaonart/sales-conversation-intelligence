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
With `live_evidence_model` set, each live analysis makes a second call (Responses API, `gpt-4o-mini` recommended): the conversation again plus the criteria and answers as input, and the ids of the messages that support each answer as output (at most 800 tokens). **Measured in dev on 2026-11-03** (`exemplo-001-t3`, six short messages, seven criteria): USD 0.000305 per analysis (1,982 tokens in, 135 out), 2.08x the USD 0.0001465 of the same conversation without the step, and about 9.8 s instead of 1.1 s end to end (the live path is asynchronous, so nobody waits for it). An earlier estimate of USD 0.00025 was too low: the second call re-reads the whole conversation and writes ids for every criterion. Plan on about **twice** the cost of an analysis without evidence; at that rate the live monthly cap of USD 0.50 covers more than 1,600 analyses. The caps and gates price both calls (`sci_openai.pricing.with_evidence`), so turning it on can only make the gate stricter.

## General evaluation (prepared, off by default)
One more Responses call per analysis whose rubric carries a prompt, on a worker configured with a summary model. **Estimate, to be measured on the first real run:** with `gpt-4o-mini`, about 1,800 tokens in and 350 out, so about USD 0.0005; an analysis with decision, evidence and summary would then cost about USD 0.0008 (it was USD 0.0003 with decision and evidence). The live monthly cap of USD 0.50 would cover about 600 analyses of that kind instead of 1,600. With `gpt-4o` the same call is about USD 0.008, roughly 16 times more, which is why `gpt-4o-mini` is the recommendation. The ceilings and gates already price the extra call (`sci_openai.pricing.with_summary`: input x2 on top of the analysis rates, output on both), every call is a ledger row (`kind = SUMMARY`), and the console's estimate adds it when the rubric asks for one.
