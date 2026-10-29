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
