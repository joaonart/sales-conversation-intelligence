import { describe, expect, it } from "vitest";
import { AppError } from "../src/server/errors";
import { A, code, harness, ok, type Harness } from "./helpers";

const as = (role = "VIEWER"): Harness => harness({ "ana@example.com": [[A, role]] });
const LEDGER = /FROM `[^`]*ai_spend`/;
const SESSION = [{ session_id: "s1", channel: "whatsapp", status: "closed", started_at: "2026-10-01T00:00:00.000Z" }];
const UNAVAILABLE = new AppError("UNAVAILABLE", "Falha ao consultar o BigQuery. Tente novamente.");
const lines = [
  { analysis_id: "a1", kind: "ANALYSIS", model: "gpt-6-luna", calls: 1, input_tokens: 1000, output_tokens: 100, cost_usd: 0.0003 },
  { analysis_id: "a1", kind: "EVIDENCE", model: "gpt-4o-mini", calls: 1, input_tokens: 1500, output_tokens: 120, cost_usd: 0.0002 },
  { analysis_id: "a1", kind: "SUMMARY", model: "gpt-4o-mini", calls: 1, input_tokens: 1800, output_tokens: 350, cost_usd: 0.0005 },
];

describe("sessions.get: what each analysis paid, by step", () => {
  function open(h: Harness, ledger: unknown) {
    h.bq.on(/FROM `[^`]*sessions` WHERE/, SESSION);
    h.bq.on(/FROM `[^`]*current_session_results`/, [{ analysis_id: "a1", rubric_id: "sales_quality", rubric_version: 5 }]);
    h.bq.on(LEDGER, ledger as never);
    return ok(h.call("sessions.get", { tenant: A, sessionId: "s1" })) as { cost_lines: Array<Record<string, unknown>> };
  }

  it("returns the ledger lines of the analyses of the session (one per step and model), scoped to the tenant and to those analyses only", () => {
    const h = as();
    const d = open(h, lines);
    expect(d.cost_lines.map((l) => l.kind)).toEqual(["ANALYSIS", "EVIDENCE", "SUMMARY"]);
    const q = h.bq.dataCalls().find((c) => LEDGER.test(c.sql));
    expect(q?.sql).toContain("organization_id = @org AND workspace_id = @ws");
    expect(q?.sql).toContain("subject_id IN UNNEST(@ids)");
    expect(q?.sql).toContain("GROUP BY subject_id, kind, model");
    expect(q?.sql).toMatch(/occurred_at >= TIMESTAMP_SUB\(@lo, INTERVAL 1 DAY\)/); // a bounded read of the partitioned ledger
    expect(q?.params.org).toEqual({ t: "STRING", v: "org-a" });
    expect(q?.params.ids).toEqual({ t: "ARRAY", of: "STRING", v: ["a1"] });
    expect(q?.sql).not.toContain("org-a");
  });

  it("an environment without the ledger shows no lines instead of failing the page", () => {
    expect(open(as(), UNAVAILABLE).cost_lines).toEqual([]);
  });

  it("any other failure of the ledger is not hidden", () => {
    const h = as();
    h.bq.on(/FROM `[^`]*sessions` WHERE/, SESSION);
    h.bq.on(/FROM `[^`]*current_session_results`/, [{ analysis_id: "a1", rubric_id: "r", rubric_version: 1 }]);
    h.bq.on(LEDGER, new AppError("FORBIDDEN", "sem permissão") as never);
    expect(code(h.call("sessions.get", { tenant: A, sessionId: "s1" }))).toBe("FORBIDDEN");
  });

  it("a session with no analysis asks the ledger for nothing", () => {
    const h = as();
    h.bq.on(/FROM `[^`]*sessions` WHERE/, SESSION);
    const d = ok(h.call("sessions.get", { tenant: A, sessionId: "s1" })) as { cost_lines: unknown[] };
    expect(d.cost_lines).toEqual([]);
    expect(h.bq.dataCalls().some((c) => LEDGER.test(c.sql))).toBe(false);
  });
});

describe("runs.get: what a run paid, by step", () => {
  const RUN = [{ run_id: "hist-1", run_status: "COMPLETED", sessions_failed: 0, rubric_id: "sales_quality", rubric_version: 5 }];
  const rows = lines.map(({ analysis_id: _a, ...l }) => l);

  it("sums the ledger lines of the analyses the run wrote, tenant-scoped, for any role", () => {
    for (const role of ["VIEWER", "EDITOR", "ADMIN"]) {
      const h = as(role);
      h.bq.on(/FROM `[^`]*latest_analysis_runs` WHERE/, RUN);
      h.bq.on(/GROUP BY kind, model/, rows);
      const d = ok(h.call("runs.get", { tenant: A, run_id: "hist-1" })) as { cost_lines: Array<{ kind: string }> };
      expect(d.cost_lines.map((l) => l.kind)).toEqual(["ANALYSIS", "EVIDENCE", "SUMMARY"]);
      const q = h.bq.dataCalls().find((c) => LEDGER.test(c.sql));
      expect(q?.sql).toContain("subject_id IN (SELECT analysis_id FROM");
      expect(q?.sql).toMatch(/run_id = @run_id/);
      expect((q?.sql.match(/organization_id = @org AND workspace_id = @ws/g) ?? []).length).toBe(2); // the ledger and the analyses it is matched against
      expect(q?.params.run_id).toEqual({ t: "STRING", v: "hist-1" });
    }
  });

  it("an environment without the ledger still opens the run, with no lines", () => {
    const h = as();
    h.bq.on(/FROM `[^`]*latest_analysis_runs` WHERE/, RUN);
    h.bq.on(/GROUP BY kind, model/, UNAVAILABLE as never);
    expect(ok(h.call("runs.get", { tenant: A, run_id: "hist-1" }))).toMatchObject({ cost_lines: [], run: { run_id: "hist-1" } });
  });
});

describe("dashboard.summary: the cost by step", () => {
  it("reads the ledger of the period by step and model, tenant-scoped, as its own block (so the page loads it in parallel and caches it like the others)", () => {
    const h = as();
    h.bq.on(LEDGER, lines.map(({ analysis_id: _a, ...l }) => l));
    const d = ok(h.call("dashboard.summary", { tenant: A, days: 30, parts: ["steps"] })) as { steps: Array<{ kind: string }> };
    expect(Object.keys(d)).toEqual(["steps"]);
    expect(d.steps.map((l) => l.kind)).toEqual(["ANALYSIS", "EVIDENCE", "SUMMARY"]);
    const q = h.bq.dataCalls().find((c) => LEDGER.test(c.sql));
    expect(q?.sql).toContain("organization_id = @org AND workspace_id = @ws");
    expect(q?.sql).toContain("DATE(occurred_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)");
    expect(q?.sql).toContain("GROUP BY kind, model");
    expect(q?.params.days).toEqual({ t: "INT64", v: 30 });
  });

  it("an environment without the ledger has no lines, and the other blocks are unaffected", () => {
    const h = as();
    h.bq.on(LEDGER, UNAVAILABLE as never);
    expect((ok(h.call("dashboard.summary", { tenant: A, days: 30, parts: ["steps"] })) as { steps: unknown[] }).steps).toEqual([]);
  });
});

describe("executions.preview: the estimate by step adds up to the estimate", () => {
  const SESSIONS = { sessions: 10, with_messages: 10, already: 0, tokens: 8000 };
  function preview(body: Record<string, unknown>, asks = false) {
    const h = as("ADMIN");
    h.bq.on(/WITH s AS/, [SESSIONS]);
    h.bq.on(/FROM `[^`]*evaluation_rubrics` WHERE/, [{ status: "PUBLISHED" }]);
    h.bq.on(/SELECT summary_prompt IS NOT NULL/, [{ asks }]);
    return ok(h.call("executions.preview", { tenant: A, start: "2026-01-01", end: "2026-01-31", max_sessions: 50, max_cost_usd: 0.5, ...body })) as {
      estimate_low_usd: number; estimate_high_usd: number; steps: Array<{ step: string; model: string; low_usd: number; high_usd: number }>;
    };
  }
  const sum = (p: ReturnType<typeof preview>, k: "low_usd" | "high_usd") => p.steps.reduce((n, s) => n + s[k], 0);

  it("a Decisions analysis with a general evaluation has three lines, each to its model, and they add up to the totals", () => {
    const p = preview({ kind: "ANALYSIS", rubric_id: "r1", rubric_version: 1 }, true);
    expect(p.steps.map((s) => s.step)).toEqual(["ANALYSIS", "EVIDENCE", "SUMMARY"]);
    expect(p.steps.map((s) => s.model)).toEqual(["gpt-6-luna", "gpt-4o-mini", "gpt-4o-mini"]);
    expect(sum(p, "low_usd")).toBeCloseTo(p.estimate_low_usd, 5);
    expect(sum(p, "high_usd")).toBeCloseTo(p.estimate_high_usd, 5);
  });

  it("without a general evaluation there are two lines; a routing run has one; a Responses analysis has no evidence line", () => {
    expect(preview({ kind: "ANALYSIS", rubric_id: "r1", rubric_version: 1 }).steps.map((s) => s.step)).toEqual(["ANALYSIS", "EVIDENCE"]);
    expect(preview({ kind: "ROUTING" }).steps.map((s) => s.step)).toEqual(["ROUTING"]);
    const responses = preview({ kind: "ANALYSIS", rubric_id: "r1", rubric_version: 1, provider: "responses", model: "gpt-4o" }, true);
    expect(responses.steps.map((s) => s.step)).toEqual(["ANALYSIS", "SUMMARY"]);
    for (const p of [responses, preview({ kind: "ROUTING" })]) expect(sum(p, "high_usd")).toBeCloseTo(p.estimate_high_usd, 5);
  });
});
