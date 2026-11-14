> Status: items 1-2 and 7 validated on 2026-10-27, see `docs/openai-validation.md`. Decisions returns no evidence citations.

# AI provider integration checklist
1. Check official OpenAI Decisions API docs for endpoint, model availability, supported question schemas, response fields, and current pricing.
2. Map `predicate`, `choice`, `score` to normalized result `{criterion_id, status, value, confidence?, evidence_message_ids?}`. Evidence may require a separate extraction step; never pretend Decisions returned citations it did not.
3. Store raw provider response only if privacy policy permits; otherwise store minimal normalized output and diagnostic metadata.
4. Version provider adapter, prompt templates, rubric, model, and scoring mapping.
5. Provider uncertainty is **not** the business score; mapping must be configured in rubric.
6. Responses API for structured extraction and summaries only when needed; batch or cache long-session summaries.
7. Implement retries for transient errors, backoff with jitter, circuit breaker, timeouts, rate limits, and spending gates.

# Faster pages: concurrent blocks and a short read cache (console v0.51.2, decided 2026-11-14)
Measured in BigQuery job history (3 days): each console query takes 170–420 ms and reads kilobytes, mostly from the query cache. The wait of a page is the **number of queries run one after the other** inside one Apps Script call (Painel: 5; Como funciona: 14, about 4–6 s).
- **Concurrent blocks:** `dashboard.summary` and `pipeline.overview` accept `parts` (the blocks wanted; none = all, as before; an unknown block is refused). The pages ask for their blocks in 3–4 calls at once and merge the answers, so the wait is the slowest call. A failed call fails the page.
- **Short cache, in the server:** `CacheService` (script cache) keeps a successful answer of `dashboard.summary`/`dashboard.score` for **120 s** and of `pipeline.overview` for **60 s**. The key is the workspace + whether the caller is ADMIN + the whole question (stable order); it is read only **after** the caller was authorised for that workspace. The executor queue and the schedules blocks are live figures and are never cached; writes, errors and values over 80 KB are never cached. `fresh: true` skips it. Trade-off: those numbers can be up to 2 minutes old.
- No new resource, no extra BigQuery cost (fewer queries, not more); the number of calls per page grows (3–4), within the read limit (240/min).

# The weights of a rubric add up to 100 (editor rule, decided 2026-11-14)
The weights of the **enabled** criteria of a rubric must add up to exactly 100, neither under nor over (a tolerance of 0.000001 absorbs decimals such as 33.3 + 33.3 + 33.4). It is a rule of the console editor, not of the Python engine: the engine still reads any rubric already published, and the shared conformance cases with the console do not include it.
- A draft may be saved with the total pending (it is work in progress) and the editor says how far it is ("faltam 40" / "passam 20"); **publishing is refused** while the total is not 100 (`rubrics.publish` fails on any pending issue), and a rubric cannot be created valid without reaching 100.
- Disabled criteria do not count; zero-weight gate criteria (`is_sales`, `has_objection`) do not move the total.
- No published rubric breaks: all 19 versions in dev already add up to 100. A new revision copied from a version that did not would show the pending total until it is adjusted.
- Unchanged: at scoring time the weights of the criteria that do not apply (or lack evidence) leave the calculation and the remaining ones are normalized, so the 100 is the rubric's budget, not the denominator of every analysis.

# A required criterion is judged by its own minimum (decided 2026-11-14; replaces the rule below)
Until then a **required** criterion was compared with the rubric's `minimum_approval_score`, the minimum of the whole analysis, although nobody had defined a minimum for the criterion. A middle level (50) on a required criterion rejected an analysis whose weighted average passed.
- `evaluation_criteria.minimum_score` (FLOAT64, nullable, 0..100) is the criterion's own floor, set in the rubric and part of the immutable version. Only a **required** criterion may have one, and it must be reachable (not above the best answer).
- A required criterion **with** a minimum rejects the analysis when its score is below it. **Without** one it only has to be evaluated: missing evidence still goes to review (never zero), and a low score does not reject by itself. The overall minimum still decides on its own.
- `REQUIRED_CRITERION_BELOW_MINIMUM` now carries `minimum` (the criterion's own). Analyses stored before have no `minimum` in the reason, and the console words them as the rule of that time (`scripts/backfill_approval_reason.py` rebuilds old reasons that way).
- Nothing already stored is rewritten. Published rubrics are immutable, so their required criteria have no minimum: from the deploy of the new engine on, a new analysis under them is no longer rejected by a low score on a required criterion. To keep the old strictness a rubric needs a new revision with a minimum on that criterion. The snapshot hash of a rubric whose criteria have no minimum is unchanged.
- Schema: one nullable column appended to `evaluation_criteria` (`terraform plan`: 0 add, 1 change, 0 destroy), applied before the engine and the console that read it. Plan, cost and order: `docs/deployment-plan.md`.

# Approval reason is persisted (session_analyses.approval_reason, JSON)
A 87.5 analysis can be REJECTED: a **required** criterion below `minimum_approval_score` rejects regardless of the weighted average (the rule until 2026-11-14, see the decision above). The status alone hid why,
so `calculate_score` now returns `approval_reason = {minimum, overall, reasons[]}` and the engine stores it next to the status.
- Reason codes are fixed (`REQUIRED_CRITERION_BELOW_MINIMUM`, `OVERALL_BELOW_MINIMUM`, `MEETS_MINIMUM`, `INSUFFICIENT_EVIDENCE`, `NO_APPLICABLE_CRITERIA`) and carry criterion ids and
  scores only: no conversation text, so no PII. The decision itself is unchanged (a test pins it).
- The column is the last one in the table (BigQuery only appends columns), nullable, so analyses written before it existed have NULL and the console shows no reason for them.
- The console re-parses and rebuilds the JSON from known fields before showing it (it never renders stored text as-is) and explains the reason in Portuguese on the session and review screens.
- Expected cost: none (a few bytes per analysis). Infra: one in-place schema change (`terraform plan`: 0 add, 1 change, 0 destroy), applied per environment only with approval.
