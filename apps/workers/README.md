# Workers — implementation tasks
- `historical`: Cloud Run Job; query partitioned BigQuery session batches, load published rubrics, evaluate, checkpoint, write batches.
- `live`: Pub/Sub push consumer; verify OIDC, debounce by session_id, query current BigQuery context, hash dedupe, evaluate.
- `shared`: same engine/scoring code as API; extract into `packages/evaluation-core` before implementation.
- Do not ship placeholder workers as production-ready. No BigQuery row-change webhook assumption.
