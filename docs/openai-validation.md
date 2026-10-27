# OpenAI contract validation (checked 2026-10-27)

Re-verify every item before production enablement; the adapter pins what it relied on here.

## Sources
- Guide: https://developers.openai.com/api/docs/guides/decisions
- Reference (`DecisionCreateParams`, `Decision`): https://developers.openai.com/api/reference/typescript/resources/decisions/methods/create.md
- Pricing: https://developers.openai.com/api/docs/pricing
- Rate limits: https://developers.openai.com/api/docs/guides/rate-limits
- Responses structured outputs: https://developers.openai.com/api/docs/guides/structured-outputs

## Decisions API (`POST /v1/decisions`)
| Item | Documented | Adapter behaviour |
|---|---|---|
| Model | only `gpt-6-luna` | hard-coded |
| Request | `model`, `input` (string or messages), `questions` (1-400), optional `prompt_cache_key`, `prompt_cache_options`, `safety_identifier` | sends developer guard + user conversation; `safety_identifier` = opaque per-tenant hash; >400 criteria are chunked |
| Question types | `predicate`; `choice` (2-255 unique `value`s); `score` (2-10 `levels`, lowest to highest) | PREDICATE/CHOICE/SCORE map 1:1; levels ordered by mapped score, never by dict order |
| Answers | predicate `probability`; choice `choice`+`confidence`+`probabilities`; score `score` (weighted average of level indices)+`probabilities`; any question may return `refusal` | refusal / unmappable -> INSUFFICIENT_EVIDENCE (never 0) |
| Evidence | **no citations or explanations** | none fabricated; optional separate Responses step |
| Usage | `input_tokens` (incl. cached and cache writes), `cached_tokens`, `cache_write_tokens`, `output_tokens` | cost computed per component; missing usage -> error (budget would be blind) |
| ZDR / residency | ZDR eligible; regional processing US and EEA+CH | residency uplift is a price `multiplier` |

### Undocumented points handled defensively
- Score index base (0 or 1) is not stated: inferred from `probabilities[].value`; ambiguous -> abstain.
- Predicate -> boolean uses a configured threshold (default 0.5). Optional `min_decision_margin` routes near-threshold answers to review. Both are in `prompt_version`.
- Question `name` has no documented pattern/length limit; criterion ids are used and validated on the way back.
- Decisions-specific rate limits are not documented; the limits page lists tiered RPM/TPM for a "Luna" group without saying it covers `gpt-6-luna`. Adapter: concurrency cap, `Retry-After` as a minimum plus jitter, exponential backoff, bounded attempts and total time, circuit breaker; SDK retries are not used (no multiplication). 429 `insufficient_quota` is never retried.

## Pricing used (gpt-6-luna, Standard, <=272K context; USD / 1M tokens)
input 0.10, cached input 0.01, cache write (30m) 0.125, output 0.50; data-residency endpoints +10%; >272K context ~2x input (the adapter refuses requests above `max_input_tokens`, default 200K, so the short tier always applies).

**Discrepancy:** the Decisions guide says output tokens are not charged; the pricing page lists 0.50. The higher figure is used for gates and estimates until OpenAI clarifies.

## Responses API (optional evidence step)
Structured Outputs via `text.format = {type: json_schema, strict: true, name, schema}` with `additionalProperties: false` and all properties required; `store: false`; handles `status: incomplete` and `refusal`. The model id and prices are mandatory configuration (not defaulted). Returned message ids are validated against the session; invalid ids are dropped.
