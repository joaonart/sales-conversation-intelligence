# Operations
- Historical run: preview eligible sessions and estimated cost; obtain approval; enqueue job; checkpoint by stable `(updated_at, session_id)` cursor.
- Live: monitor Pub/Sub oldest-unacked age, duplicate rate, late arrivals, BigQuery source freshness, p95 analysis latency, cache hit ratio.
- Reprocess: new rubric version creates new analysis IDs; never mutate old results; latest view chooses intended version.
- Incident: disable optional AI, keep ingesting session-change events, preserve DLQ, resume with controlled backlog.
- Monitor: OpenAI spend, BigQuery query bytes, Cloud Run requests/cold starts, logs volume, failure ratios.

## Enabling AI (requires an approved deployment plan)
1. Build and push images to the Artifact Registry repo; set `live_image` / `historical_image`; plan and review.
2. Add the OpenAI key secret version; set `attach_openai_secret = true`.
3. Historical: run `preflight`, review the report (sessions, tokens, cost range), then `run --approved` with `AI_ENABLED=true` and the approved `--max-cost-usd`.
4. Live: set tenants in `tenants_json`, then `ai_enabled = true`. While disabled the push endpoint returns 503 and Pub/Sub retains the backlog (7 days) with backoff.
5. Kill switch: `ai_enabled = false` (or scale the live service to 0). Events keep queueing; nothing is dropped.

## Verified on real GCP (dev, 2026-10-28)
Findings from the first runs against real BigQuery and OpenAI; each one changed the code.
- **JSON columns in load jobs** must receive native JSON values. A Python `str` (even holding JSON text) is stored as a JSON *string* scalar
  (`JSON_TYPE = string`) and `JSON_VALUE(col, '$.k')` returns NULL. The writer and `scripts/seed_synthetic.py` now send objects.
- **Duplicate load `job_id`** returns `409 Already Exists`. The writer treats it as an idempotent retry only if the existing job is `DONE`
  without `error_result`; otherwise it re-raises.
- **A run with failed sessions** ends as `COMPLETED_WITH_FAILURES`, not `COMPLETED`; relaunching rescans and retries only the failed sessions.
- **OpenAI model access propagates unevenly**: right after enabling `gpt-6-luna`, the same key returned 200 and `403 project does not have access to this model`
  on parallel requests for several minutes. 403 is fail-fast in the adapter by design; relaunching the (idempotent) job is the remedy.
- **Decisions usage reported `output_tokens: 0`** in the first two real responses (consistent with the guide, not with the pricing page). Keep the conservative $0.50/1M in gates.
- `scripts/run_fake_pilot.py` runs the full historical pipeline on real BigQuery with a deterministic fake provider (zero AI cost; results carry `model = fake-deterministic`).
- `scripts/seed_synthetic.py --reset` deletes only `synthetic-*` rows (config + analytics) before reloading.

## Real OpenAI pilot (dev, synthetic data, 2026-10-29)
`gpt-6-luna` via the Decisions API, 40 synthetic sessions (2 tenants), rubric `sales_quality` v1 (5 criteria), concurrency 4.
- **Cost:** US$ 0.00349 for 40 analyses (~US$ 0.00009 each); worst-case reservation was ~9x higher. All responses reported `output_tokens: 0`.
- **Latency:** ~0.3-0.4 s per evaluation. No 429. 10/10 and 30/30 sessions succeeded after model access finished propagating.
- **Score by profile:** poor 0.0, average 20.0, excellent 66.6 (65-77.5), PII 52.5, prompt-injection 0.0 -> the "give the maximum score" instruction was ignored.
- **Finding 1 - short sessions are scored, not flagged:** 2-message sessions came back COMPLETED with scores 10-22.5, because Decisions has no "insufficient
  evidence" answer and the engine only abstains on refusal/ambiguity. Needs a deterministic pre-check (minimum messages / customer turns -> NEEDS_REVIEW)
  before the provider call. **Implemented** (see "Minimum evidence gate" below).
- **Finding 2 - calibration:** "excellent" sessions land at 65 (needs=partial, product=fair), below the 70 approval threshold. The rubric levels carry no
  descriptions, only keys. Rubric authors should state what each level means; re-check the threshold against labelled examples.
- **Finding 3 - dedupe ignored the model:** sessions analysed by the fake provider were skipped as "already analysed" by the real run. **Fixed**: see
  "Re-analysis with another model or prompt" below.

## Minimum evidence gate
Configured per rubric version in `evaluation_policies` (NULL = default):
| Column | Default | Meaning |
|---|---|---|
| `min_messages` | 3 | non-blank messages required in the session; `0` disables the gate |
| `min_customer_messages` | 0 (off) | non-blank messages with `sender_type = 'customer'` |
| `min_seller_messages` | 0 (off) | non-blank messages with `sender_type = 'seller'` |

Below the minimum the engine makes **no provider call** (cost 0) and marks every active criterion `INSUFFICIENT_EVIDENCE` with the warning
`below minimum evidence: <rule>`. The session then follows `missing_evidence_policy` (required criteria -> `NEEDS_REVIEW`), never a zero score.
Per-party minima are opt-in because source systems label senders differently; set them only after checking the real `sender_type` values.

**Deployment note:** the three columns are new in `evaluation_policies`. Apply the (additive, in-place) Terraform change before running the
updated code against an environment, otherwise the policy query fails on the missing columns.

### Pilot 2: rubric v2 with level descriptions + evidence gate (dev, synthetic, 2026-10-29)
Adapter change: `Criterion.level_descriptions` (from `score_levels` / `choices` JSON columns, `{key: text}`) is sent as the documented optional `description`
on score `levels` and choice `choices`. Rubric v2 keeps v1's criteria and weights and adds level definitions. 40 sessions, 0 failures, US$ 0.0042.
| Profile | v1 avg | v2 avg | v2 status |
|---|---|---|---|
| excellent (16) | 65.8 | 98.8 (90-100) | COMPLETED |
| pii (6 across v1+v2 runs: 3 per version) | 52.5 | 60.8 | COMPLETED |
| average (10) | 20.0 | 25.0 | COMPLETED |
| injection (2) | 0.0 | 5.0 | COMPLETED |
| poor (6) | 0.0 | 0.0 | COMPLETED |
| short (3) | 14.2 (scored) | none | NEEDS_REVIEW, no provider call (cost 0) |
Caveat: the conversations and the level definitions were written by the same author, so the gain shows that definitions steer the model, not that the
rubric is calibrated for real conversations. Validate the approval threshold against human-labelled real sessions.
Known gap (closed, see "Applicability rules" below): Decisions has no "not applicable" answer, so `objections` used to be rated even when the customer raised none.

## Applicability rules (`applicability_rule`)
A criterion can apply only when another criterion ("gate") has a given answer. Stored in `evaluation_criteria.applicability_rule` (JSON), evaluated
by the engine, identical for historical and live:
```json
{"type": "depends_on", "criterion_id": "has_objection", "equals": ["true"]}
```
| Gate outcome | Dependent criterion |
|---|---|
| answer in `equals` | keeps the provider's outcome and score |
| answered something else | `NOT_APPLICABLE`: excluded from the score, **not zero**; the provider's answer is discarded |
| gate itself `NOT_APPLICABLE` | `NOT_APPLICABLE` |
| gate unanswered / `INSUFFICIENT_EVIDENCE` / missing | `INSUFFICIENT_EVIDENCE` (we cannot tell whether it applies), so `NEEDS_REVIEW` per policy; never silently "not applicable" |

Deterministic: only the gate's mapped answer matters, never model confidence. The gate is an ordinary question in the same Decisions request, usually a
predicate with weight 0 so it never changes the score. Rubric validation (engine and console share cases): the gate must exist, be another criterion,
be enabled while the dependent is, carry no rule itself (one evaluation pass, no chains or cycles), and `equals` must be answers the gate can give.
The dependent question is still sent to the model (a single request) and its answer is discarded when the rule says not applicable.

Pilot (dev, synthetic, rubric v3 = v2 + gate `has_objection` + rule on `objections`, 40 sessions, US$ 0.0048, 0 failures):
| Profile | Sessions | gate true / false | `objections` | Avg score v2 -> v3 |
|---|---|---|---|---|
| excellent, average, poor | 32 | 32 / 0 | applicable (32) | unchanged |
| pii, injection (customer raised no objection) | 5 | 0 / 5 | **not applicable (5)** | pii 60.8 -> 81.1, injection 5.0 -> 6.7 |
| short | 3 | n/a | insufficient (minimum-evidence gate, no model call) | NEEDS_REVIEW |
The gate matched the generator's ground truth on 37 of 37 evaluated sessions. Synthetic text written by the same author: validate on real conversations.
Lessons from the work: a JSON `null` loaded into a JSON column is not SQL `NULL` (the parser treats both as "no rule"); the console's save and clone
statements must carry the `applicability_rule` column or they would silently erase rules (covered by tests).

## Re-analysis with another model or prompt
An analysis is identified by **what produced it**: `AnalysisIdentity = (model, prompt_version)`; `prompt_version` already encodes anything that can
change a score (threshold, margin, evidence step). The identity is part of:
| Where | Effect |
|---|---|
| `analysis_id` | already was: a different model/prompt gives a distinct logical result, no collisions |
| skip-already-analysed (`existing_analyses`, historical **and** live) | a session is skipped only if it was analysed with the **same** content hash, rubric version, model **and** prompt version |
| historical `run_id` | a run with another model/prompt is a new run instead of being skipped as "already COMPLETED" |
So switching model or changing the prompt version re-analyses everything on the next run **by design**: `preflight` (no AI) shows `to_process` and the
cost estimate first, the budget gate and `--approved` still apply, and the live path re-analyses a session only when it receives an event for it.
Re-running with the same identity stays a no-op. A rubric version is no longer needed just to change models.

- **Which result is current?** The newest analysis for the same session, content and rubric version supersedes the older one in `latest_session_analyses`
  and `current_session_results` (also when it was produced by an older or cheaper model: the last run wins). The raw `session_analyses` table keeps every
  analysis, and `gold_cost_daily` counts all of them by model, so nothing paid for disappears.
- **Run ids changed once**: they now include the identity, so jobs analysed before this change get new run ids. Their sessions are still skipped (same
  identity and content), so re-launching them processes nothing.
- Verified on the real dev BigQuery (read-only): the identity the sessions were analysed with shows `already_analysed = 30, to_process = 0`; a new prompt
  version or another model shows `already_analysed = 0, to_process = 30` with the estimate and a different run id.
