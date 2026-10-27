# Operations
- Historical run: preview eligible sessions and estimated cost; obtain approval; enqueue job; checkpoint by stable `(updated_at, session_id)` cursor.
- Live: monitor Pub/Sub oldest-unacked age, duplicate rate, late arrivals, BigQuery source freshness, p95 analysis latency, cache hit ratio.
- Reprocess: new rubric version creates new analysis IDs; never mutate old results; latest view chooses intended version.
- Incident: disable optional AI, keep ingesting session-change events, preserve DLQ, resume with controlled backlog.
- Monitor: OpenAI spend, BigQuery query bytes, Cloud Run requests/cold starts, logs volume, failure ratios.
