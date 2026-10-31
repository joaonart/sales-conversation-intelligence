# Console executor (optional)

Executes the requests an ADMIN made in the admin console (`run_requests`). **The platform does not depend on it**: the historical job, the live
worker and the API never read the console tables (`tests/test_console_is_optional.py`). This package sits outside those directories on purpose
and uses the existing jobs (`sci_workers.routing`, `sci_workers.historical`) unchanged.

```
python -m sci_console_executor.main once --project P --tenant org/workspace [--tenant ...] --routes-file config/routes.json \
  --input-price-per-million 0.125 --output-price-per-million 0.5
```

* `list` shows the waiting requests; it never claims anything and never calls an AI provider.
* `once` claims and runs up to `--limit` waiting requests, then exits. It refuses to start unless `AI_ENABLED=true` (the second gate: the
  console request is the first) and an OpenAI key is available (`OPENAI_API_KEY_FILE`).
* The model, provider and prices are executor configuration. A request cannot choose them.
* Each request is re-validated here (kinds, window, ceilings, published rubric, requester still an active ADMIN), preflighted with the
  requester's cost ceiling, and run through the same gates as the CLI jobs. A job that cannot be approved ends as `FAILED` with the reason.
* Only requests of the tenants named with `--tenant` are considered.
