import { describe, expect, it } from "vitest";
import { execResult, execSummary, failureText, schedWhen, utcTime, FAILURE_CODES } from "../../src/ui/lib/executions";
import { reviewReason } from "../../src/ui/views/ReviewView";

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
  it("says why an analysis is in the review queue", () => {
    expect(reviewReason({ insufficient: 2, criteria: 6 })).toBe("Evidência insuficiente em 2 de 6 critérios");
    expect(reviewReason({ insufficient: 1, criteria: 1 })).toBe("Evidência insuficiente em 1 de 1 critério");
    expect(reviewReason({ insufficient: 0, criteria: 0 })).toContain("conversa curta demais");
    expect(reviewReason({ insufficient: 0, criteria: 4 })).toContain("Decisão incerta");
  });
});
