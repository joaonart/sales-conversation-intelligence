# Operations
- Historical run: preview eligible sessions and estimated cost; obtain approval; enqueue job; checkpoint by stable `(updated_at, session_id)` cursor.
- Live: monitor Pub/Sub oldest-unacked age, duplicate rate, late arrivals, BigQuery source freshness, p95 analysis latency, cache hit ratio.
- Reprocess: new rubric version creates new analysis IDs; never mutate old results; latest view chooses intended version.
- Incident: disable optional AI, keep ingesting session-change events, preserve DLQ, resume with controlled backlog.
- Monitor: OpenAI spend, BigQuery query bytes, Cloud Run requests/cold starts, logs volume, failure ratios.

## Enabling AI (requires an approved deployment plan)
1. Build and push images to the Artifact Registry repo; set `live_image` / `historical_image`; plan and review.
2. Add the OpenAI key secret version; set `attach_openai_secret = true`.
3. Historical: run `preflight`, review the report (sessions, tokens, cost range), then `run --approved` with `AI_ENABLED=true` and the approved `--max-cost-usd`.
4. Live: set tenants in `tenants_json`, then `ai_enabled = true`. While disabled the push endpoint returns 503 and Pub/Sub retains the backlog (7 days) with backoff.
5. Kill switch: `ai_enabled = false` (or scale the live service to 0). Events keep queueing; nothing is dropped.

## Verified on real GCP (dev, 2026-10-28)
Findings from the first runs against real BigQuery and OpenAI; each one changed the code.
- **JSON columns in load jobs** must receive native JSON values. A Python `str` (even holding JSON text) is stored as a JSON *string* scalar
  (`JSON_TYPE = string`) and `JSON_VALUE(col, '$.k')` returns NULL. The writer and `scripts/seed_synthetic.py` now send objects.
- **Duplicate load `job_id`** returns `409 Already Exists`. The writer treats it as an idempotent retry only if the existing job is `DONE`
  without `error_result`; otherwise it re-raises.
- **A run with failed sessions** ends as `COMPLETED_WITH_FAILURES`, not `COMPLETED`; relaunching rescans and retries only the failed sessions.
- **OpenAI model access propagates unevenly**: right after enabling `gpt-6-luna`, the same key returned 200 and `403 project does not have access to this model`
  on parallel requests for several minutes. 403 is fail-fast in the adapter by design; relaunching the (idempotent) job is the remedy.
- **Decisions usage reported `output_tokens: 0`** in the first two real responses (consistent with the guide, not with the pricing page). Keep the conservative $0.50/1M in gates.
- `scripts/run_fake_pilot.py` runs the full historical pipeline on real BigQuery with a deterministic fake provider (zero AI cost; results carry `model = fake-deterministic`).
- `scripts/seed_synthetic.py --reset` deletes only `synthetic-*` rows (config + analytics) before reloading.
