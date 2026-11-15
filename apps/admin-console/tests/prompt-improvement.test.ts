import { describe, expect, it } from "vitest";
import { GOOD_FROM, MIN_SAMPLE, WEAK_BELOW } from "../src/server/services/promptImprovement";
import { A, B, code, harness, ok, type Harness } from "./helpers";

const as = (role: string): Harness => harness({ "ana@example.com": [[A, role]], "bia@example.com": [[A, "VIEWER"]], "carla@example.com": [[B, "EDITOR"]] });
const scope = { tenant: A, rubric_id: "sales_quality", version: 5, from: "2026-10-15", to: "2026-11-14" };
const preview = (h: Harness, extra: Record<string, unknown> = {}, who = "ana@example.com") => h.call("promptImprovement.preview", { ...scope, ...extra }, who);

/** A workspace with a published rubric of three criteria (a gate, a scored one with a minimum, a yes/no) and the numbers BigQuery would count. */
function withData(h: Harness, o: { analyses?: number; published?: boolean; minimumFails?: boolean } = {}): void {
  const analyses = o.analyses ?? 40;
  h.bq.on(/SELECT name FROM `[^`]*evaluation_rubrics`/, o.published === false ? [] : [{ name: "Qualidade comercial" }]);
  h.bq.on(/FROM `[^`]*evaluation_criteria`/, [
    { criterion_id: "is_sales", criterion_name: "É uma conversa de venda?", weight: 0, required: false },
    { criterion_id: "needs", criterion_name: "Necessidade", weight: 25, required: true },
    { criterion_id: "greeting", criterion_name: "Saudação", weight: 10, required: false },
  ]);
  // the most recently registered answer wins, so the narrower query is registered after the broader one
  h.bq.on(/SELECT criterion_id, minimum_score FROM `[^`]*evaluation_criteria`/, o.minimumFails ? new Error("no column") : [{ criterion_id: "needs", minimum_score: 60 }]);
  h.bq.on(/AVG\(overall_score\) AS avg_score/, [{ analyses, sessions: analyses - 2, avg_score: 61.234, approved: 20, rejected: 12, needs_review: 8 }]);
  h.bq.on(/AS below_minimum_n/, [
    { criterion_id: "is_sales", evaluations: analyses, applicable: analyses, avg_score: 90, weak_n: 0, weighted_n: 0, insufficient_n: 0, not_applicable_n: 0, below_minimum_n: 0, lost_sum: 0 },
    { criterion_id: "needs", evaluations: analyses, applicable: 36, avg_score: 44.44, weak_n: 24, weighted_n: 36, insufficient_n: 2, not_applicable_n: 2, below_minimum_n: 24, lost_sum: 600 },
    { criterion_id: "greeting", evaluations: analyses, applicable: 20, avg_score: 85, weak_n: 1, weighted_n: 20, insufficient_n: 0, not_applicable_n: 20, below_minimum_n: 0, lost_sum: 80 },
  ]);
  h.bq.on(/SELECT criterion_id, answer, COUNT/, [
    { criterion_id: "needs", answer: "none", n: 14 },
    { criterion_id: "needs", answer: "partial", n: 10 },
    { criterion_id: "needs", answer: "complete", n: 12 },
    { criterion_id: "greeting", answer: "true", n: 20 },
  ]);
}

describe("promptImprovement: who may use it", () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ["promptImprovement.rubrics", {}],
    ["promptImprovement.sellers", { from: scope.from, to: scope.to }],
    ["promptImprovement.preview", scope],
    ["promptImprovement.examples", { ...scope, criterion_id: "needs", kind: "weak" }],
  ];

  it("a VIEWER is refused on every method and nothing is queried; an EDITOR and an ADMIN may use them", () => {
    for (const [method, payload] of calls) {
      const h = as("EDITOR");
      expect(code(h.call(method, { tenant: A, ...payload }, "bia@example.com")), method).toBe("FORBIDDEN");
      expect(h.bq.dataCalls(), method).toHaveLength(0);
      withData(h);
      expect(code(h.call(method, { tenant: A, ...payload })), method).toBe("OK");
      const admin = as("ADMIN");
      withData(admin);
      expect(code(admin.call(method, { tenant: A, ...payload })), method).toBe("OK");
    }
  });

  it("a person of another workspace is refused", () => {
    const h = as("EDITOR");
    withData(h);
    for (const [method, payload] of calls) expect(code(h.call(method, { tenant: A, ...payload }, "carla@example.com")), method).toBe("FORBIDDEN");
  });
});

describe("promptImprovement: tenant isolation and no spending", () => {
  it("every statement filters by organization and workspace as bound parameters, never written in the text", () => {
    const h = as("EDITOR");
    withData(h);
    ok(preview(h, { seller: "v1" }));
    ok(h.call("promptImprovement.rubrics", { tenant: A }));
    ok(h.call("promptImprovement.sellers", { tenant: A, from: scope.from, to: scope.to }));
    ok(h.call("promptImprovement.examples", { ...scope, criterion_id: "needs", kind: "weak" }));
    const reads = h.bq.dataCalls().filter((c) => !/audit_log/.test(c.sql));
    expect(reads.length).toBeGreaterThan(8);
    for (const c of reads) {
      expect(c.sql, c.sql).toContain("organization_id = @org AND workspace_id = @ws");
      expect(c.params.org).toEqual({ t: "STRING", v: "org-a" });
      expect(c.params.ws).toEqual({ t: "STRING", v: "ws-a" });
      expect(c.sql).not.toContain("org-a");
    }
  });

  it("every table read in a statement is filtered by the tenant (no unfiltered join)", () => {
    const h = as("EDITOR");
    withData(h);
    ok(preview(h, { seller: "v1" }));
    ok(h.call("promptImprovement.examples", { ...scope, seller: "v1", criterion_id: "needs", kind: "good" }));
    for (const c of h.bq.dataCalls().filter((x) => !/audit_log/.test(x.sql))) {
      const tables = (c.sql.match(/FROM `[^`]+`|JOIN `[^`]+`/g) ?? []).length;
      const filters = (c.sql.match(/organization_id = @org AND workspace_id = @ws|\.organization_id = @org AND \w+\.workspace_id = @ws/g) ?? []).length;
      expect(filters, c.sql).toBeGreaterThanOrEqual(tables);
    }
  });

  it("the preview only reads: no INSERT, UPDATE, DELETE or any spending, and it never touches the AI ledger", () => {
    const h = as("EDITOR");
    withData(h);
    ok(preview(h));
    for (const c of h.bq.dataCalls()) {
      expect(c.sql).toMatch(/^(SELECT|WITH)/);
      expect(c.sql).not.toMatch(/INSERT|UPDATE|DELETE|MERGE|ai_spend/);
    }
  });
});

describe("promptImprovement.preview: validation", () => {
  it.each([
    [{ from: "2026-11-15" }, "from after to"],
    [{ from: "2025-01-01" }, "more than 366 days"],
    [{ from: "2026-02-30" }, "not a date"],
    [{ rubric_id: "x'; DROP TABLE t; --" }, "rubric id with SQL"],
    [{ rubric_id: "" }, "empty rubric"],
    [{ version: 0 }, "version 0"],
    [{ version: "5; --" }, "version text"],
    [{ seller: "a b" }, "seller with a space"],
  ] as Array<[Record<string, unknown>, string]>)("refuses %j (%s) before querying", (bad) => {
    const h = as("EDITOR");
    withData(h);
    expect(code(preview(h, bad))).toBe("INVALID_INPUT");
    expect(h.bq.dataCalls()).toHaveLength(0);
  });

  it("an empty seller means no filter", () => {
    const h = as("EDITOR");
    withData(h);
    ok(preview(h, { seller: "" }));
    expect(h.bq.dataCalls().some((c) => "seller" in c.params)).toBe(false);
  });

  it("only a PUBLISHED rubric version can be looked at", () => {
    const h = as("EDITOR");
    withData(h, { published: false });
    expect(code(preview(h))).toBe("NOT_FOUND");
    expect(h.bq.dataCalls().some((c) => /session_criterion_results/.test(c.sql))).toBe(false);
  });
});

describe("promptImprovement.preview: the numbers", () => {
  it("returns the rubric, the period and the sample, counted and rounded here", () => {
    const h = as("EDITOR");
    withData(h);
    const p = ok(preview(h)) as { rubric: object; period: object; sample: Record<string, number>; enough: boolean; weak_below: number; min_sample: number };
    expect(p.rubric).toEqual({ rubric_id: "sales_quality", version: 5, name: "Qualidade comercial" });
    expect(p.period).toEqual({ from: "2026-10-15", to: "2026-11-14" });
    expect(p.sample).toEqual({ analyses: 40, sessions: 38, avg_score: 61.2, approved: 20, rejected: 12, needs_review: 8 });
    expect(p.enough).toBe(true);
    expect(p.weak_below).toBe(WEAK_BELOW);
    expect(p.min_sample).toBe(MIN_SAMPLE);
  });

  it("per criterion: percentages from the counts, points lost over every analysis, and the criteria that cost the most first", () => {
    const h = as("EDITOR");
    withData(h);
    const p = ok(preview(h)) as { criteria: Array<Record<string, unknown>> };
    expect(p.criteria.map((c) => c.criterion_id)).toEqual(["needs", "greeting", "is_sales"]); // by points lost; the gate (nothing lost) last
    const needs = p.criteria[0] as Record<string, unknown>;
    expect(needs).toMatchObject({
      name: "Necessidade", weight: 25, required: true, minimum_score: 60, evaluations: 40, applicable: 36, avg_score: 44.4,
      weak_pct: 66.7, insufficient_pct: 5, not_applicable_pct: 5, below_minimum_pct: 66.7, points_lost: 15, enough: true,
    });
    expect(needs.answers).toEqual([{ answer: "none", n: 14 }, { answer: "partial", n: 10 }, { answer: "complete", n: 12 }]);
    const greeting = p.criteria[1] as Record<string, unknown>;
    expect(greeting).toMatchObject({ points_lost: 2, weak_pct: 5, below_minimum_pct: null, minimum_score: null, enough: false }); // 20 applicable: under the minimum sample
    const gate = p.criteria[2] as Record<string, unknown>;
    expect(gate).toMatchObject({ weight: 0, weak_pct: null, points_lost: 0 }); // a gate has no weighted evaluations: no percentage
  });

  it("the points lost of the criteria add up to what the sample lost of the overall score (when each analysis applies everything)", () => {
    const h = as("EDITOR");
    withData(h);
    const p = ok(preview(h)) as { criteria: Array<{ points_lost: number }> };
    expect(p.criteria.reduce((n, c) => n + c.points_lost, 0)).toBeCloseTo(17, 5);
  });

  it("passes the minimums to the query as one bound array of structs (never inlined), and none without a minimum column", () => {
    const h = as("EDITOR");
    withData(h);
    ok(preview(h));
    const stats = h.bq.dataCalls().find((c) => /below_minimum_n/.test(c.sql));
    expect(stats?.params.mins).toEqual({ t: "STRUCTS", fields: { criterion_id: "STRING", minimum: "FLOAT64" }, v: [{ criterion_id: "needs", minimum: 60 }] });
    expect(stats?.sql).toContain("LEFT JOIN UNNEST(@mins)");
    const old = as("EDITOR");
    withData(old, { minimumFails: true });
    const p = ok(preview(old)) as { criteria: Array<{ criterion_id: string; minimum_score: number | null; below_minimum_pct: number | null }> };
    expect(p.criteria.find((c) => c.criterion_id === "needs")).toMatchObject({ minimum_score: null, below_minimum_pct: null });
    expect(old.bq.dataCalls().find((c) => /below_minimum_n/.test(c.sql))?.params.mins).toMatchObject({ v: [] });
  });

  it("flags a small sample, and an empty one is not an error", () => {
    const h = as("EDITOR");
    withData(h, { analyses: 12 });
    expect((ok(preview(h)) as { enough: boolean }).enough).toBe(false);
    const none = as("EDITOR");
    withData(none, { analyses: 0 });
    none.bq.on(/AVG\(overall_score\) AS avg_score/, [{ analyses: 0, sessions: 0, avg_score: null, approved: 0, rejected: 0, needs_review: 0 }]);
    none.bq.on(/AS below_minimum_n/, []);
    const p = ok(preview(none)) as { sample: { analyses: number; avg_score: number | null }; criteria: Array<{ points_lost: number; avg_score: number | null }> };
    expect(p.sample).toMatchObject({ analyses: 0, avg_score: null });
    expect(p.criteria.every((c) => c.points_lost === 0 && c.avg_score === null)).toBe(true);
  });

  it("uses the latest completed analysis of each session of that rubric version, started in the period", () => {
    const h = as("EDITOR");
    withData(h);
    ok(preview(h));
    const sample = h.bq.dataCalls().find((c) => /AVG\(overall_score\)/.test(c.sql));
    expect(sample?.sql).toContain("rubric_id = @rubric AND rubric_version = @ver");
    expect(sample?.sql).toContain("DATE(started_at) BETWEEN @from AND @to");
    expect(sample?.sql).toContain("analysis_status = 'COMPLETED'");
    expect(sample?.sql).toContain("QUALIFY ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY completed_at DESC, analysis_id DESC) = 1");
    expect(sample?.params).toMatchObject({ rubric: { t: "STRING", v: "sales_quality" }, ver: { t: "INT64", v: 5 }, from: { t: "DATE", v: "2026-10-15" }, to: { t: "DATE", v: "2026-11-14" } });
  });
});

describe("promptImprovement: sellers", () => {
  it("filters the sessions of one seller on the latest row of the session, bounded in time, and lists the sellers of the period", () => {
    const h = as("EDITOR");
    withData(h);
    ok(preview(h, { seller: "v1" }));
    const sample = h.bq.dataCalls().find((c) => /AVG\(overall_score\)/.test(c.sql));
    expect(sample?.sql).toContain("QUALIFY ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY updated_at DESC, closed_at DESC) = 1");
    expect(sample?.sql).toContain("WHERE seller_id = @seller"); // outside the QUALIFY, on the latest row
    expect(sample?.sql).toMatch(/DATE\(started_at\) BETWEEN DATE_SUB\(@from, INTERVAL 365 DAY\) AND @to/);
    expect(sample?.params.seller).toEqual({ t: "STRING", v: "v1" });
    h.bq.on(/SELECT seller_id, COUNT/, [{ seller_id: "v1", sessions: 12 }, { seller_id: "v2", sessions: 3 }]);
    expect(ok(h.call("promptImprovement.sellers", { tenant: A, from: scope.from, to: scope.to }))).toEqual([{ seller_id: "v1", sessions: 12 }, { seller_id: "v2", sessions: 3 }]);
    expect(code(h.call("promptImprovement.sellers", { tenant: A, from: "2026-11-15", to: scope.to }))).toBe("INVALID_INPUT");
  });
});

describe("promptImprovement.examples", () => {
  const exampleRows = [
    { session_id: "s1", analysis_id: "a1", score: 20, answer: "none", message_id: "m1", sender_type: "customer", content: "Meu CPF é 123.456.789-09 e meu e-mail ana@empresa.com", sequence_number: 1 },
    { session_id: "s1", analysis_id: "a1", score: 20, answer: "none", message_id: "m2", sender_type: "seller", content: "x".repeat(400), sequence_number: 2 },
    { session_id: "s2", analysis_id: "a2", score: 40, answer: "partial", message_id: null, sender_type: null, content: null, sequence_number: null },
  ];
  const run = (h: Harness, extra: Record<string, unknown> = {}) => h.call("promptImprovement.examples", { ...scope, criterion_id: "needs", kind: "weak", ...extra });

  it("groups the cited messages by analysis, masks personal data and cuts long text", () => {
    const h = as("EDITOR");
    withData(h);
    h.bq.on(/picked AS/, exampleRows);
    const r = ok(run(h)) as { examples: Array<{ session_id: string; score: number; evidence: Array<{ excerpt: string; sender_type: string }> }>; maskedNote: string };
    expect(r.examples.map((e) => e.session_id)).toEqual(["s1", "s2"]);
    const first = r.examples[0] as (typeof r.examples)[number];
    expect(first.evidence[0]?.excerpt).not.toMatch(/123\.456|ana@empresa/);
    expect(first.evidence[0]?.excerpt).toContain("[CPF]");
    expect(first.evidence[1]?.excerpt.length).toBe(281);
    expect(first.evidence[1]?.excerpt.endsWith("…")).toBe(true);
    expect(r.examples[1]?.evidence).toEqual([]); // an analysis with no cited messages: still shown, with no evidence
    expect(r.maskedNote).toContain("mascarados");
  });

  it("picks the worst scores for 'weak' and the best for 'good', limited to a few", () => {
    const h = as("EDITOR");
    withData(h);
    h.bq.on(/picked AS/, []);
    ok(run(h, { kind: "weak" }));
    ok(run(h, { kind: "good", limit: 2 }));
    const [weak, good] = h.bq.dataCalls().filter((c) => /picked AS/.test(c.sql));
    expect(weak?.sql).toContain("r.normalized_score < @weak");
    expect(weak?.sql).toContain("ORDER BY r.normalized_score ASC");
    expect(weak?.sql).toContain("LIMIT 3");
    expect(good?.sql).toContain("r.normalized_score >= @good");
    expect(good?.sql).toContain("ORDER BY r.normalized_score DESC");
    expect(good?.sql).toContain("LIMIT 2");
    expect(good?.params.good).toEqual({ t: "INT64", v: GOOD_FROM });
    expect(weak?.params.cid).toEqual({ t: "STRING", v: "needs" });
  });

  it("refuses an unknown kind, too many examples, or a bad criterion id", () => {
    const h = as("EDITOR");
    withData(h);
    for (const bad of [{ kind: "worst" }, { limit: 6 }, { limit: 0 }, { criterion_id: "a b" }, { criterion_id: "" }]) expect(code(run(h, bad)), JSON.stringify(bad)).toBe("INVALID_INPUT");
    expect(h.bq.dataCalls()).toHaveLength(0);
  });

  it("reading conversation text is audited with ids and counts, never text", () => {
    const h = as("EDITOR");
    withData(h);
    h.bq.on(/picked AS/, exampleRows);
    ok(run(h));
    const audit = h.bq.calls.filter((c) => /INSERT INTO `[^`]*audit_log`/.test(c.sql)).at(-1);
    expect(audit?.params.action).toEqual({ t: "STRING", v: "promptImprovement.examples" });
    expect(audit?.params.eid).toEqual({ t: "STRING", v: "needs" });
    const details = JSON.parse(String((audit?.params.details as { v: string }).v));
    expect(details).toEqual({ rubric_id: "sales_quality", version: 5, kind: "weak", sessions: 2 });
    expect(JSON.stringify(audit?.params)).not.toMatch(/CPF|123\.456|ana@empresa|xxxx/);
  });

  it("fails closed: if the audit cannot be written, no text is returned", () => {
    const h = as("EDITOR");
    withData(h);
    h.bq.on(/picked AS/, exampleRows);
    h.bq.on(/INSERT INTO `[^`]*audit_log`/, new Error("audit down"));
    const r = run(h);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/CPF|123\.456|ana@empresa/);
  });

  it("reads the messages of the picked sessions only, in a bounded window, once each", () => {
    const h = as("EDITOR");
    withData(h);
    h.bq.on(/picked AS/, []);
    ok(run(h));
    const q = h.bq.dataCalls().find((c) => /picked AS/.test(c.sql));
    expect(q?.sql).toContain("session_id IN (SELECT session_id FROM picked)");
    expect(q?.sql).toMatch(/created_at >= TIMESTAMP\(DATE_SUB\(@from, INTERVAL 365 DAY\)\) AND created_at < TIMESTAMP\(DATE_ADD\(@to, INTERVAL 2 DAY\)\)/);
    expect(q?.sql).toContain("QUALIFY ROW_NUMBER() OVER (PARTITION BY message_id ORDER BY created_at) = 1"); // a message delivered twice shows once
  });
});
