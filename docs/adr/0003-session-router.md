# ADR 0003: Session router before rubric analysis

Status: accepted (implemented, not yet piloted with real AI). Date: 2026-10-31.

## Context
Two rubrics are active (`sales_quality`, `after_sales_quality`). A rubric asks all its criteria in one call and applies the applicability
gates afterwards in code, so analysing every session with every rubric doubles the AI spend and leaves a `NOT_EVALUABLE` result for each
session on the rubric that does not fit.

## Decision
A small router classifies each session once (head of the conversation, one CHOICE question through the existing `AIProvider`) and sends it to
one rubric or to none. Decisions are persisted append-only (`session_routes`, view `current_session_routes`) keyed by session, content hash and
router identity. Rubric jobs take `--only-routed`. Unusable classifications go to a configured fallback, never to a guessed rubric.

## Alternatives rejected
* **Run every rubric on every session**: simple, but 2x the cost and noisy results.
* **Deterministic rules only (channel, keywords)**: free, but brittle; the channel does not tell a sale from a support request.
* **Let the rubric gates do it** (current behaviour): the gate answer arrives only after the full call is paid.
* **A dedicated classifier service**: an extra component to run; the existing provider contract already supports a CHOICE question.

## Consequences
New table and two views (Terraform plan only until approved), a new Cloud Run Job entrypoint (`routing_main`), and a small extra call per new
or changed session. Routing cost is stored per decision and counted in the live monthly budget. See `docs/routing.md`.
