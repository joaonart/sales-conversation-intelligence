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
