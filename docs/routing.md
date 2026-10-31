# Session router

Decides, per session, which rubric the conversation is analysed with, **before** any rubric is paid for. With two or more active rubrics
(`sales_quality`, `after_sales_quality`, ...) it replaces "run every rubric on every session" by "one tiny classification, then the one
rubric that fits".

## Why

Every analysis asks every criterion of a rubric in one provider call; applicability gates (`is_sales`, `is_after_sales`) are applied
afterwards, in code. A support conversation analysed with a sales rubric therefore costs a full call and ends as `NOT_EVALUABLE`. With two
rubrics and no routing every session is analysed twice and one of the two results is always noise. Routing removes the wasted call and keeps
`NOT_EVALUABLE` for what it should mean (a conversation no rubric covers).

## Decision

| Aspect | Decision |
|---|---|
| Classifier | One provider **CHOICE** question (`route`) with one option per route and the route description as the option text. Same `AIProvider` contract as the rubric analysis (Decisions or Responses), so no adapter change. |
| Input | Only the **head** of the conversation (`--router-max-input-tokens`, default 1200), masked, delimiters neutralised. The opening tells a purchase from a support request. |
| Output | A route key. It only selects a rubric: it is **never** a score and never feeds one. |
| Unusable answer | Insufficient evidence, an answer outside the routes, an empty or duplicated answer -> the configured `fallback` route (state `FALLBACK`). Never an arbitrary rubric. |
| Skip route | A route without `rubric_id` ("other") ends the session at no further cost. |
| One route only | Nothing to decide: no provider call, no cost (state `SINGLE`). |
| Persistence | Append-only `conversation_analytics.session_routes`; view `current_session_routes` = latest decision per session. |
| Identity | A decision is keyed by session + content hash + **router identity** (model, provider prompt version, `router-v1`, hash of the route definitions). Editing a description or a target, or changing the model, makes a new logical decision; old rows stay as history. |
| Cost control | Same `BudgetGate` as the historical job (worst case reserved before each call), `--max-sessions` gate, preflight with low/high estimate, `AI_ENABLED` + `--approved` before `run`. |
| Tenants | Every read and write is scoped by organization and workspace (also inside the `only-routed` sub-query); tested. |

## Route configuration

JSON, validated (`sci_core.routing.RoutingConfig`): 1-12 routes, unique keys (`^[a-z][a-z0-9_]{0,31}$`), a description of up to 400
characters, optional `rubric_id` / `rubric_version` (`null` version = latest published when the rubric is loaded), and a `fallback` that must be one of the keys.
Example: `config/routes.sales-and-after-sales.example.json`.

Write the descriptions as definitions, not slogans: they are the only thing the classifier sees. Prefer concrete cases (defect, exchange, return,
cancellation) over adjectives, and keep a catch-all route (`other`) as the fallback so doubtful sessions are not analysed by the wrong rubric.

## Historical flow

```
routing_main preflight   -> sessions, already routed, tokens, low/high cost; no AI call
routing_main run         -> classifies what is new; decisions land in session_routes
historical_main preflight --rubric-id sales_quality       --only-routed   -> exact count: only sessions routed to it
historical_main run       --rubric-id after_sales_quality --only-routed ...
```

`--only-routed` keeps only the sessions whose **current** decision points to the job's rubric (rubric version pinned in the job; a route
without a pinned version matches any). It is part of the job's run id, so a routed run has its own checkpoint. Without the flag nothing changes.
Re-running the routing pass classifies only sessions whose content (or router identity) changed; a budget stop or a failure is simply resumed by
running it again.

## Live flow

A tenant entry in `SCI_TENANTS` has either `rubric_id` (as before) or `routing` (never both):

```json
{"organization_id": "acme", "workspace_id": "default", "routing": {"routes": [...], "fallback": "other"}}
```

For each event, after the content hash is known: reuse the stored decision for that content and router identity if there is one (no call),
otherwise check the deployment-wide monthly budget against the worst case, classify, store the decision, then load the chosen rubric and continue
exactly as in the single-rubric flow (dedupe, per-session cap, budget, evaluation). The run row records the rubric actually used and the sum
of routing and analysis cost. A skip route ends as outcome `ROUTED_SKIP`. The live worker is still **not deployed and AI is disabled in it**;
this path is covered by tests with fakes only.

## Cost model

Measured on the dev data (closed synthetic sessions, `gpt-6-luna` prices from `docs/openai-validation.md`):

* Router call: head of the conversation (about 450 tokens on average, capped at 1200) + question and route descriptions (about 170) -> about 620
  input tokens and about 10 output tokens, roughly **US$ 0.00007 per session** at `gpt-6-luna` rates.
* A full analysis with `sales_quality` v3 averaged **US$ 0.00017 per session** (299 sessions, US$ 0.0506).
* Two rubrics without routing: about US$ 0.00034 per session. With routing: about US$ 0.00007 + US$ 0.00017 = **US$ 0.00024 (about 30% less)**,
  and less where many sessions are "other". With a pricier model the router is a smaller fraction of an analysis, so the saving grows.
* Dev preflight-style worst case for all 25 closed sessions with messages: under **US$ 0.01**.

These are estimates from averages; the pilot below measures them.

## Pilot (needs approval, not run)

Route the closed dev sessions with `gpt-6-luna` and compare with the ground truth of the synthetic data: routing accuracy per route, share of
fallbacks, real cost. Prerequisite: the `session_routes` table and the two views exist in dev (`terraform plan` shows them; **apply is not done**).

## Known limits and follow-ups

* The classifier sees only the head of the conversation. A conversation that starts as a sale and turns into support is routed as a sale.
* The Painel does not show routing cost yet: use `gold_routing_daily` (decisions and cost per day, model and route) until the console reads it.
  `gold_cost_daily` is unchanged on purpose, so the "analyses" numbers keep their meaning. The live monthly budget does include routing cost.
* Routes live in a JSON file (CLI) or in `SCI_TENANTS` (live). Versioned routes in BigQuery with a console editor are a follow-up.
