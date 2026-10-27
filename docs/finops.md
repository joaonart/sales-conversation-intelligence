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

## Cost model
`monthly_estimate = BQ_query_TB * price_per_TB + CloudRun_vCPU_seconds * cpu_rate + CloudRun_GiB_seconds * mem_rate + PubSub_GiB * pubsub_rate + OpenAI_input_tokens/1e6 * input_rate + OpenAI_output_tokens/1e6 * output_rate + storage + logs + networking`.
Populate rates from official current pricing, including free tiers, region, cached tokens, and actual model behavior. Do not hardcode earlier conversational price claims.
