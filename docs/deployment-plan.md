# Deployment plan and cost estimate — FOR APPROVAL

Status: **proposal. Nothing in this document has been executed.** No `terraform apply`, no paid resources, no real AI calls
until the approvals in section 6 are given explicitly.

Prepared 2026-10-27. Model: `scripts/cost_estimate.py` (all formulas and inputs are in that file; rerun with real numbers).

## 1. Honest limits of this estimate
- **OpenAI prices**: read from the official pricing page on 2026-10-27 (`docs/openai-validation.md`): `gpt-6-luna` input $0.10, cached $0.01, output $0.50 per 1M tokens.
  The Decisions guide says output is not charged while the pricing page lists $0.50; the higher figure is used.
- **GCP prices are NOT verified.** The Google pricing pages did not render for my fetch tool, so the BigQuery, Cloud Run, Pub/Sub
  and Tasks unit prices come from memory (list prices, US/Tier 1) and may be outdated. São Paulo (Tier 2) is typically ~40% higher on Cloud Run.
  **Please confirm in the Google Cloud Pricing Calculator before approving.** The GCP lines are small next to OpenAI, so this does not change the conclusion.
- **Volumes are assumptions** (you did not have numbers). Tokens use 3.5 chars/token for pt-BR and ~30 output tokens per criterion; both need measuring on a sample.
- Decisions rate limits are undocumented; throughput (and therefore the length of the historical run) is unconfirmed.

## 2. Scenarios (assumptions)
| | Small | Medium | Large |
|---|---|---|---|
| Historical sessions (one-off) | 2,000 | 50,000 | 500,000 |
| Live sessions / month | 1,000 | 20,000 | 200,000 |
| Messages / session | 30 | 40 | 60 |
| Chars / message | 200 | 250 | 250 |
| Criteria / rubric | 10 | 20 | 30 |
| Live evaluations per session (debounce) | 1.5 | 1.5 | 1.5 |
| Input tokens / evaluation (derived) | ~2.6k | ~4.4k | ~6.4k |

## 3. Estimated cost (USD)
| Item | Small | Medium | Large | Basis |
|---|---|---|---|---|
| OpenAI — historical backfill (**one-off**) | ~0.8 | ~37 | ~544 | tokens × luna rates, no prompt-cache credit |
| OpenAI — live (**per month**) | ~0.6 | ~22 | ~327 | live sessions × 1.5 evaluations |
| BigQuery scans (monthly) | 0 (free 1 TiB) | 0 (free 1 TiB) | ~1 TiB → ~0 to a few USD | $6.25/TiB after free TiB (unverified) |
| BigQuery storage of results | < 1 | < 1 | a few | $0.02/GiB-month after 10 GiB free (unverified) |
| Cloud Run (API, live, historical job) | ~0 (free tier) | ~0 (free tier) | ~5–25 | scale-to-zero, request-based billing |
| Pub/Sub + Cloud Tasks | ~0 | ~0 | ~0–2 | within free tiers at these volumes |
| Secret Manager, Artifact Registry, logging, alerts | ~0–3 | ~0–3 | ~3–10 | depends on log volume; logs are metadata-only |
| **Total, recurring GCP** | **≈ 0–5** | **≈ 0–5** | **≈ 30–60** | |
| **Total, recurring incl. OpenAI live** | **≈ 1–6** | **≈ 25–30** | **≈ 360–390** | |

Sensitivities (what actually moves the number): sessions × messages × chars (linear), criteria count (output + question tokens),
re-analysis rate in live (the rate gate caps it: `max_analyses_per_session` per `min_reanalysis_seconds`), data-residency uplift (+10% on OpenAI), and context above 272K tokens (~2× input; blocked by `max_input_tokens`).
BigQuery scans are the least certain GCP line: it assumes the source tables are narrow and partitioned by `updated_at`; wide source tables raise it, and the dry-run cap blocks any query above `maximum_bytes_billed`.

## 4. Controls that cap spend (already in code)
- `BudgetGate`: reserve before each call, fail closed; the historical job stops at `max_cost_usd` (BUDGET_STOPPED, resumable); live checks monthly spend from the ledger.
- Preflight (no AI) prints sessions and an estimate; `run` needs `AI_ENABLED=true` **and** `--approved`.
- Per-query dry run + `maximum_bytes_billed`; Cloud Run max instances; Cloud Tasks dispatch rate; Pub/Sub max delivery attempts + DLQ.
- GCP budget with alerts (alerts only — GCP budgets do **not** stop spend); BigQuery daily quota is a manual `gcloud` step (see `infra/terraform/README.md`).
- Proposed initial caps: historical `max_cost_usd` = 2× the preflight estimate for the first pilot; live monthly budget = 1.5× the scenario figure.

## 5. Rollout sequence (each step needs its own go-ahead)
0. **Decisions needed before anything** (section 6).
1. `terraform plan` for dev with the real project id (read-only); I present the output. Offline plans today: 53 resources minimal / 69 full.
2. `apply` dev, **minimal profile** (datasets, tables, views, IAM, no Cloud Run services, `ai_enabled=false`). Cost ≈ 0.
3. Load/point the source views at real data (`sql/05`), run **historical preflight** (no AI): confirms session counts and scan bytes.
4. Real-GCP integration checks: BigQuery load-job JSON format and duplicate `job_id` behaviour, OIDC verification, Cloud Tasks.
5. Build and push images to Artifact Registry; deploy API/live with AI **disabled**.
6. Add the OpenAI key out-of-band; wire the OpenAI adapter into `historical_main`/`live_main` (currently exits 4 by design).
7. **Pilot**: ~100–200 sessions, a throwaway cap (~$1–5). Measure real tokens, latency, rate limits, score index base; recalibrate this estimate.
8. Full historical in resumable batches under the approved cap; then enable live for one tenant allowlisted.
9. Prod: same steps with `backend "gcs"`, deletion protection, internal ingress.

## 6. Decisions I need from you
1. **Project ids, region and BigQuery location.** Note the LGPD point below before choosing.
2. **Data residency / LGPD.** OpenAI's documented regional processing is US and EEA+CH — **not Brazil**. Conversation text (after masking of CPF/e-mail/phone; names are not masked) goes to OpenAI regardless of the GCP region. This is an international transfer that needs a legal basis and probably a DPA/ZDR agreement. This is a business/legal decision, not an engineering one.
3. **Real volumes** (or authorization to measure them via the no-AI preflight).
4. **Caps**: pilot cap, historical cap, monthly live budget, alert e-mail, billing account.
5. **Approval to enable real AI** for the pilot only.

## 7. Open risks
Unverified GCP prices; Decisions rate limits and output billing unclear; no citations from Decisions (evidence needs an extra Responses call, not included above — it would add roughly 1.3–2× OpenAI tokens if enabled); nothing exercised on real GCP yet; workflows `terraform-plan.yml`/`build-images.yml` untested.

## Production environment: prepared, not applied (2026-10-30)
- Project `jnart-intelligence-prod` (number 332947012396, organization j-nart.com), billing account `01CFC2-0C1EBB-850175`, region `us-east1`, BigQuery location `US`.
- Terraform state bucket `gs://jnart-intelligence-prod-tfstate` (versioned, uniform access, public access prevented); `terraform init` done with `prefix=sci/prod`; `terraform.tfvars` is git-ignored.
- `terraform plan`: 59 to add, 0 to change, 0 to destroy (datasets, 7 tables incl. `session_analyses.approval_reason`, 9 views, Pub/Sub, Cloud Tasks queue, 5 service accounts, empty OpenAI secret, Artifact Registry, 3 log metrics, 2 alerts, US$ 50/month budget). No Cloud Run, no images, `ai_enabled = false`, admin console off.
- Expected recurring cost with no data: cents per month. **Not applied**: waiting for explicit approval; the dev environment keeps evolving first.
