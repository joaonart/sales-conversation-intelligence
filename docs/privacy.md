# Privacy, LGPD and review controls
| Topic | Control in this repository | Still required (outside code) |
|---|---|---|
| Data minimisation | Only session text needed for the rubric is sent; CPF, CNPJ, email, phone are masked first (`sci_core.context.mask_pii`, tested). Masking is pattern-based: names and free-text identifiers are NOT masked | Legal review of what remains identifiable; consider an NER/DLP step if needed |
| Processors | OpenAI is an external processor (not hosted on GCP). `safety_identifier` is an opaque per-tenant hash. `store: false` on Responses calls | DPA, transfer mechanism, ZDR / regional processing decision (docs list US and EEA+CH regional processing) |
| Residency | Dataset location, Cloud Run, Tasks and secret replicas are explicit variables with no prod default | Choose regions; the OpenAI region is a separate decision |
| Stored results | Scores, statuses, model/prompt/rubric versions, evidence **message ids**; no message text, no raw provider payloads | Access control on the underlying messages; retention and deletion schedule |
| Logs | JSON allowlist: ids, outcomes, latencies, costs. Exception text and tracebacks' values are never logged | Log bucket retention and access |
| Tenant isolation | Every query filters `organization_id` AND `workspace_id` (tested against two overlapping tenants). Workspaces of one org are not pooled | BigQuery row access policies / authorized views for BI users |
| Prompt injection | Messages are wrapped as data blocks with delimiter neutralisation; a developer guard precedes them; model output only selects from rubric-defined options; no tools are executed | Periodic red-team of rubric instructions |
| Fairness / review | `NEEDS_REVIEW` instead of guessing; `review_queue` view; N/A and insufficient evidence are never zero | Scores must not be sole basis for punitive decisions; provide a contestation process |

## Deletion
Results key on `session_id` (+ tenant). To erase a session: delete its rows from `session_analyses`, `session_criterion_results` and its `analysis_runs` traces (`checkpoint = session_id` for live rows) with a dated, tenant-scoped DML approved by the data owner. Deleting source messages is the source system's responsibility.
