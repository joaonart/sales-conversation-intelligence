# ADR 0004: Admin console client in TypeScript, Preact and Tailwind

Status: accepted (implemented in console v0.49.0). Date: 2026-11-08.

## Context
The console client was one 2,800-line hand-written JavaScript file (`app.js`) building the DOM with a helper, plus a 480-line stylesheet. It worked and was
safe (no `innerHTML`), but it was untyped, hard to change, and its 218 tests asserted on the *source text* of the file instead of on behaviour. The
requirement stayed the same: a Google Apps Script web app, which serves only HTML (no static files, no path routing, a sandboxed iframe).

## Decision
* **TypeScript (strict) + Preact (TSX)** for the client. Preact is 3 KB, renders values as text nodes (the safety property the console relies on) and has a
  small, conventional component model. State is local hooks plus two contexts (workspace session, toasts/confirm); there is no state library.
* **Tailwind CSS v4**, compiled at build time with the standalone CLI (CSS-first config). Colours are semantic tokens defined for light and dark, so
  components never use a `dark:` variant. Nothing is loaded from a CDN: the stylesheet is generated, minified and inlined.
* **Apps Script compatibility is unchanged:** `scripts/build.mjs` still emits `Code.js`, `index.html`, `app.html` (one `<script>`) and `styles.html` (one
  `<style>`), the page keeps hash routes, and calls go through the same `rpc` envelope. The server is untouched.
* **Types shared with the server:** the client imports the server's `types.ts`, and every `rpc` method has a typed payload and response, so an unknown
  method or a wrong field does not compile.
* **Tests:** pure logic (score breakdown, evidence badges, node states, dashboard figures, paging, rubric editing) is unit-tested; screens are tested in a
  DOM with `@testing-library/preact`; a contract test keeps the client consistent with the server, the Python platform and Terraform (decisions, limits,
  statuses, failure codes, resources, official icons) and forbids markup injection, external URLs and window navigation.

## Alternatives rejected
* **Typed vanilla DOM** (a `h()` helper in `.ts`): the smallest step, but it keeps hand-built DOM and re-rendering by hand.
* **Lit / Svelte / React:** Lit and Svelte add a compiler or a runtime for little gain here; React is 10x the size for no benefit.
* **Tailwind from the CDN (Play CDN):** compiles in the browser and loads a third-party script, which the console deliberately never does.
* **Incremental migration:** the safer path, rejected by the product owner in favour of one rewrite behind a branch, shipped only at parity.

## Consequences
* The client bundle is smaller (about 225 KB of script and 35 KB of CSS against 272 KB and 56 KB) and typed end to end.
* A change to a screen is a typed component edit with a behaviour test, not a text assertion.
* The build now needs the Tailwind CLI (a dev dependency, exact version pinned); `npm ci` and `npm run check` cover it in CI.
* Rolling back is a redeploy of the previous Apps Script version; data and the server are unaffected.
