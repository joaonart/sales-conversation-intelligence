# Deployment plan and cost estimate — FOR APPROVAL

> **Current state (2026-11-02).** The sections below are the original proposal (2026-10-27) followed by a dated log; each later section records what was prepared, what was approved and what was applied, with the verification. For what exists today read `README.md` (status table), `docs/architecture.md` and `infra/terraform/README.md`. The "Nothing has been executed" status further down is the status OF THE PROPOSAL, not of the project: dev has been applied in steps, each with an approved plan.

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
| Cloud Run (API, live; the historical job only if its image is set, which dev does not) | ~0 (free tier) | ~0 (free tier) | ~5–25 | scale-to-zero, request-based billing |
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
  `EXEC_MAX_COST_USD` (default 1), `EXEC_MAX_SESSIONS` (default 1000). (The former `ESTIMATE_*` price properties were removed in console v0.36.0: the estimate uses the catalog prices of the model chosen in the form.)
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

## Live worker and session event in dev (2026-11-01, prepared, NOT applied)

What "activating" means here: the **Evento da sessão** is the Pub/Sub topic `sci-dev-session-updates` (it already exists, with its dead-letter topic and the Cloud Tasks queue); the **Worker ao vivo** is the Cloud Run service `sci-dev-live` plus the push subscription that delivers the events to it. Neither exists yet: no image was given to Terraform.

**A finding that changes the plan.** `live_main` hard-coded `engine=None` ("AI disabled by design in this phase"), so even a deployed worker would answer 503 to every event and Pub/Sub would retry and then dead-letter it. Activating only the infrastructure would have created a worker that analyses nothing. Wired now, in code (no cost): `sci_workers/live_ai.py`. Off unless `AI_ENABLED=true`; when on it takes the API and model from the closed catalog (`LIVE_PROVIDER`/`LIVE_MODEL`, default `decisions`/`gpt-6-luna`), prices and gates with the catalog's worst-case rates, **requires `LIVE_MONTHLY_BUDGET_USD > 0`** and the key, and otherwise **refuses to start** with a clear message (no key in it). With AI off nothing changes (503, backlog retained). Terraform got a separate switch for it (`live_ai_enabled`, default false) with preconditions: it cannot be turned on without `attach_openai_secret` and a monthly cap. 15 new tests; `terraform validate` passes for dev and prod.

**Steps and what each one needs from you** (nothing below has been done):

1. **Reauthenticate Google (yours to run):** the Terraform credentials expired (`invalid_rapt`), so I could not produce the plan against the project. Run `! gcloud auth application-default login`.
2. **Build `workers:dev-4`** with the new code (build-images workflow, about 71 MB in Artifact Registry): needs your go-ahead.
3. **`terraform apply`, AI off:** expected to create the live Cloud Run service (scale to zero, 1 vCPU / 512 MiB, max 3 instances, authenticated callers only), the push subscription, and their invoker/subscriber bindings (about 5 resources; the exact plan comes after step 1). Tenants: `synthetic-a/default` and `synthetic-b/default` with rubric `sales_quality` (published v5), debounce 60 s. Needs your approval of the plan.
4. **Session events:** there is **no producer in dev**. The upstream ingestion pipeline is what should publish them; for the test we publish by hand: `gcloud pubsub topics publish sci-dev-session-updates --message='{"event_id":"t1","organization_id":"synthetic-a","workspace_id":"default","session_id":"<id>","source_updated_at":"<the session updated_at, UTC>"}'`.
5. **Turn AI on for live (separate approval, with a cap):** you add the OpenAI key version to Secret Manager (`sci-dev-openai-api-key`) out of band; then `attach_openai_secret = true`, `live_ai_enabled = true`, `live_monthly_budget_usd = 0.50`. This also attaches the secret to the historical job's environment (the existing shared switch).

**Cost.** Idle, AI off: about **US$ 0** (Cloud Run scale-to-zero and request-based, Pub/Sub under 10 GiB/month, Cloud Tasks under 1 M operations, image inside the 0.5 GB free). While AI is off and an event arrives it is retried 5 times and goes to the dead-letter hold (7 days, inspectable): no AI cost. With AI on, one live analysis with `gpt-6-luna` costs about **US$ 0.0002** (measured in the pilots) and at most about **US$ 0.001** by the worst-case gate; 10 test events are about US$ 0.002 expected, **US$ 0.01 worst case**. The proposed monthly cap of US$ 0.50 for dev is far above that and still hard-enforced from the ledger.

**Test plan once approved (cheap first):** (a) with AI off: publish one event, confirm the 503/retry/DLQ path and the `analysis disabled` log; (b) with AI on and no spend: publish an event for a session already analysed with the same model and rubric (`s0151` / `s0004` with `after_sales_quality@1` by `gpt-6-luna`) and confirm `DUPLICATE_CONTENT` (no AI call: the content-hash dedup); (c) 3 to 5 new sessions: confirm one result per session in the latest-result view, the cost in the ledger, and equivalence with a historical analysis of the same session, rubric and model (same score for the same answers).

**Applied in dev (2026-11-01), AI off:** image `workers:dev-4` built by the build-images workflow; `terraform apply` created 7 resources: the Cloud Run service `sci-dev-live` (revision `sci-dev-live-00001`, `Ready`, scale to zero, max 3 instances, `AI_ENABLED=false`, no OpenAI key, monthly cap 0), the push subscription `sci-dev-session-updates-live` (`ACTIVE`, 5 delivery attempts then the dead-letter hold), the invoker bindings for Cloud Tasks and Pub/Sub, the subscriber binding, and two alert policies (`dead_letters`, `oldest_unacked`). Tenants: `synthetic-a/default` and `synthetic-b/default`, rubric `sales_quality`, debounce 60 s. The service-level `scaling` block that Cloud Run reports with defaults is ignored in Terraform (provider quirk) so that the plan stays clean. Not done yet: publishing a test event, and turning AI on for live (needs the key in Secret Manager and a cap). Note: an event published while AI is off is retried 5 times and then lands in the dead-letter hold, which fires the `dead_letters` alert (an e-mail).

**Test of the AI-off path in dev (2026-11-01):** one event for session `s0151` of `synthetic-a` was published by hand (message `22182973466540864`, event `test-off-20261101T122642Z`, `source_updated_at` = the session's real `updated_at`). The live worker answered **503** (`analysis disabled; backlog retained`) to all 5 push deliveries (12:26:45, 12:26:59, 12:27:14, 12:27:30, 12:27:53: growing intervals), without reading the session or calling any AI. About 40 seconds after the 5th attempt the message was forwarded to the dead-letter hold with `CloudPubSubDeadLetterSourceDeliveryCount = 5`, the original data and attributes intact (inspectable and replayable for 7 days). Cost: none. The `dead_letters` alert policy is expected to have sent an e-mail. Next: turning AI on for live (key in Secret Manager plus an approved monthly cap), then the "unchanged content" test with the same event (`DUPLICATE_CONTENT`, no AI call).

**AI turned on for the live worker in dev (2026-11-01):** after the key was added to Secret Manager (`sci-dev-openai-api-key`, version 1, added by the owner out of band), `terraform apply` changed 1 resource and created 1: new revision `sci-dev-live-00002` of `sci-dev-live` with `AI_ENABLED=true`, `LIVE_PROVIDER=decisions` (model `gpt-6-luna`, the catalog default), `LIVE_MONTHLY_BUDGET_USD=0.5` and `OPENAI_API_KEY` as a reference to the secret (`latest`), plus read access to that secret for the live identity only (the historical job's identity gets it when its job exists). The revision is `Ready`, which proves the worker accepted the configuration (it refuses to start without a key, a catalog model or a positive monthly cap). No event was published after turning AI on, so nothing was spent. The plan is clean (`No changes`).

Proposed next test, cheapest first: (1) publish one event for `s0151` of `synthetic-a`: the live worker analyses it with `gpt-6-luna` and the rubric `sales_quality` v5 (the historical analysis of that session used `gpt-4o`, a different identity, so this creates a second analysis of the same session by another model: expected cost about US$ 0.0002, at most about US$ 0.001), then check the result row, the ledger and the debounce; (2) publish the same event again with a new id: expected `DUPLICATE_CONTENT` with no AI call; (3) four more sessions, which also gives the same sessions analysed by both models for the efficiency comparison. Worst case of the whole test about US$ 0.01 (hard monthly cap US$ 0.50).

**First real live analysis in dev (2026-11-01): the AI ran, the write did not.** Event `test-s0151-a-20261101T124500` for session `s0151` was accepted (204), debounced 60 s and evaluated by `gpt-6-luna` (1,626 tokens, US$ 0.0001626, outcome `NOT_EVALUABLE`, the same as the historical `gpt-4o` result), but storing the result failed with `Forbidden` and the worker answered 500, so Cloud Tasks retried: **two paid AI calls (US$ 0.00033) were made and none was stored**; the queue was paused at 12:46:45 before a third. Root cause: a BigQuery load job needs `bigquery.tables.create`, `bigquery.tables.updateData`, `bigquery.tables.update` and `bigquery.jobs.create` even to append to an existing table (Google's "Required permissions" for batch loading), and the custom role `sciResultWriter` had only `updateData`. The historical job had always run with an administrator's credentials, so no service identity had ever written to BigQuery in the cloud (this also affects the console executor). Fix: add `bigquery.tables.create` and `bigquery.tables.update` to the role (still no delete of tables or datasets); plan `0 add, 1 change, 0 destroy`; a static test pins the permissions. The queue stays paused until the role is applied; resuming it lets the pending task retry once (about US$ 0.00016) and store the result.

Weak point found: when the write fails after a paid call, each retry pays for the analysis again and the spend is not in the ledger that the monthly cap reads. Worth fixing before real volume (keep the evaluation result across retries, or write before acknowledging cost).

## Conversation ingest in dev (2026-11-01, prepared, NOT applied)

Why: "send conversations to Pub/Sub and nothing else" was not true. The analysis event carries only ids; the worker reads the conversation from BigQuery, which nobody filled in the cloud, and nobody was allowed to publish. This adds the missing path (design and producer guide: `docs/ingest.md`).

Code (no cost, tested, 39 new tests): contract `contracts/conversation-event.schema.json`; `sci_workers.ingest` (rules, order of effects, idempotency, tenant allowlist), `ingest_app` and `ingest_main` (Cloud Run push endpoint), `pubsub` (publisher over REST with the service's own identity), `sci_bq.source_writer` (bounded MERGE of one session row; streaming insert of messages with row ids). **Two reader bugs fixed on the way:** messages stored twice (Pub/Sub is at-least-once) were counted twice in the conversation and in its hash, now de-duplicated by `message_id`; and the MERGE was validated against the real BigQuery in dry-run (8,741 bytes scanned: the partition is pruned).

Terraform (dev plan, ingest on): **15 to add, 0 to change, 0 to destroy**: topic `sci-dev-conversations` and its dead-letter topic and 7-day hold, the push subscription (5 attempts, then the hold), the Cloud Run service `sci-dev-ingest` (scale to zero, max 3, same image as the live worker), its identity, a custom role `sciSourceWriter` (insert and merge into the source dataset only: no delete, no schema change, no access to results), `bigquery.jobUser` for the MERGE, permission to publish on the live event topic only, the invoker binding for Pub/Sub, the subscriber binding, the dead-letter alert, and **the producer's permission to publish on the ingest topic only** (`producer_members`; empty by default, so nobody can publish until somebody is named).

Cost: idle about US$ 0 (Cloud Run scale to zero, Pub/Sub within the free 10 GiB, one more alert condition). About US$ 1.3 per 20,000 conversations in BigQuery plus about US$ 0.0002 per conversation of AI (estimates, to confirm on the pricing pages).

Needs from you, each separately: the identity of the **real producer** for `producer_members` (until then, the owner's user is used for the dev test); building the image (`workers:dev-5`, about 71 MB); `terraform apply` of the 15 resources; and approval of one real AI analysis (about US$ 0.0002) for the end-to-end test: publish a synthetic conversation with a new session id, confirm one session row and its messages in BigQuery, the analysis event, the live analysis and the result, then publish it twice more (duplicate delivery) and confirm nothing is duplicated.


**Applied in dev (2026-11-01):** image `workers:dev-5` built by the build-images workflow (it builds from GitHub, so the commits were pushed first); `terraform apply` created the 15 resources: topic `sci-dev-conversations` with its dead-letter topic and 7-day hold, the push subscription `sci-dev-conversations-ingest` (`ACTIVE`, 5 attempts), the Cloud Run service `sci-dev-ingest` (revision `sci-dev-ingest-00001`, `Ready`, image `workers:dev-5`, scale to zero, no OpenAI key), its identity with the `sciSourceWriter` role on the source dataset, `bigquery.jobUser`, permission to publish on the live event topic only, the Pub/Sub invoker and subscriber bindings, and the dead-letter alert. Checked afterwards: only `user:joao.alves@j-nart.com` may publish on the ingest topic (to be replaced by the real producer identity) and only the ingest identity may publish on the live event topic. Ingest tenants: `synthetic-a/default` and `synthetic-b/default`. Not done yet: the end-to-end test (publish a conversation, check BigQuery, the event, the live analysis and the idempotency) and moving the live worker to `workers:dev-5` (it runs `dev-4`, which does not yet de-duplicate messages delivered twice).

**End-to-end test of the ingest path in dev (2026-11-01), real AI, cost US$ 0.000287:** the live worker was moved to `workers:dev-5` first (`terraform apply`, 1 changed; revision `sci-dev-live-00003`). A synthetic conversation `s9001` of `synthetic-a` was published to `sci-dev-conversations` through the Pub/Sub API with the owner's identity.

| Step | Result |
|---|---|
| Publish (3 messages) | stored in 3 s: one session row, 3 messages, queryable at once; analysis event announced, worker scheduled it (debounce 60 s) |
| First analysis | `EVALUATED`, `COMPLETED`, score 40.0, `gpt-6-luna`, US$ 0.000141, stored |
| Update (2 minutes later, one new message, one old message resent) | the session moved forward (still one row, `updated_at` +2 min); the reader returns 4 distinct messages (hash changed); second analysis `EVALUATED`, score 53.3, US$ 0.000145; the "current result" of the session is the new one |
| Replay of the first, older event | the session did **not** move back; the worker answered `new_task: false` (same debounce window), so no analysis and no cost |
| Dead-letter holds, failures table | empty; the console reconciliation script still agrees |

Found by the test: BigQuery de-duplicates streaming rows by row id only for about a minute, so a message resent later is stored again (8 rows for 4 messages after the three deliveries). Our readers (analysis, console detail, execution estimate) count each `message_id` once, so analyses are right; anyone reading `commerce.messages` directly (BI) must de-duplicate by `message_id`. A check of the stored ids before inserting (one small query per event, about US$ 0.00006) would stop the growth; not done, pending a decision. Producer permission: still only the owner's user; the real producer identity is still to be named.

**Second cause of spend outside the ledger, found by the dedupe test (2026-11-01):** two tasks of the same session, scheduled one second apart in different debounce windows (a producer that updates a session across a minute boundary does this), fired together and each paid an AI call for the same content (2 x US$ 0.000147). Both evaluations had the same `analysis_id`; the first stored it, the second got `Conflict` on its load job (answered 500) and its retry ended as `DUPLICATE_CONTENT`. The result is right and stored once, but one paid call is in no table, so it is not in the monthly cap. Together with the failed-write case seen earlier, the AI cost that the cap reads (the stored analyses) can be lower than the money spent. Test total: 4 real calls, US$ 0.000581, of which US$ 0.000147 unrecorded; the ingest dedupe itself was proven (8 rows stay 8; a resent message plus a new one adds only the new one).

## Spend outside the ledger: the fix (2026-11-01, prepared, NOT applied)

Causes measured in dev: a paid call whose result was not stored (a failed write: 3 calls, US$ 0.00049) and two evaluations of the same content racing (1 call, US$ 0.000147). In both the money was spent and the monthly cap, which summed the STORED analyses, did not see it.

**What changed in the code (tested, 15 new tests):**
* New table `conversation_analytics.ai_spend` (append-only, one row per paid call: tenant, session, kind `ANALYSIS` or `ROUTING`, mode, model, tokens, cost; never message text; partitioned by `occurred_at`).
* `EvaluationEngine` and `SessionRouter` record the call **the moment the provider answers**, before the answer is scored or stored (`sci_core.spend`, `sci_bq.spend`: a streaming insert with the row id `spend_id`, unique per call, so two paid calls are two rows). Wired in the live worker, the historical job, the console executor and the routing job. A failure to record is logged loudly (`spend_not_recorded`) and never discards an answer that was already paid for.
* The monthly cap (`month_to_date_spend`) reads `ai_spend`. Analyses and routing decisions stored **before** the tenant's first recorded call keep counting through the old rule; from that first row on, only recorded calls count (so the transition neither loses nor doubles spend; the tenants stay apart).
* The result writer no longer answers 500 when a concurrent twin is still loading the very same batch: it waits for the twin and accepts a clean finish (a twin that fails is still an error).

**Order matters.** The cap now reads `ai_spend`: a worker running the new code before the table exists would fail every cap check (and retry). So: (1) `terraform apply` of the table (plan: **1 to add, 0 to change, 0 to destroy**, `ai_spend` only; about US$ 0); (2) build `workers:dev-7`, `console-executor:dev-7` (about 140 MB); (3) `terraform apply` of the image swap for the live worker and the executor job (2 changes). Cost: a streaming insert per paid call (about US$ 0.01 per 200 MB: negligible) and the cap query reads one more small table.

Not fixed by this (still open, bounded): a retry after a failed write still pays the call again (it is now recorded, so the cap holds); two racing evaluations of the same content still both pay (now recorded). A lock on the analysis (a Cloud Tasks task named by the analysis id) would stop the second one; not done. The Painel "Custo de IA" still reads the stored analyses, so it does not show the unrecorded part yet.


**Applied in dev (2026-11-01):** (1) `terraform apply` created `conversation_analytics.ai_spend` (1 added; 12 columns, partitioned by `occurred_at`, clustered by tenant); (2) images `workers:dev-7` and `console-executor:dev-7` built from the pushed commit; (3) `terraform apply` moved the live worker (revision `sci-dev-live-00004`, `Ready`, AI settings and cap unchanged) and the executor job to `dev-7` (2 changed; the queue was empty; the ingest service stays on `dev-6`, it records no AI spend). The new cap query was checked against the real BigQuery before any paid call: with `ai_spend` still empty it gives exactly the old total for both workspaces (synthetic-a US$ 0.001291 this month, synthetic-b 0). Not yet verified in the cloud: that a real paid call writes its `ai_spend` row (needs one AI analysis, about US$ 0.00015, awaiting approval).

**Real paid call verified in dev (2026-11-01, US$ 0.0001503):** an update of `s9001` (event `e2e-7`) produced one analysis (score 53.3) and one `ai_spend` row (`ANALYSIS`, `live`, `gpt-6-luna`, 1503 tokens) whose `subject_id` is that analysis' id and whose cost equals the stored one. The test also found a bug in the cap query: the analysis `started_at` (17:46:01) is before the spend row's `occurred_at` (17:46:02), so the first recorded call was counted twice (cap read 0.001592 instead of 0.001441). Fixed in the query (legacy analyses already referenced by a spend row are excluded) with a regression test; against the real BigQuery it now reads 0.001442. The fix is committed locally and **not yet deployed** (needs `workers:dev-8` and an image swap); until then the live worker over-counts by one call per tenant, which only errs on the safe side of the cap.

**Applied in dev (2026-11-01):** `workers:dev-8` and `console-executor:dev-8` (cap-query fix) built from the pushed `1a6a2e5`; `terraform apply` moved the live worker and the executor job (2 changed, plan clean afterwards).

## Run detail: sessions of a run (2026-11-01, prepared, NOT applied)

New nullable column `run_id` at the end of `conversation_analytics.session_analyses` (an in-place schema change, no table recreation, no data movement, cost about US$ 0), written by the historical job and the executor, read by the console (`runs.sessions`, v0.43.0). `analysis_id` does not include it, so a retry of the same run still writes the same logical row and the latest-result views are unchanged. Order of application: (1) `terraform apply` of the schema (plan: 1 to change, 0 to add, 0 to destroy), (2) build `workers:dev-9` and `console-executor:dev-9`, (3) apply the image swap, (4) deploy console v0.43.0. A worker running the new code before step 1 would fail its writes (an unknown column), so step 1 comes first. The console works before the column exists (it falls back to the inferred basis).


**Applied in dev (2026-11-01):** (1) `terraform apply` added `session_analyses.run_id` (1 changed, plan clean afterwards; 59 existing rows keep it NULL); (2) `workers:dev-9` and `console-executor:dev-9` built from the pushed `7d5004f` (CI green); (3) `terraform apply` moved the live worker (revision `sci-dev-live-00006`, Ready) and the executor job (2 changed). The two new console queries were validated against the real BigQuery with a dry run (valid, 11 KB and 4 KB scanned). Not yet run: a historical run that writes `run_id` (needs an approved AI run) and the console v0.43.0 deploy.

**First run with `run_id`, in dev (2026-11-01, approved, US$ 0.000889):** `historical_main run` (CLI, `AI_ENABLED=true` for that process only) on `synthetic-a`, `sales_quality` v5, `gpt-6-luna`, window 01/10 to 16/10, cap US$ 0.005 (preflight estimate US$ 0.00026 to 0.0040): 5 sessions (`s0163`, `s0166`, `s0183`, `s0185`, `s0201`), 5 analysed, 0 failed, run `hist-5aaedede606f669a1c4b3584`. Verified in BigQuery: the 5 analyses carry the run id (5 = `sessions_processed`), `ai_spend` has 5 `ANALYSIS`/`historical` rows adding up to the run's cost (US$ 0.000889), and the console's exact query returns the five. Two things learned: the preflight reads at most `max_sessions + 1` sessions, so its counts are truncated when the window is larger than the gate (the first attempt, with a gate of 6, stopped by `SESSION_GATE_STOPPED` before any call: no spend); and the run row's `created_at` is the last write, which is why the inference window of older runs starts at the previous run's end (see v0.45.0 in `docs/admin-console.md`).

## Scheduling: the executor polls and schedules run (2026-11-02, prepared, NOT applied)

**Diagnosis (read from the real project):** a request made in the console stayed `REQUESTED` because nothing woke the executor (no Cloud Scheduler job; the API was not even enabled), the executor's AI gate was closed (`AI_ENABLED=false`, no key attached) and it had no routes for a ROUTING request. The executor job had one execution, by hand, on 31/10.

**What was built (tested, not applied):** `docs/scheduling.md`. Executor: schedules become requests (`run_schedules`, exactly once per slot), a monthly AI budget per workspace read from the `ai_spend` ledger (`EXECUTOR_MONTHLY_BUDGET_USD`, required to run), Terraform guards (a trigger needs the AI gate open, AI needs the key and a budget). Console v0.46.0: the Agendas tab.

**Application, in order (each step waits for approval):**
1. `terraform apply` of plan A: the `run_schedules` table (1 add) and the executor job's new env var `EXECUTOR_MONTHLY_BUDGET_USD=0` (1 in-place change, no behaviour change: AI stays off). About US$ 0.
2. Images `workers:dev-10` and `console-executor:dev-10` (the executor code that reads `run_schedules`), then the image swap.
3. **Enabling real AI in the executor and the trigger (plan B: 5 adds, 1 change on top of the table): needs explicit approval with the ceilings.** Cloud Scheduler API, its service account, `run.invoker` on the executor job only, the Scheduler job (`*/10 * * * *`), the executor's access to the OpenAI key secret, and the job's env (`AI_ENABLED=true`, the key, the monthly budget, the routes). Proposed: US$ 0.10 per request, 500 sessions per request, **US$ 1.00 a month for the workspace**.
4. Console v0.46.0.


**Applied in dev (2026-11-02):** step 1 of the scheduling plan: `terraform apply` created `conversation_config.run_schedules` (21 columns, partitioned by `created_at`, clustered by tenant and schedule; 0 rows) and added `EXECUTOR_MONTHLY_BUDGET_USD=0` to the executor job (1 added, 1 changed, plan clean afterwards; AI stays off). The images `workers`, `console-executor` and `api` `dev-10` were built from the pushed `bef0163` (CI green). With the table in place, every new statement was validated against the real BigQuery as a dry run (the executor's reads and its guarded INSERT, and the console's list, create and status statements): all valid. Not yet done: the executor image swap to `dev-10`, plan B (AI and the trigger) and the console v0.46.0 deploy.

**Applied in dev (2026-11-02), plan B: the executor runs on its own with AI (approved values):** the executor job moved to `console-executor:dev-10`; then `terraform apply` of plan B (5 adds, 1 change): the Cloud Scheduler API, its service account (`sci-dev-exec-sched`), `run.invoker` on the executor job only, the executor's access to the OpenAI key secret, the Scheduler job `sci-dev-executor-poll` (`*/10 * * * *`, UTC) and the job's environment: `AI_ENABLED=true`, the key (secret reference), `EXECUTOR_MONTHLY_BUDGET_USD=1`, the routes (`sales`, `after_sales`, `other`), ceiling US$ 0.10 per request and 500 sessions per request (`terraform.tfvars`, git-ignored, now carries these so state and file agree).

Two things the apply taught us, both fixed in the Terraform (tested): (1) the first apply failed with "Permission denied on secret": the job's new revision was created before its identity had been granted the secret (a missing dependency); a job or service that reads the key now declares that it waits for its grant (the same latent race existed on the live worker and the historical job); (2) the Scheduler job showed a permanent diff because the API does not return an explicit `retry_count = 0` (zero is the default), so the redundant block was removed. The plan is clean afterwards.

## The producer's identity (2026-11-02, prepared, NOT applied)

The producer is another application that runs on AWS. It gets a dedicated service account, `sci-dev-producer`, that may publish to the conversations topic (`roles/pubsub.publisher` on that topic only) and nothing else. Plan: **2 to add, 0 to change, 0 to destroy** (the service account and its grant on the topic); cost US$ 0. No federation with AWS (not wanted: the producer authenticates with a key). The key is NOT created by Terraform (it would sit in the state): a person creates it with `gcloud iam service-accounts keys create`, hands it over through a secure channel, and rotates it every 90 days. The step-by-step for the producer's team is `docs/producer-guide.md`. Residual risk of a key: whoever holds it can publish conversations for the workspaces on the ingest allowlist (it cannot read anything); the allowlist, the contract validation and the monthly AI cap bound the damage, and a leaked key is deleted at once.

## Test workspace for the producer (2026-11-02, prepared, NOT applied)

`org-test/default` is a test workspace (no real data) for the producer's team to try the integration. Onboarding is three things, none paid: (1) Terraform, plan **0 to add, 3 to change, 0 to destroy**: the workspace in `ingest_tenants` (the ingest service's environment), in `tenants_json` (the live worker: rubric `sales_quality`, debounce 60 s) and in `executor_tenants` (the executor's `--tenant`), each a new revision of an existing service or job; (2) the rubric: `scripts/copy_rubric_to_workspace.py` copies the published `sales_quality` v5 of `synthetic-a` into the new workspace as a DRAFT v1 (no AI, no cost), and an ADMIN of the new workspace publishes it in the console (audited); (3) access: nobody is a member of a new workspace, so an ADMIN row for the owner has to be inserted in `app_users` (the console cannot do it: it is the first member). Once the live worker takes events for this workspace, each real conversation the producer sends may be analysed with the AI after a minute of quiet, within the monthly cap of the workspace.

**Test of the two fixes in `org-test`, after the cleaning (2026-11-03):** the burst of three notices became ONE handled event and ONE paid call (US$ 0.0001453, before: three), as designed. It also showed two things: the first write of a session still raced (two `MERGE` jobs started within 24 ms of each other and the table again held two rows of `exemplo-001`; the console shows one, the `MERGE` replacement is still open), and the paid analysis was NOT stored: the load job id was built from the analysis alone and BigQuery had remembered the id of the analysis of 13:16, whose rows the cleaning had deleted. Fixed in the writer (the job id carries the moment of the write); needs `workers:dev-12` and `console-executor:dev-12` to take effect.

**Session written as versions (2026-11-03, prepared, NOT applied):** the ingest stops using `MERGE` for the session (it raced: two rows of `exemplo-001` were written twice) and appends a version row only when the event is newer, with a read-only lookup before it; no IAM or Terraform change (the same dataset role covers the lookup and the streaming insert). Needs `workers:dev-13` for the ingest service (the only image that changes behaviour: live and executor read the same way as before). Not applied.

**Evidence extractor prepared (2026-11-03, NOT applied, off):** `live_evidence_model` (env `LIVE_EVIDENCE_MODEL`) wires the existing `ResponsesEvidenceExtractor` into the live worker so the session page can highlight the messages behind each answer. Code only: nothing is deployed and the variable is empty. To turn it on: build `workers:dev-14` (this code), set `live_image = workers:dev-14` and `live_evidence_model = "gpt-4o-mini"`, plan, apply (1 change: the live service). Expected cost: about twice an analysis without evidence (measured: USD 0.000305 against USD 0.0001465); the monthly live cap (USD 0.50) already covers both calls. The console shows v0.47.9 with the reason for an empty highlight; deploy with the usual clasp steps when approved.

**Evidence applied in dev (2026-11-03):** `live_image = workers:dev-14` and `live_evidence_model = "gpt-4o-mini"` applied (1 change: the live service, revision `sci-dev-live-00010`); the console v0.47.9 deployed (@92). Real test `exemplo-001-t3`: 1 analysis, evidence ids on 4 of 7 criteria (all ids exist in the session; the criteria answered "no" have none by nature), 1 spend row of USD 0.000305 (both calls), no `evidence_failed`. Measured cost is 2.08x an analysis without the step, not the 1.3 to 2x first estimated.

**General evaluation + rubric prompt (2026-11-05, prepared, NOT applied, off):** code for the engine, the OpenAI writer, the storage, the three paths and the console (v0.48.0). Local checks: 693 Python and 610 console tests, lint, mypy and `terraform validate` clean. `terraform plan` (read-only, 2026-11-05): **1 to add** (`session_summaries`), **3 to change** (`evaluation_rubrics` schema: one additive nullable column; the live service and the executor job: one empty environment variable each), **0 to destroy**. Order: apply the schema, then the images, then (optionally) `live_summary_model` / `executor_summary_model = "gpt-4o-mini"`. Expected extra cost with it on: about USD 0.0005 per analysis whose rubric carries a prompt (estimate, to be measured); covered by the monthly caps. Rollback: empty the two model variables (no calls, no cost); the table and the column are inert when unused. A draft **v4** of `sales_quality` (org-test) adds `upsell` and `cross_sell` (weights 10 and 10, the others rebalanced to keep the sum at 100) and is NOT published: the same sample conversation that scores 70.0 on v3 scores about 53.1 on v4 without any upsell or cross-sell.

