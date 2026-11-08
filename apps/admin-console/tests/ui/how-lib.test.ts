import { describe, expect, it } from "vitest";
import { MIN_COMPARABLE, bestModel, kpisOf, modelEfficiency, scorePoint } from "../../src/ui/lib/dashboard";
import { ARCH, ARCH_EDGES, ARCH_ROW, RES_GROUPS, RES_SECTIONS } from "../../src/ui/lib/howData";
import { agoText, archState, execQueue, liveSummary, ruleText } from "../../src/ui/lib/pipelineState";
import { formulaText, noteText, scoreBreakdown, weightless } from "../../src/ui/lib/score";
import { drawEdge } from "../../src/ui/views/how/Architecture";
import type { CriterionResult } from "../../src/ui/lib/types";

const crit = (o: Partial<CriterionResult>): CriterionResult => ({ analysis_id: "a", criterion_id: "c", applicability_status: "APPLICABLE", normalized_score: 100, criterion_weight: 10, evaluation_result: null, evidence_message_ids: [], confidence: null, ...o });

describe("score breakdown", () => {
  it("counts only applicable, scored criteria and each one's share of the grade", () => {
    const list = [
      crit({ criterion_id: "a", normalized_score: 100, criterion_weight: 10 }),
      crit({ criterion_id: "b", normalized_score: 0, criterion_weight: 30 }),
      crit({ criterion_id: "gate", normalized_score: 100, criterion_weight: 0 }),
      crit({ criterion_id: "na", applicability_status: "NOT_APPLICABLE", normalized_score: null, criterion_weight: 50 }),
    ];
    const bd = scoreBreakdown(list, { overall_score: 25 });
    expect(bd.inside.map((c) => c.criterion_id)).toEqual(["a", "b", "gate"]);
    expect(bd.totalW).toBe(40);
    expect(bd.num).toBe(1000);
    expect(bd.parts.a).toBe(25);
    expect(bd.matches).toBe(true);
    expect(formulaText(bd)).toBe("Nota final = Σ (nota × peso) ÷ Σ pesos que entram = 1.000 ÷ 40 = 25");
  });
  it("claims no formula when the stored grade is not the plain weighted average", () => {
    expect(scoreBreakdown([crit({})], { overall_score: 40 }).matches).toBe(false);
    expect(scoreBreakdown([], { overall_score: null }).matches).toBe(false);
  });
  it("a weightless true/false criterion shows its answer, not a score", () => {
    const gate = crit({ criterion_weight: 0, evaluation_result: JSON.stringify({ answer: true }), normalized_score: 100 });
    expect(weightless(gate)).toBe(true);
    expect(noteText(gate)).toBe("true");
    expect(noteText(crit({ criterion_weight: 10, normalized_score: 70 }))).toBe("70");
  });
});

describe("dashboard numbers", () => {
  const d = {
    quality: [
      { sessions: 10, scored_sessions: 8, avg_score: 50, approved: 3, rejected: 5, needs_review: 1, not_evaluable: 1 },
      { sessions: 5, scored_sessions: 2, avg_score: 100, approved: 2, rejected: 0, needs_review: 2, not_evaluable: 1 },
    ],
    cost: [{ day: "2026-01-01", analysis_mode: "live", model: "m", analyses: 1, cost_usd: 0.25, avg_duration_ms: null }],
    runs: [],
    coverage: [{ analysed: 12, sessions: 20 }],
    models: [{ provider: "decisions", model: "m", analyses: 20, current_analyses: 15, cost_usd: 1, completed: 10 }],
  };
  it("reconciles: current = approved + rejected + in review + not evaluable", () => {
    const k = kpisOf(d);
    expect(k.current).toBe(15);
    expect(k.approved + k.rejected + k.inReview + k.notEvaluable).toBe(15);
    expect(k.decided).toBe(10);
    expect(k.avgScore).toBe((50 * 8 + 100 * 2) / 10);
    expect(k.covered).toBe(12);
    expect(k.executed).toBe(20);
    expect(k.executedCurrent).toBe(15);
  });
  it("has no average without scored analyses", () => expect(kpisOf({ ...d, quality: [], coverage: [] }).avgScore).toBeNull());
  it("ranks models by cost per completed analysis and names a best one only with two comparable models", () => {
    const rows = modelEfficiency([
      { provider: "p", model: "cheap", analyses: MIN_COMPARABLE, current_analyses: 5, cost_usd: 1, completed: 20 },
      { provider: "p", model: "dear", analyses: MIN_COMPARABLE, current_analyses: 5, cost_usd: 4, completed: 20 },
      { provider: "p", model: "none", analyses: 3, current_analyses: 3, cost_usd: 1, completed: 0 },
    ]);
    expect(rows.map((r) => r.model)).toEqual(["cheap", "dear", "none"]);
    expect(bestModel(rows)?.model).toBe("cheap");
    expect(bestModel(rows.slice(0, 1))).toBeNull();
    expect(rows[2]?.perDone).toBeNull();
  });
  it("labels chart points by grain and knows an open bucket", () => {
    const now = Date.UTC(2026, 10, 8);
    expect(scorePoint("month", "2026-11-01", 50, now)).toMatchObject({ label: "nov/26", tip: "novembro de 2026", partial: true });
    expect(scorePoint("quarter", "2026-07-01", 50, now)).toMatchObject({ label: "T3/26", tip: "3º trimestre de 2026", partial: false });
    expect(scorePoint("week", "2026-10-05", 50, now).tip).toBe("Semana de 05/10/2026");
    expect(scorePoint("year", "2025-01-01", 50, now)).toMatchObject({ label: "2025", partial: false });
  });
});

describe("pipeline state", () => {
  it("says a request has waited too long to be picked up", () => {
    const now = Date.parse("2026-11-08T12:00:00Z");
    const o = { execVisible: [{ visible: true }], executor: [{ status: "REQUESTED", requests: 2, oldest_at: "2026-11-08T11:00:00Z", last_at: null }] };
    expect(archState("executor", o, now)).toEqual(["Pedido parado", "warn", "2 pedidos esperando há 1 h: o executor não o pegou"]);
    const fresh = { ...o, executor: [{ status: "REQUESTED", requests: 1, oldest_at: "2026-11-08T11:50:00Z", last_at: null }] };
    expect(archState("executor", fresh, now)[0]).toBe("Pedido na fila");
  });
  it("hides the executor and the schedules from anyone who is not an administrator", () => {
    expect(archState("executor", {})).toEqual(["Restrito", "", "Visível para administradores"]);
    expect(archState("schedules", { execVisible: [{ visible: false }] })[0]).toBe("Restrito");
  });
  it("tells the live worker's outcomes apart", () => {
    const o = { liveEvents: [{ run_status: "EVALUATED", events: 3, last_at: "2026-01-02" }, { run_status: "DUPLICATE_CONTENT", events: 1, last_at: "2026-01-03" }, { run_status: "BUDGET_BLOCKED", events: 2, last_at: null }] };
    expect(liveSummary(o)).toEqual({ handled: 6, evaluated: 3, repeated: 1, refused: 2, last: "2026-01-03" });
    expect(archState("live", o)[2]).toBe("3 analisadas · 1 repetida · 2 recusadas");
    expect(archState("live", {})[1]).toBe("warn");
  });
  it("counts waiting, running and the last finished request", () => {
    const q = execQueue({ execVisible: [{ visible: true }], executor: [{ status: "RUNNING", requests: 1, oldest_at: null, last_at: null }, { status: "COMPLETED", requests: 4, oldest_at: null, last_at: "2026-01-05" }] });
    expect(q).toMatchObject({ visible: true, waiting: 0, running: 1, last: { at: "2026-01-05", status: "COMPLETED" } });
  });
  it("says how long ago in minutes, hours and days", () => {
    expect(agoText(5 * 60000)).toBe("há 5 min");
    expect(agoText(3 * 3600000)).toBe("há 3 h");
    expect(agoText(3 * 86400000)).toBe("há 3 dias");
  });
  it("writes the applicability rule in words", () => {
    expect(ruleText(null)).toBe("Sempre");
    expect(ruleText({ conditions: [{ criterion_id: "g", equals: ["true"] }, { criterion_id: "h", equals: ["a", "b"] }] })).toBe("Se g = true e Se h = a ou b");
    expect(ruleText({ type: "depends_on", criterion_id: "g", equals: ["x"] })).toBe("Se g = x");
    expect(ruleText({ type: "other" })).toBe("Regra condicional");
  });
});

describe("how data", () => {
  it("every connector joins two components that exist and every component has a row", () => {
    const ids = new Set(ARCH.map((n) => n.id));
    for (const [a, b] of ARCH_EDGES) {
      expect(ids.has(a)).toBe(true);
      expect(ids.has(b)).toBe(true);
    }
    for (const n of ARCH) expect(ARCH_ROW[n.id]).toBeGreaterThan(0);
  });
  it("every resource group of a section names a tab that section has", () => {
    for (const g of RES_GROUPS.filter((x) => x.section)) expect(RES_SECTIONS[g.section ?? ""]?.tabs.map(([t]) => t)).toContain(g.tab);
  });
  it("draws a straight connector between two boxes in one column, with a head at each end when both ways", () => {
    const box = (t: number) => ({ l: 0, r: 100, t, b: t + 50, cx: 50, cy: t + 25 });
    const e = drawEdge(["a", "b", "x", "both"], box(0), box(100));
    expect(e.d).toBe("M50 50 L50 100");
    expect(e.heads).toHaveLength(2);
    expect(drawEdge(["a", "b", "x"], box(0), { l: 200, r: 300, t: 0, b: 50, cx: 250, cy: 25 }).d).toContain(" C");
    expect(drawEdge(["a", "b", "x", "detour"], box(0), box(100)).rotate).toBe(true);
  });
});
