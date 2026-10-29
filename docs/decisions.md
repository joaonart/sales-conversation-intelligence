> Status: items 1-2 and 7 validated on 2026-10-27, see `docs/openai-validation.md`. Decisions returns no evidence citations.

# AI provider integration checklist
1. Check official OpenAI Decisions API docs for endpoint, model availability, supported question schemas, response fields, and current pricing.
2. Map `predicate`, `choice`, `score` to normalized result `{criterion_id, status, value, confidence?, evidence_message_ids?}`. Evidence may require a separate extraction step; never pretend Decisions returned citations it did not.
3. Store raw provider response only if privacy policy permits; otherwise store minimal normalized output and diagnostic metadata.
4. Version provider adapter, prompt templates, rubric, model, and scoring mapping.
5. Provider uncertainty is **not** the business score; mapping must be configured in rubric.
6. Responses API for structured extraction and summaries only when needed; batch or cache long-session summaries.
7. Implement retries for transient errors, backoff with jitter, circuit breaker, timeouts, rate limits, and spending gates.

# Approval reason is persisted (session_analyses.approval_reason, JSON)
A 87.5 analysis can be REJECTED: a **required** criterion below `minimum_approval_score` rejects regardless of the weighted average. The status alone hid why,
so `calculate_score` now returns `approval_reason = {minimum, overall, reasons[]}` and the engine stores it next to the status.
- Reason codes are fixed (`REQUIRED_CRITERION_BELOW_MINIMUM`, `OVERALL_BELOW_MINIMUM`, `MEETS_MINIMUM`, `INSUFFICIENT_EVIDENCE`, `NO_APPLICABLE_CRITERIA`) and carry criterion ids and
  scores only: no conversation text, so no PII. The decision itself is unchanged (a test pins it).
- The column is the last one in the table (BigQuery only appends columns), nullable, so analyses written before it existed have NULL and the console shows no reason for them.
- The console re-parses and rebuilds the JSON from known fields before showing it (it never renders stored text as-is) and explains the reason in Portuguese on the session and review screens.
- Expected cost: none (a few bytes per analysis). Infra: one in-place schema change (`terraform plan`: 0 add, 1 change, 0 destroy), applied per environment only with approval.
