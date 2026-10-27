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
