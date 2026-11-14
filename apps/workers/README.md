# Workers
- `sci_workers.historical` / `historical_main`: the historical batch. It runs from the command line or through the console executor; it can also be a Cloud Run Job, but that job is created only when `historical_image` is set (dev does not set it). `preflight` (no AI) then `run` (needs `AI_ENABLED=true` + `--approved`).
  Run ids are deterministic, so re-launching resumes from the checkpoint. Counters are cumulative attempts: a page
  interrupted by a budget stop is re-counted in `sessions_total` when resumed (its finished sessions show as skipped).
- `live` (`live_app`, `live_main`): Cloud Run service. `/pubsub/push` (OIDC, Pub/Sub SA) validates the tenant allowlist and creates a debounced Cloud Task; `/tasks/evaluate` (OIDC, Tasks SA) re-reads BigQuery, dedupes by content hash, applies rate/budget gates and evaluates. AI stays disabled (push returns 503 so Pub/Sub retains the backlog) until the OpenAI adapter is approved.
- Same engine/scoring as the API via `packages/evaluation-core`.
