import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { A, harness, ok } from "./helpers";

// Not an assertion test: with DUMP_SQL=<file> it exports every statement the server can issue, so they can be
// dry-run against a real BigQuery project (see README "Validate the SQL"). Skipped otherwise.
it.skipIf(!process.env.DUMP_SQL)("dumps SQL for dry-run validation", () => {
  const h = harness({ "ana@example.com": [[A, "ADMIN"]] });
  const crit = { criterion_id: "greeting", criterion_name: "G", evaluation_instructions: "q", evaluation_type: "PREDICATE", weight: 10, required: false, enabled: true, score_mapping: { true: 100, false: 0 }, level_descriptions: {}, display_order: 1 };
  const policy = { minimum_approval_score: 70, missing_evidence_policy: "NEEDS_REVIEW", max_analyses_per_session: null, max_input_tokens: null, monthly_budget_usd: null, min_messages: 3, min_customer_messages: 0, min_seller_messages: 0 };
  h.bq.on(/FROM `[^`]*sessions` WHERE/, [{ session_id: "s1", started_at: "2026-01-02T00:00:00.000Z" }]);
  h.bq.on(/FROM `[^`]*evaluation_rubrics` WHERE/, [{ rubric_id: "r1", version: 2, name: "n", status: "DRAFT", description: "" }]);
  h.bq.on(/FROM `[^`]*evaluation_criteria`/, [{ ...crit, score_mapping: JSON.stringify(crit.score_mapping), level_descriptions: undefined as never, score_levels: null }]);
  h.bq.on(/FROM `[^`]*evaluation_policies`/, [{ ...policy }]);
  h.bq.on(/FROM `[^`]*review_queue` WHERE/, [{ analysis_id: "a1" }]);
  h.bq.on(/SELECT DISTINCT rubric_id FROM/, [{ rubric_id: "r1" }]);
  h.bq.on(/FROM `[^`]*current_session_results` WHERE/, [{ analysis_id: "a1" }]);
  h.bq.on(/SELECT email, role, status, changed_at/, [{ email: "ana@example.com", role: "ADMIN", status: "ACTIVE" }, { email: "b@example.com", role: "ADMIN", status: "ACTIVE" }]);
  const calls: Array<[string, Record<string, unknown>]> = [
    ["dashboard.summary", {}], ["pipeline.overview", {}], ["runs.list", {}], ["runs.list", { cursor: { at: "2026-01-02T03:04:05.123456Z", id: "r1" } }], ["runs.count", {}], ["review.count", { filter: "decided" }], ["review.list", { cursor: { at: "2026-01-02T03:04:05.123456Z", id: "a1" } }], ["review.list", {}], ["review.list", { filter: "decided" }], ["review.decide", { sessionId: "s1", analysisId: "a1", decision: "DISAGREED", comment: "motivo" }],
    ["sessions.list", { from: "2026-01-01", to: "2026-01-31", status: "COMPLETED", query: "s1", cursor: { started_at: "2026-01-02T00:00:00.000Z", session_id: "s1" } }],
    ["sessions.list", { from: "2026-01-01", to: "2026-01-31", channel: "whatsapp", result: "APPROVED", rubric: "r1" }], ["sessions.count", { from: "2026-01-01", to: "2026-01-31", channel: "whatsapp", result: "REJECTED", rubric: "r1", status: "COMPLETED" }], ["sessions.channels", { from: "2026-01-01", to: "2026-01-31" }],
    ["sessions.get", { sessionId: "s1" }], ["rubrics.list", {}], ["rubrics.get", { rubric_id: "r1", version: 2 }],
    ["rubrics.createDraft", { rubric_id: "r1", name: "x" }], ["rubrics.createDraft", { rubric_id: "r1", name: "x", cloneFromVersion: 2 }],
    ["users.list", {}], ["users.list", { cursor: { key: "a@example.com" } }], ["users.count", {}], ["audit.list", { cursor: { at: "2026-01-02T03:04:05.123456Z", id: "e1" } }], ["audit.count", {}], ["rubrics.count", {}], ["rubrics.ids", {}], ["rubrics.list", { cursor: { key: "r0" } }], ["users.upsert", { email: "n@example.com", role: "VIEWER" }], ["audit.list", {}], ["rubrics.deleteDraft", { rubric_id: "r1", version: 2 }],
  ];
  for (const [m, p] of calls) try { h.call(m, { tenant: A, ...p }); } catch { /* ignore */ }
  const got = ok(h.call("rubrics.get", { tenant: A, rubric_id: "r1", version: 2 })) as { etag: string };
  h.call("rubrics.saveDraft", { tenant: A, rubric_id: "r1", version: 2, etag: got.etag, draft: { name: "n", description: "", criteria: [crit], policy } });
  h.call("rubrics.publish", { tenant: A, rubric_id: "r1", version: 2, etag: got.etag });
  writeFileSync(process.env.DUMP_SQL as string, JSON.stringify(h.bq.calls.map((c) => ({ sql: c.sql, params: c.params })), null, 1));
});
