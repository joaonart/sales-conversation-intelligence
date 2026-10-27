# sci-openai
Decisions API provider (`DecisionsProvider`) and optional Responses API evidence extractor.
Contract, sources and discrepancies: `docs/openai-validation.md`.

- `http.OpenAIHttp`: retries (429/5xx/timeouts) honouring `Retry-After`, circuit breaker, concurrency cap; bodies never appear in errors/logs.
- `pricing`: `TokenPrices` with provenance; `worst_case_price_book()` feeds the budget gates.
- API key: pass a provider callable that reads the Secret Manager-injected env var at runtime. Never commit or put it in Terraform state.
- Not wired into the historical/live entrypoints: enabling real calls needs the approved deployment plan.
