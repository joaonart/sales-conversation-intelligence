import { describe, expect, it } from "vitest";
import { SCHEDULE_DEFAULTS, execResult, execSummary, failureText, filterSchedules, needsArchived, originText, scheduleFiltersDirty, scheduleIdOf, schedWhen, utcTime, FAILURE_CODES } from "../../src/ui/lib/executions";
import { reviewReason } from "../../src/ui/views/ReviewView";
import type { ScheduleRow } from "../../src/ui/lib/types";

describe("executions lib", () => {
  it("summarises the parameters of a request on one line", () => {
    const params = JSON.stringify({ schedule_id: "s", start: "2026-01-01", end: "2026-01-31", rubric_id: "q", rubric_version: 2, only_routed: true, max_sessions: 50, model: "m", provider: "responses" });
    expect(execSummary({ params })).toBe("agendada · 2026-01-01 a 2026-01-31 · q v2 · somente roteadas · até 50 sessões · m (Responses)");
    expect(execSummary({ params: null })).toBe("—");
    expect(execSummary({ params: "not json" })).toBe("—");
  });
  it("shows a failed request's error, a finished one's counts and nothing for the rest", () => {
    expect(execResult({ status: "FAILED", error: "BUDGET", result: null })).toBe("BUDGET");
    expect(execResult({ status: "FAILED", error: null, result: null })).toBe("Falhou");
    expect(execResult({ status: "COMPLETED", error: null, result: JSON.stringify({ processed: 3, failed: 1, spent_usd: 0.5 }) })).toContain("3 ok · 1 falhas");
    expect(execResult({ status: "REQUESTED", error: null, result: null })).toBe("—");
  });
  it("tells the time of a UTC schedule in both clocks", () => {
    expect(utcTime(2, 5)).toMatch(/^02:05 UTC \(\d\d:\d\d no seu horário\)$/);
    expect(schedWhen({ frequency: "WEEKLY", weekday: 0, hour_utc: 2, minute_utc: 0 })).toMatch(/^Toda segunda-feira, 02:00 UTC/);
    expect(schedWhen({ frequency: "DAILY", weekday: null, hour_utc: 2, minute_utc: 0 })).toMatch(/^Todo dia, 02:00 UTC/);
  });
  it("a failure cause that is not known is shown as it came", () => {
    expect(failureText("PROVIDER_QUOTA")).toBe(FAILURE_CODES.PROVIDER_QUOTA![0]);
    expect(failureText("NEW_CODE")).toBe("NEW_CODE");
  });
  it("says where a request came from: manual, or the schedule that made it (by name when it is still known)", () => {
    const names = new Map([["s1", "Vendas, todo dia"]]);
    expect(scheduleIdOf({ params: JSON.stringify({ schedule_id: "s1" }) })).toBe("s1");
    expect(scheduleIdOf({ params: JSON.stringify({ kind: "ANALYSIS" }) })).toBeNull();
    expect(scheduleIdOf({ params: "not json" })).toBeNull();
    expect(originText({ params: null }, names)).toBe("Manual");
    expect(originText({ params: JSON.stringify({ schedule_id: "s1" }) }, names)).toBe("Agenda: Vendas, todo dia");
    expect(originText({ params: JSON.stringify({ schedule_id: "gone" }) }, names)).toBe("Agenda: (removida)");
  });
  it("says why an analysis is in the review queue", () => {
    expect(reviewReason({ insufficient: 2, criteria: 6 })).toBe("Evidência insuficiente em 2 de 6 critérios");
    expect(reviewReason({ insufficient: 1, criteria: 1 })).toBe("Evidência insuficiente em 1 de 1 critério");
    expect(reviewReason({ insufficient: 0, criteria: 0 })).toContain("conversa curta demais");
    expect(reviewReason({ insufficient: 0, criteria: 4 })).toContain("Decisão incerta");
  });
});

describe("filters of the schedules", () => {
  const row = (o: Partial<ScheduleRow>): ScheduleRow => ({ schedule_id: "s", name: "Vendas", status: "ACTIVE", frequency: "DAILY", weekday: null, hour_utc: 2, minute_utc: 0, rubric_id: "q", rubric_version: 1, window_days: 7, max_sessions: 100, only_routed: false, provider: "decisions", model: "m", max_cost_usd: 0.1, next_run: null, last_request_id: null, last_status: null, last_requested_at: null, ...o });
  const rows = [
    row({ schedule_id: "a", name: "Vendas, todo dia" }),
    row({ schedule_id: "b", name: "Pós-venda semanal", status: "PAUSED", frequency: "WEEKLY", weekday: 0, rubric_id: "after", last_request_id: "r1", last_status: "FAILED" }),
    row({ schedule_id: "c", name: "Antiga", status: "ARCHIVED", last_request_id: "r2", last_status: "COMPLETED" }),
  ];
  const ids = (f: Partial<typeof SCHEDULE_DEFAULTS>) => filterSchedules(rows, { ...SCHEDULE_DEFAULTS, ...f }).map((r) => r.schedule_id);
  it("by default shows the active and the paused, never the archived", () => expect(ids({})).toEqual(["a", "b"]));
  it("filters by name (any case), status, rubric, frequency and the last run", () => {
    expect(ids({ query: "  PÓS" })).toEqual(["b"]);
    expect(ids({ status: "PAUSED" })).toEqual(["b"]);
    expect(ids({ status: "ARCHIVED" })).toEqual(["c"]);
    expect(ids({ status: "ALL" })).toEqual(["a", "b", "c"]);
    expect(ids({ rubric: "after" })).toEqual(["b"]);
    expect(ids({ frequency: "DAILY" })).toEqual(["a"]);
    expect(ids({ last: "NEVER" })).toEqual(["a"]);
    expect(ids({ last: "FAILED" })).toEqual(["b"]);
  });
  it("combines the filters, and knows when something differs from the defaults and when the archived must be fetched", () => {
    expect(ids({ frequency: "WEEKLY", last: "NEVER" })).toEqual([]);
    expect(scheduleFiltersDirty(SCHEDULE_DEFAULTS)).toBe(false);
    expect(scheduleFiltersDirty({ ...SCHEDULE_DEFAULTS, rubric: "q" })).toBe(true);
    expect([needsArchived(SCHEDULE_DEFAULTS), needsArchived({ ...SCHEDULE_DEFAULTS, status: "PAUSED" }), needsArchived({ ...SCHEDULE_DEFAULTS, status: "ARCHIVED" }), needsArchived({ ...SCHEDULE_DEFAULTS, status: "ALL" })]).toEqual([false, false, true, true]);
  });
});
