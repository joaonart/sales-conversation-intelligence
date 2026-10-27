# Instructions for the implementing AI agent

## Non-negotiable constraints
- GCP-native infrastructure; OpenAI is an external processor, not hosted on GCP.
- Existing conversations in BigQuery by session; results **also** in BigQuery.
- Users maintain versioned weighted criteria in BigQuery. Published rubrics immutable; new revision for changes.
- Scoring deterministic and independent of LLM confidence. N/A and insufficient evidence distinct from zero.
- Historical first, then live. Shared evaluation engine and schema.
- Minimal recurring spend: no GKE, dedicated Temporal cluster, Cloud SQL, Apigee, or always-on workers without approval.
- Never assume BigQuery provides row-insert events. Prefer producer event or bounded watermark polling.
- Terraform plan only unless user explicitly authorizes apply. Require GCP budget, quotas and maximum cost controls.
- Validate official OpenAI Decisions API schema, rate limits, supported question types and current prices before implementing adapter; do not fabricate fields.
- Respect data residency, LGPD, masking, prompt injection and tenant isolation.

## Implementation milestones and acceptance
1. Contracts: canonical views, sample data, SQL DDL, validation, test fixtures.
2. Rubrics: published version loader, criteria validation, cache and score mapping.
3. Historical: job scans partition-pruned sessions, checkpoints, idempotency, batch output, budgets.
4. Live: session change events, debounce, bounded BigQuery reads, content-hash deduplication.
5. Analytics: latest-result view, gold aggregates, cost/quality dashboards.
6. Production: IAM, secret access, CI/CD, tracing, runbooks, SLOs, privacy and integration tests.

For each milestone: add tests, document decisions and expected costs, run lint/type/test, do not silently deploy.

## Definition of done
- Historical and live produce equivalent results for same session/rubric snapshot.
- Tenant isolation tested; all BigQuery reads include organization/workspace filters.
- Retries cannot produce duplicate logical results in latest-result views.
- Budget gate rejects jobs that exceed approved cap.
- Rubric weights, applicability and required criteria behave correctly.
- Terraform validate/plan pass with explicit project/region and minimal permissions.
- Evidence references and model/prompt/rubric versions are stored; PII not logged.
