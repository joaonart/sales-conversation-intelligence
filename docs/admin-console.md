# Admin console (Google Apps Script web app)

> **Optional.** The platform does not need the console. The evaluation engine, the historical job, the live worker, the API and the core
> Terraform work without it, and nothing in them reads or writes the console's tables. Everything the console edits (rubrics, criteria,
> policies) is plain BigQuery data that can also be managed with SQL (`sql/04_sample_rubric.sql`). Enforced by `tests/test_console_is_optional.py`.
>
> | | Without the console | With the console |
> |---|---|---|
> | Terraform | default (`enable_admin_console = false`): no console tables, roles or grants | `enable_admin_console = true` adds `app_users`, `audit_log` and the deployer grants |
> | SQL | `sql/00`-`06` only | plus `sql/07_admin_console.sql` |
> | Manage rubrics | SQL (draft, validate, publish by inserting rows) | UI with validation, etag and audit |
> | Dashboards | gold views in BigQuery (Looker Studio, SQL) | built-in pages over the same views |
> | Turning it off later | n/a | set the flag to false (tables are kept unless you drop them; the engine is unaffected) |

A single place for people to **see and manage everything the platform stores**: dashboards, sessions and results, the review queue, runs,
rubrics (criteria, weights, level definitions, policy), users and the audit trail. Code: `apps/admin-console`. Status: built and tested
locally; **not deployed** (deploying needs `enable_admin_console = true` and an `apply` for two tables, plus a person with an Apps Script account; see its README).

## Decisions (approved 2026-10-29)
| Topic | Decision | Why / trade-off |
|---|---|---|
| Runtime identity | Web app **executes as its deployer**, access limited to the Workspace domain | Users need no GCP access, so nobody can bypass the app's tenant checks with the BigQuery console. Cost: the deployer's credential is a crown jewel (see Risks) |
| Authorization | Own RBAC in BigQuery (`app_users`, append-only, latest row wins) | BigQuery IAM is per dataset, it cannot express "tenant A only" |
| Scope | Read everything; write only configuration: rubric drafts, publication, users | Results are produced by the pipeline, never edited by hand |
| Frontend | Vanilla JS in HtmlService, no external libraries, no `innerHTML` | Smallest attack surface; no supply chain in the browser |
| Backend | No Cloud Run: Apps Script calls BigQuery directly | No recurring infrastructure cost; the "API" is one `rpc` function |

## Design (Google Cloud Console look)
The UI follows the Cloud Console's Material language so it feels native next to GCP: top app bar (menu, product mark, workspace picker, session search by id,
theme toggle, role chip, account avatar), a left navigation with icons and sections (Análise, Configuração, Administração) and a pill-shaped active item, breadcrumb
trails on detail pages, page titles with sentence-case actions, outlined 4px fields, filled blue primary buttons, 1px bordered cards, dense 44px table rows with a sticky
header, status chips with icons (check, warning, error, clock), a top progress bar while a request runs, snackbar-style toasts, dialogs, a sticky action bar in the rubric
editor, a chat-style conversation view (customer left, seller right, bots and system notes centred, evidence highlighted) and a pure-SVG line chart.
- **Themes:** light by default like the Cloud Console, dark follows the system, and the toggle pins one (a per-browser convenience kept in `localStorage`, ignored if blocked).
  Tokens are CSS custom properties in `src/client/styles.css`.
- **Responsive:** below 960 px the navigation becomes a drawer; below 560 px the bar compacts and indicators use two columns.
- **No third-party requests:** no web fonts, scripts or images are loaded. The font stack prefers Google Sans / Roboto and falls back to the system font, so the typeface
  matches the Cloud Console only where those fonts are installed. Loading them from Google Fonts would make it exact at the price of a third-party request.
- **Safety unchanged:** icons are built with `createElementNS`, every value is still placed with `textContent`, and a test forbids `innerHTML`, external URLs and any link without an `onclick`.
- **Local preview** (`node preview/server.mjs`): `/framed?w=420` shows the app in a sandboxed iframe of a given width, as HtmlService does.

## Roles (per organization/workspace)
| Capability | VIEWER | EDITOR | ADMIN |
|---|---|---|---|
| Dashboard, sessions (masked), review queue, runs, rubrics (read) | yes | yes | yes |
| Create/clone/edit/discard rubric **drafts** | | yes | yes |
| **Publish** a rubric (becomes immutable) | | | yes |
| Manage users, read the audit trail | | | yes |

## Security model
- **Identity**: `Session.getActiveUser()` (Google), never a request field. The account must belong to `ALLOWED_DOMAIN`.
- **Tenant isolation**: a tenant in a request is a *claim*. Every call is authorised against the caller's memberships first; every SQL statement
  carries `organization_id = @org AND workspace_id = @ws` as parameters. Tests sweep all methods and assert this, and that a foreign tenant
  reaches no data query at all.
- **No string-built SQL**: identifiers come from validated config, values only as named parameters; ids are validated against a strict pattern.
- **Conversation content**: masked server-side (CPF, CNPJ, e-mail, phone; same patterns as the engine, checked against shared fixtures; names are NOT masked).
  Every view of a session is recorded in `audit_log` **before** content is released, and the call fails closed if the audit write fails.
- **Immutable rubrics**: only `DRAFT` rows can be changed (guard in SQL, inside a transaction); publication requires the etag the reviewer saw,
  the full validation to pass, and the `ADMIN` role. Concurrent edits are rejected (etag), writes are serialised with a script lock.
- **Audit**: every write, denial and content view is appended (actor, tenant, action, entity, outcome, metadata only).
- **Abuse limits**: request size cap, per-user rate limits (240 reads / 40 writes per minute), BigQuery `maximumBytesBilled` on every query,
  row/page caps, bounded date windows.
- **Errors**: only fixed, safe messages reach the browser; unexpected failures return a request id and are logged without their text.
- **Browser**: all data is placed with `textContent` (a test forbids `innerHTML` and friends); no external scripts or styles.
- **Least privilege**: OAuth scopes are `bigquery` and `userinfo.email` only. Terraform (`console_members`) grants the deployer a custom role that
  can read/modify rows of the config tables but not create, alter or delete tables, plus read on analytics and source datasets.
- **Last administrator**: a workspace can never be left without an active administrator.

## Data model additions (`sql/01_config.sql`, Terraform-managed)
- `app_users(organization_id, workspace_id, email, role, status, changed_at, changed_by)`: append-only.
- `audit_log(event_id, occurred_at, actor_email, organization_id, workspace_id, action, entity_type, entity_id, outcome, details JSON, request_id)`:
  partitioned by day; never stores message text.

## Behaviour worth knowing
- Revoking a user takes effect within 30 s (membership cache) or immediately when done through the console.
- A published rubric becomes the "latest" one used by jobs that do not pin a version; pinned jobs are unaffected.
- The console validates rubrics with the same rules as the engine (`tests/test_admin_conformance.py` and `tests/rules.test.ts` share
  `fixtures/admin_conformance.json`) and a few stricter ones that protect the model contract: snake_case criterion ids, SCORE levels with distinct
  notes, provider option limits. Level descriptions may cover only some options (the engine accepts this since the conformance check found the mismatch).
- Criteria can have an **applicability rule** ("only if criterion X answered Y"); the editor shows it, validates it with the engine's rules and
  preserves it on save, clone and publish. See `docs/operations.md`, "Applicability rules".
- Sessions older than the pruning window of the source tables are slower to open (the session lookup has no date hint).

## Risks and limits (read before approving deployment)
1. **The deployer's credential is the single point of trust.** Whoever can edit the Apps Script project can run code as the deployer and read all
   data. Use a dedicated Workspace account with 2-step verification, restrict script editors to one or two people, and avoid a personal account.
2. **App-level tenant isolation only**: BigQuery has no per-tenant rows here. A bug in the app could expose another tenant; the tests are the control.
3. **Not exercised on the real Apps Script runtime yet.** Verified: unit tests with fakes, UI in a browser with a mock backend, every SQL
   statement via BigQuery dry-run (25 distinct statements, 0 errors), and the write scripts **executed on the real dev BigQuery** with a throwaway
   tenant (see below). Unverified: `Session.getActiveUser`
   behaviour in your Workspace, the BigQuery advanced service, LockService, quotas. Expect a first-deploy shake-out.
4. Apps Script quotas (6 min per execution, concurrent executions) bound very large listings; queries are capped well below that.
5. LGPD: viewing conversation content is a processing activity; keep the audit trail and define who may be `VIEWER`. Names in messages are not masked.

## Verified on real BigQuery (dev, 2026-10-29)
The console's own SQL, executed for real against `conversation_config` with a throwaway tenant (deleted afterwards, 0 rows left):
create draft -> save (criteria stored as JSON *objects*) -> publish -> **save, publish again and delete on a PUBLISHED rubric are all rejected
with `SCI_CONFLICT`** -> clone into a new draft -> a second open draft is rejected -> delete draft removes header and criteria -> user and audit inserts.
Dev has the console tables and the deployer grants applied (`enable_admin_console = true` in the git-ignored `terraform.tfvars`).
