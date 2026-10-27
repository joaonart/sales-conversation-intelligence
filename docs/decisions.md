> Status: items 1-2 and 7 validated on 2026-10-27, see `docs/openai-validation.md`. Decisions returns no evidence citations.

# AI provider integration checklist
1. Check official OpenAI Decisions API docs for endpoint, model availability, supported question schemas, response fields, and current pricing.
2. Map `predicate`, `choice`, `score` to normalized result `{criterion_id, status, value, confidence?, evidence_message_ids?}`. Evidence may require a separate extraction step; never pretend Decisions returned citations it did not.
3. Store raw provider response only if privacy policy permits; otherwise store minimal normalized output and diagnostic metadata.
4. Version provider adapter, prompt templates, rubric, model, and scoring mapping.
5. Provider uncertainty is **not** the business score; mapping must be configured in rubric.
6. Responses API for structured extraction and summaries only when needed; batch or cache long-session summaries.
7. Implement retries for transient errors, backoff with jitter, circuit breaker, timeouts, rate limits, and spending gates.
