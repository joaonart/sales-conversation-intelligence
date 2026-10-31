# Synthetic conversation data

Realistic, **invented** sales conversations for developing and validating the platform without real customer data. Generator:
`scripts/synthetic_data/` (deterministic, offline, free, no AI). Loader: `scripts/seed_synthetic.py`. Tests: `tests/test_synthetic_data.py`.

## What it generates (defaults: 360 sessions, ~7,100 messages, 90 days)
| | `synthetic-a` (240 sessions) | `synthetic-b` (120 sessions) |
|---|---|---|
| Business | electronics retail (fictional store and brands) | B2B SaaS subscription (fictional vendor) |
| Channels | whatsapp 62%, webchat 28%, instagram 10% | webchat 55%, whatsapp 30%, email 15% |
| Sellers | 6, with skills 0.92 ... 0.22 | 6, same spread |
| Customers | a pool with repeat customers | companies and decision makers |
Both tenants reuse the same session ids (`s0001`...) on purpose, to exercise tenant isolation.

### Scenarios
Sale (consultative to poor), abandoned-early, long price negotiation (up to ~100 messages), reactivation (outbound), post-sale **support**
(not a sales conversation), **wrong number**, **bot-only** abandonment. Conversations follow phases: greeting, discovery, pitch, objections,
negotiation, closing. Customers have personas (decided, in a hurry, researcher, comparer, undecided, angry) that change objections and outcomes.

### Realism details
- Informal pt-BR as typed in chat: abbreviations (vc, pq, blz), typos, stretched letters, emojis, bursts of short messages; sellers write more carefully.
- Questions and answers always match; each FAQ has several paraphrases; greetings match the local time of day; product names have the right gender.
- Human timing: business-hour skew, weekday seasonality, heavy-tailed reply latency, conversations resumed the next day, sellers answering in business hours.
- Sender types customer / seller / bot / system; message types text / audio (transcription) / image / document / sticker.
- Statuses closed / open / abandoned; a few sessions get a late update after closing (`late_update` tag) to exercise the live path.
- Edge cases (tagged in `metadata.tags`): `pii`, `prompt_injection`, `duplicate_message`, `blank_message`, `very_long_message`, `audio_transcript`, `long_session`.

### Invented PII
CPF/CNPJ with deliberately wrong check digits, phones in the unassigned `90000-xxxx` range, e-mails only on `exemplo.com`, `teste.com.br`, `example.org`.
A test proves the engine's `mask_pii` removes every one of them.

## Hidden ground truth
Every session carries what really happened in `sessions.metadata.truth` (the model never sees `metadata`; only message text is sent):
`scenario`, `sales_conversation`, `persona`, `greeting`, `discovery` (none/partial/complete), `product_info` (poor/fair/good), `has_objection`,
`objection_type`, `objection_handling` (poor/fair/good), `closing_attempt`, `outcome` (won/lost/ghost/open/n_a), plus `pii` / `injection` flags.
They map onto the sample rubric criteria (greeting, needs, product, objections + gate, closing), so model accuracy can be **measured**:
```sql
SELECT JSON_VALUE(metadata,'$.truth.discovery') AS truth_discovery, COUNT(*)
FROM commerce.sessions WHERE organization_id = 'synthetic-a' GROUP BY 1;
```
Seller skill drives quality (a test asserts that high-skill sellers do better discovery, give better product information and close more).

## Using it
```bash
python scripts/seed_synthetic.py --out /tmp/synth                                   # write JSONL locally (no network)
python scripts/seed_synthetic.py --out /tmp/synth --scale 0.25                      # a quick small set
python scripts/seed_synthetic.py --out /tmp/synth --project <id> --reset            # load into BigQuery (replaces synthetic-* rows only)
```
`--reset` deletes only `synthetic-*` rows (sessions, messages, rubrics, criteria, policies, analyses, criterion results, runs) and reloads rubric
versions 1-3. It never touches other tenants or the console's `app_users` / `audit_log`.

## Cost and limits
- Generating and loading cost nothing (load jobs are free; the data is ~3 MB).
- Analysing the 299 closed sessions with the real model: `preflight` estimates US$ 0.02 (low) to 0.24 (worst case); pilots measured ~US$ 0.0001 per session.
- It is text written from templates and paraphrases: more varied than before, but not a substitute for real conversations. Use it to test behaviour and plumbing,
  and validate quality and thresholds on real, human-labelled sessions.

## Measured against the ground truth (real model, dev, 2026-10-29)
`gpt-6-luna` via Decisions, rubric `sales_quality` v3, all 299 closed sessions (`scripts/evaluate_vs_truth.py`). Cost **US$ 0.0506**, 0 failures
(preflight had estimated US$ 0.014 low to 0.166 worst case for the retail tenant; real input tokens were ~3x the `len/4` estimate for Portuguese).
| Criterion | Result (242 sales sessions) |
|---|---|
| greeting | 241/242 (100%) |
| needs (none/partial/complete) | 233/242 exact (96%), 100% within one level |
| product (poor/fair/good) | 164/242 exact (68%), 99% within one level: the model is stricter than my "good" (62 good -> fair) |
| closing | 228/242 (94%) after fixing the label (was 78%, see below) |
| has_objection gate | 182/242 (75%); 43 false positives (questions such as "e se eu não gostar?" read as objections), 17 false negatives |
| objection handling | 44% exact, 94% within one level (mostly good -> fair) |
| non-sales (support, wrong number, bot) | 50 of 57 were scored (avg 17.2) instead of being excluded; 7 went to NEEDS_REVIEW |
| seller skill vs score | correlation 0.58; avg score by skill 0.92 -> 79.7, 0.80 -> 73.5, 0.66 -> 68.8, 0.55 -> 60.3, 0.40 -> 51.4, 0.22 -> 37.2 |
| prompt injection | 6 sessions, scores follow the truth (0.0 to 100.0 where discovery, product and closing really were good); no inflation |
| won vs not won | avg score 76.2 vs 48.6 |

### What the first run taught about the *test data* (fixed) and the *rubric* (open)
- **Label bugs in my generator, fixed** (text unchanged, verified by hash): a sale the customer closes ("fechou, manda o link") had `closing_attempt = false`
  although the seller followed through; repeated price haggling in long sessions had `has_objection = false`. Closing accuracy went 78% -> 94%.
- **Known label issues, not fixed yet** (changing them alters the text of a few sessions, so those would need re-analysis, about US$ 0.01):
  `abandoned_early` cuts the conversation but keeps the label of the part that was cut (e.g. `retail s0073`), and some B2B "objections"
  (time, security, integration) are phrased as plain questions.
- **Rubric definition, open:** the `has_objection` gate question lists "dúvida" among objections, so informational questions are flagged. A tighter wording
  ("explicit resistance to buying; informational questions do not count") should lift the 75%. Level definitions for `product` and `objections` could state
  what "good" requires (specs, warranty and a material offer; acknowledging, a concrete counter and a check-in).
- **Product gap, addressed (not yet measured):** conversations that are not sales (support, wrong number) were scored like bad sales. The engine now supports `all_of`
  rules and rubric v4 adds an `is_sales` gate (see `docs/operations.md`). Running v4 with the real model would measure the effect (about US$ 0.05 for the 299 sessions).

## Rubric v4 measured (real model, dev, 2026-10-29)
Same 299 closed sessions, rubric `sales_quality` v4 (v3 + `is_sales` gate and `all_of` rules), cost **US$ 0.0505**, 0 failures. Scoring criteria answered exactly as in v3
(greeting 100%, needs 96%, product 68%, closing 94%, has_objection 75%), so the change is isolated to the gate:
| | v3 (first run) | **v4** |
|---|---|---|
| `is_sales` gate accuracy (292 sessions that were answered) | n/a | **292/292 (100%)**: 41 non-sales detected, 251 sales kept, 0 sales wrongly excluded |
| Non-sales conversations (support, wrong number, bot), 47 closed | 50 of 57* scored like bad sales (avg 17.2) | **41 `NOT_EVALUABLE`, 6 `NEEDS_REVIEW` (too few messages), 0 scored** |
| Outbound reactivation (a sales conversation) | scored | 9 `COMPLETED`, 1 `NEEDS_REVIEW` (not excluded) |
| Sales sessions (242) | all scored | all scored (242 `COMPLETED`) |
\* the v3 figure counted reactivation sessions as non-sales; the evaluator now uses the true `sales_conversation` label.
The 6 non-sales sessions that went to review are the ones the minimum-evidence rule stops before any model call (fewer than 3 messages): the gate cannot answer on them.
Caveat: the non-sales conversations are short and obvious (a support ticket, a wrong number, a bot menu); real ones will be messier (a customer who starts with a support
issue and ends up buying). Validate the gate on real, human-labelled conversations before relying on it.


## Cleaning the seed data

`seed_synthetic.py --reset` deletes the synthetic tenants and **reloads** them. To start an end-to-end validation from an empty platform use
`scripts/clean_synthetic.py`, which only deletes:

```
python scripts/clean_synthetic.py --project <project>           # dry run: counts per table, synthetic vs other tenants
python scripts/clean_synthetic.py --project <project> --apply   # delete
```

- Every statement is filtered by `STARTS_WITH(organization_id, 'synthetic-')`; rows of any other tenant are never touched (the dry run shows them).
- It removes the source conversations (`commerce.sessions`, `commerce.messages`), the rubrics, criteria and policies, the analyses, criterion results and runs, and the
  human-review decisions made on those analyses (they would be orphaned).
- It **never** touches `app_users` (who can use the console: deleting it locks people out) or `audit_log` (the evidence trail).
- BigQuery time travel can restore deleted rows for a while (48 h on the platform datasets), and the seed is deterministic, so `seed_synthetic.py` regenerates the same data.
- `tests/test_clean_synthetic.py` fails if a statement ever loses the tenant filter or touches the two protected tables.

Dev state on 2026-10-29: 12,047 synthetic rows deleted (360 sessions, 7,129 messages, 8 rubrics, 598 analyses, 3,887 criterion results, 10 runs, 1 review decision);
`app_users` (1) and `audit_log` (32) kept; the latest-result, review-queue and gold views are empty.

## LLM-written conversations (more human than templates)
The template generator is deterministic and free but reads like a script (answers that do not match questions, stitched phrases). `scripts/generate_llm_conversations.py`
keeps its **plan** (tenant, channel, seller skill, persona, product, start time, edge-case flags and the hidden `truth`) and asks the model to write the dialogue
that exhibits exactly that truth (`scripts/synthetic_data/llm.py`).

```bash
# 1. free: shows the worst-case cost and one brief, calls nothing
python scripts/generate_llm_conversations.py --out /tmp/syn --sessions-per-tenant 15 --model gpt-4o \
  --input-price-per-million 2.5 --cached-input-price-per-million 1.25 --output-price-per-million 10 --max-cost-usd 1 --dry-run
# 2. real run (needs OPENAI_API_KEY_FILE and an approved cap); writes only local JSONL
OPENAI_API_KEY_FILE=~/.config/sci/openai_key PYTHONPATH=apps/workers/src python scripts/generate_llm_conversations.py ...   # same flags, no --dry-run
# 3. separate, explicit step: load into BigQuery
python scripts/seed_synthetic.py --from-dir --out /tmp/syn --project <project>
```
- **Cost control:** a `BudgetGate` reserves the worst case before each call and stops at `--max-cost-usd`. Accepted dialogues are cached by brief hash
  (`<out>/llm_cache.json`), so reruns only pay for what is missing. Prices are mandatory flags (verify them on the official pricing page).
  Measured with gpt-4o (2026-10-29 prices): about US$ 0.012 per session; 29 sessions cost about US$ 0.67 including prompt iterations.
- **Plan vs. text:** the model never decides the outcome; the truth in `sessions.metadata.truth` is unchanged. `metadata.generator = synthetic-data/v3-llm` and
  `metadata.llm = {model, prompt_version, brief}` record provenance. Timestamps come from the model's `gap` hints, sellers still answer in business hours.
- **Validation of every answer (untrusted):** JSON schema, roles, message count, who speaks first, ghost sessions end without the customer, required invented
  PII/injection strings appear verbatim **in customer messages**, no other long digit sequence or e-mail domain (no invented documents), no talk about the task,
  and clear contradictions of the truth (greeting, objection, premature closing). One retry with feedback; otherwise the session is **dropped**, never loaded.
- **Known limit:** discovery depth and proactive closing are not machine-checked (too wording-dependent). Their fidelity is measured by comparing the evaluator
  with the truth (`scripts/evaluate_vs_truth.py`) and reviewing disagreements. Because the generator and evaluator are both LLMs, prefer a different model for
  evaluation, and keep a small human-labelled sample as the final reference.

## Post-sales rubric (`after_sales_quality`)

`sales_quality` gates every criterion on `is_sales`, so post-sales conversations (defect, exchange, return, cancellation, delivery, invoice, warranty) end as not evaluable there. `after_sales_quality` is its counterpart, with its own gate `is_after_sales`. Created as **DRAFT v1** in `synthetic-a/default` and `synthetic-b/default` by `scripts/synthetic_data/after_sales_rubric.py` (no AI call, no cost); it is published from the console.

| Criterion | Type | Weight | Applies when |
|---|---|---|---|
| `is_after_sales` (gate) | Yes/No | 0 | always |
| `greeting` | Yes/No | 10 | post-sales |
| `understanding` (required) | none / partial / complete | 20 | post-sales |
| `resolution` (required) | poor / fair / good | 25 | post-sales |
| `has_frustration` (gate) | Yes/No | 0 | always |
| `empathy` | poor / fair / good | 15 | post-sales **and** customer frustrated |
| `next_steps` | Yes/No | 15 | post-sales |
| `closing` | Yes/No | 15 | post-sales |

Policy: minimum approval 70, missing evidence → `NEEDS_REVIEW`, at least 3 messages. Instructions say "the attendant (person or virtual assistant)" because many post-sales conversations are answered by a bot. Level anchors are count-based, like `sales_quality` v5. Weights of the criteria that do not apply (e.g. `empathy` without frustration) are excluded from the score, not counted as zero.

### Pilot of `after_sales_quality` v1 (dev, synthetic, 2026-10-31)

Published in both workspaces (`synthetic-a` by the operator at 11:36, `synthetic-b` through the console at 12:35; identical content, audit logged). Run with `historical_main run --only-routed` on the sessions the router sent to `after_sales`: `gpt-6-luna` (Decisions), one session per workspace, cap US$ 0.0025 each (US$ 0.005 approved in total).

| Session | Result | Score | Why it was rejected |
|---|---|---|---|
| `s0151` (synthetic-a, webchat, defective coffee maker, answered by a bot) | `REJECTED` | 67.6 | `resolution` = fair (50, required) and overall below 70 |
| `s0004` (synthetic-b) | `REJECTED` | 70.6 | `understanding` = partial (50, required): the overall score passes, the required criterion does not |

* **Cost:** US$ 0.000358 in total (US$ 0.000183 + US$ 0.000175; estimate US$ 0.00007, worst case US$ 0.00157, cap US$ 0.005). 0 failures, `run_failures` stays empty.
* **Mechanics confirmed:** both gates answered (`is_after_sales` = true, `has_frustration` = false), `empathy` was **not applicable** in both (its weight left the score instead of counting as zero), the score is the deterministic weighted mean of the applicable criteria (`s0151`: (10x100 + 20x100 + 25x50 + 15x100 + 15x0) / 85 = 67.6), and the rejection reasons are stored with the analysis.
* **Evidence:** every criterion has 0 cited messages. The Decisions API returns no citations and the evidence extractor is off by default, so this is expected here; it is not a defect of the rubric.
* **A finding about the rubric, not a bug:** `understanding` and `resolution` are *required*. With the policy "a required criterion below the minimum rejects", a middle level (`partial` or `fair`, 50 points) rejects an analysis whose overall score passes (`s0004`). If post-sales should tolerate a middle level in those two, either lower the mapped value of the middle level or make the criterion not required. That is a business decision; I did not change the published (immutable) version.
* **What this does not show:** two sessions measure nothing about accuracy. A fair evaluation needs more post-sales conversations with a known truth (a new synthetic batch, to be estimated and approved separately).

### `after_sales_quality` v2 (draft, 2026-10-31)

Created as a **draft** in both workspaces by `scripts/synthetic_data/after_sales_rubric_v2.py`, copied from the published v1 (no AI call, no cost). The only difference is that `understanding` is **no longer required**; the criteria, weights, level texts, applicability rules and policy (minimum 70, missing evidence -> review, at least 3 messages) are identical, which the script's run was checked against in BigQuery.

* **Why:** in the pilot a middle level (50) on a required criterion rejected an analysis whose overall score passed (`s0004`). `resolution` stays required: a generic solution without steps or a deadline should not be approved by the other criteria alone. A partial understanding now lowers the score without rejecting by itself.
* **What the same answers give under v2** (recomputed with the deterministic scorer, no AI): `s0004` 70.6 -> **APPROVED** (was rejected); `s0151` 67.6 -> still **REJECTED** (`resolution` = fair and overall below 70).
* **Not done:** v2 is not published (it is a decision of the operator, in the console) and the two pilot analyses stay under v1. Applying v2 to those sessions would be a new run (about US$ 0.0004) and needs approval.
* **If the opposite is wanted** (tolerate a middle level in `resolution` too): make it optional as well, or raise the mapped value of its middle level; both need another revision.

### Post-sales synthetic batch: plan and estimate (2026-10-31, not run, needs approval)

**Why:** the pilot had 2 post-sales sessions, which measures nothing. The batch gives the router and `after_sales_quality` v2 a known truth to be measured against.

**Plan (120 sessions, 60 per tenant, new ids so nothing existing is touched):**

| Kind | Sessions | Hidden truth |
|---|---|---|
| Post-sales (defect, exchange, return, cancellation, delivery, invoice, warranty), answered by a person or by a bot | 72 | `understanding` none/partial/complete, `resolution` poor/fair/good, `has_frustration`, `empathy` poor/fair/good (when frustrated), `next_steps`, `closing`, `greeting` |
| Sales (to check the router does not send sales to post-sales) | 30 | the existing sales truth |
| Other: wrong number, bot-only, a support request that turns into a purchase | 18 | scenario label, expected route |

**Steps and money** (prices of 2026-10-29 for `gpt-4o`: US$ 2.50 input, 1.25 cached input, 10.00 output per 1M tokens; to be verified on the official pricing page before the run):

| Step | What | Expected | Worst case |
|---|---|---|---|
| 0 | Code: post-sales plans with truth, briefs, validators, truth evaluator for the new rubric, loader that appends | free | free |
| 1 | Sample of 12 sessions, reviewed by a person before going on | about US$ 0.15 | US$ 0.45 |
| 2 | The remaining 108 sessions written by the model (about US$ 0.012 per session measured; retries add 15-25%) | about US$ 1.5 | US$ 3.9 with one retry each |
| 3 | Load into dev BigQuery (load jobs) | free | free |
| 4 | Routing pass with `gpt-6-luna` (about US$ 0.00007 per session) | about US$ 0.01 | US$ 0.03 |
| 5 | `after_sales_quality` v2 on the sessions routed to it, `gpt-6-luna` (about US$ 0.00018 per session, 72-80 sessions) | about US$ 0.015 | US$ 0.07 |
| 6 | Report against the truth (`scripts/evaluate_vs_truth.py` extended): router accuracy per route, accuracy per criterion, rejections explained | free | free |

**Proposed caps:** US$ 3.00 for steps 1 and 2 together (the budget gate stops there and keeps what was accepted; a rerun pays only for what is missing), US$ 0.10 for steps 4 and 5. **Expected total about US$ 1.7; hard ceiling US$ 3.10.**

**Risks:** the writing model and the evaluating model are both LLMs, so the truth is only as faithful as the text (known limit above); the sample in step 1 exists to catch that before paying for the rest. Dialogues that fail validation are dropped, never loaded. Nothing in BigQuery is overwritten: the new sessions use their own id range and `--reset` is not used.
