# Workers
- `sci_workers.historical` / `historical_main`: Cloud Run Job. `preflight` (no AI) then `run` (needs `AI_ENABLED=true` + `--approved`).
  Run ids are deterministic, so re-launching resumes from the checkpoint. Counters are cumulative attempts: a page
  interrupted by a budget stop is re-counted in `sessions_total` when resumed (its finished sessions show as skipped).
- `live/`: Pub/Sub push consumer — phase 4 (placeholder still fails closed).
- Same engine/scoring as the API via `packages/evaluation-core`.
