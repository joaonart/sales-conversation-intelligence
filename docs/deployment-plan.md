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

## Session router: infrastructure and approvals needed (2026-10-31, not applied)

Code: `docs/routing.md`, ADR 0003. Nothing below has been applied or run.

* **Terraform (dev) plan:** `3 to add, 0 to change, 0 to destroy`: table `session_routes` (partitioned by `decided_at`, clustered by tenant and session)
  and views `current_session_routes` and `gold_routing_daily`. No paid resource: an empty table and two views cost nothing until queried; the router
  adds a few hundred bytes per session decision. The prod plan grows from 59 to 62 resources for the same reason (not applied).
* **Needs your approval before use:** (1) `terraform apply` in dev for those 3 resources; (2) a real-AI pilot of the routing pass.
* **Pilot estimate (not run):** `gpt-6-luna` (`$0.10` input / `$0.50` output per 1M tokens), 25 closed dev sessions with messages
  (14 in `synthetic-a`, 11 in `synthetic-b`), head capped at 1200 tokens: about 10,500 conversation tokens + 25 x 170 tokens of question and route
  descriptions, so about 15,000 input tokens -> **US$ 0.0015** expected, **US$ 0.0040 worst case** (200 output tokens reserved per call). Proposed cap
  **US$ 0.01**. It measures routing accuracy against the synthetic ground truth, the share of fallbacks and the real cost.
* **Order of work after approval:** apply (dev) -> `routing_main preflight` -> review -> `routing_main run` -> `historical_main preflight --only-routed`
  per rubric -> approval of each rubric run with its own exact numbers.

## Execution requests from the console (2026-10-31, not applied)

* **Terraform (dev) plan:** `1 to add, 0 to change, 0 to destroy`: table `conversation_config.run_requests` (console table, append-only, partitioned by
  `requested_at`). No cost until used. The prod plan grows to 63 resources (not applied).
* **Console:** new version with the form and the queue; deployed to Apps Script only with your go-ahead. Optional script properties:
  `EXEC_MAX_COST_USD` (default 1), `EXEC_MAX_SESSIONS` (default 1000), `ESTIMATE_INPUT_PER_MILLION` (default 0.125), `ESTIMATE_OUTPUT_PER_MILLION` (default 0.5).
* **Executor:** `apps/console-executor`, a command (`python -m sci_console_executor.main once|list`). Run locally today. A Cloud Run Job triggered by Cloud
  Scheduler would be new infrastructure with a recurring cost and needs a plan and your approval first; nothing of it exists.
* **Spend:** only when an executor runs a request, within the requester's ceiling and the executor's own ceilings (`--max-cost-ceiling`, `--max-sessions-ceiling`).

## Failure details of runs (2026-10-31, not applied)

* **Terraform (dev) plan:** `2 to add, 0 to change, 0 to destroy`: `conversation_analytics.run_failures` (new, partitioned by `occurred_at`, clustered by tenant and run) and `conversation_config.run_requests` (from the execution requests above). No cost until used; one small row per failed session. Prod grows to 64 resources (not applied).
* **Order:** apply first, then deploy the console. Without the table the run page shows "details not stored" instead of failing, and the jobs only log a warning.

## Console executor as a Cloud Run Job, dev (2026-10-31, prepared, NOT applied)

Code and Terraform are ready and tested; nothing was built, pushed or applied. Module `infra/terraform/modules/platform/executor.tf`, image
`apps/console-executor/Dockerfile`, workflow `build-images` (now also builds `console-executor`).

* **What it is:** a Cloud Run **Job** (no server, no always-on instance; `max_retries = 0`) that polls `run_requests`, runs what an ADMIN requested in the
  console and exits. An idle poll reads one small table and ends green without touching the AI gate or the key.
* **Everything is off by default.** The job exists only if `executor_image` is set. Spending needs, in order: (1) a request in the console with a cost
  ceiling; (2) `executor_ai_enabled = true` **and** `executor_attach_openai_secret = true` (with a key version added out-of-band); (3) a trigger: by hand
  (`gcloud run jobs execute sci-dev-executor ...`) or Cloud Scheduler when `executor_schedule` is set (empty by default).
* **Identity `sci-dev-exec`, least privilege:** `bigquery.jobUser`; read on source and config datasets; append on **one** config table (`run_requests`) and on
  analytics (results, routes, failures); secret accessor only when the key is attached. It cannot edit rubrics, policies or users. The scheduler (optional) has
  its own identity with `run.invoker` on this job only.
* **Terraform plan (dev), executor only:** `7 to add, 0 to change, 0 to destroy` (service account, 4 IAM bindings, 1 job; the job's image is a placeholder in the
  simulation). With the key attached: +1. With a schedule: +4 (scheduler API, its identity, invoker binding, scheduler job).
* **Expected recurring cost (to be confirmed on the official pricing pages before apply; these are my estimates, not validated today):** idle polling every 5 min is
  about 8,600 runs/month of ~5-8 s with 1 vCPU / 1 GiB, which should fit the Cloud Run, Cloud Scheduler (3 jobs) and BigQuery (1 TiB query) monthly free tiers: **about
  US$ 0**. The image in Artifact Registry is a few hundred MB (0.5 GB free). Ceiling if free tiers did not apply: low single-digit US$/month. AI spend is separate and
  stays bounded by each request's ceiling (the executor's own ceilings are `executor_max_cost_ceiling` = 1 and `executor_max_sessions_ceiling` = 1000).
* **Needs your approval, each separately:** (1) build and push the image (Cloud Build or local Docker, a few hundred MB in Artifact Registry); (2) `terraform apply`
  of the 7 resources, with the exact `executor_image` and `executor_tenants`; (3) attach the OpenAI key and set `executor_ai_enabled`; (4) the scheduler, if you want
  automatic polling instead of a manual trigger.
* **Not verified:** the Docker build itself (the daemon is stopped on this machine). The same five-package install and the entrypoint were verified in a clean
  Python 3.12 environment, and `terraform validate` and the plan simulation pass.

## GitHub Actions image build without keys, dev (2026-10-31, prepared, NOT applied)

Module `infra/terraform/modules/platform/github.tf`, off unless `github_repository` is set. It lets the `build-images` workflow push the executor/worker/api images.

* **No key anywhere.** GitHub gives the workflow a short-lived OIDC token; Google accepts it only if `repository_id` equals the numeric id of **this** repository
  (`1436348897`, so a renamed or recreated repository with the same name is not trusted) **and** the run is on `refs/heads/main`. The repository is public, so this
  condition is what stops any other workflow on GitHub from getting a token. A fork or another branch gets nothing.
* **What the identity can do:** `sci-dev-build` has `artifactregistry.writer` on the **image repository only** (not project-wide) and nothing else: no deploy, no data, no
  Terraform. Pushing an image does not deploy; Cloud Run changes only through an approved `terraform apply`.
* **Terraform plan (dev):** `7 to add, 0 to change, 0 to destroy`: workload identity pool and provider, the build identity, its impersonation binding (scoped to the repository id),
  the repository write binding, and two APIs (`iamcredentials`, `sts`). No cost: none of these is billed.
* **After approval:** apply, then set three **repository variables** (identifiers, not secrets) from `terraform output github_actions`: `GCP_WIF_PROVIDER`, `GCP_BUILD_SA`,
  `IMAGE_REPOSITORY`; then run the workflow by hand with a tag. The workflow was never exercised; the first run is the real test.
* **Not included:** the read-only identity for the `terraform-plan` workflow (`GCP_PLAN_SA`). It needs broader read access and its own review.
