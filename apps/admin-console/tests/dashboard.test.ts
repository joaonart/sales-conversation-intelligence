import { describe, expect, it } from "vitest";
import { A, harness, ok } from "./helpers";

const as = (role: "VIEWER" | "EDITOR" | "ADMIN") => harness({ "ana@example.com": [[A, role]] });
const code = (r: { ok: boolean; error?: { code: string } }): string => (r.ok ? "OK" : (r.error?.code ?? "?"));

describe("dashboard.score: average score by day, week, month, quarter or year", () => {
  const call = (h: ReturnType<typeof as>, payload: Record<string, unknown>) => h.call("dashboard.score", { tenant: A, ...payload });

  it("is readable by a VIEWER and refuses a granularity that is not in the list", () => {
    expect(code(call(as("VIEWER"), { granularity: "month" }))).toBe("OK");
    for (const bad of ["hour", "DAY", "month; DROP TABLE x", "", 3, null]) expect(code(call(as("VIEWER"), { granularity: bad })), String(bad)).toBe("INVALID_INPUT");
    expect(code(call(as("VIEWER"), {}))).toBe("OK"); // no choice: by day
  });

  it.each([
    ["day", /SELECT day AS bucket/, /INTERVAL @days DAY/],
    ["week", /DATE_TRUNC\(day, WEEK\(MONDAY\)\) AS bucket/, /INTERVAL 25 WEEK/],
    ["month", /DATE_TRUNC\(day, MONTH\) AS bucket/, /INTERVAL 23 MONTH/],
    ["quarter", /DATE_TRUNC\(day, QUARTER\) AS bucket/, /INTERVAL 33 MONTH/],
    ["year", /DATE_TRUNC\(day, YEAR\) AS bucket/, /INTERVAL 4 YEAR/],
  ])("buckets by %s with a fixed window, the tenant filter and a weighted average", (granularity, bucket, window) => {
    const h = as("VIEWER");
    ok(call(h, { granularity }));
    const q = h.bq.dataCalls()[0];
    expect(q?.sql).toMatch(bucket);
    expect(q?.sql).toMatch(window);
    expect(q?.sql).toMatch(/organization_id = @org AND workspace_id = @ws/);
    expect(q?.sql).toContain("SAFE_DIVIDE(SUM(avg_score * scored_sessions), SUM(scored_sessions))"); // weighted by scored sessions, not an average of averages
    expect(q?.sql).toMatch(/GROUP BY bucket ORDER BY bucket/);
    expect(q?.params.org).toEqual({ t: "STRING", v: "org-a" });
  });

  it("never puts what the caller sent into the SQL text; only the period of the day view is a parameter", () => {
    const h = as("VIEWER");
    ok(call(h, { granularity: "week", days: 7, bucket: "1); DROP TABLE x; --" }));
    ok(call(h, { granularity: "day", days: 90 }));
    const [week, day] = h.bq.dataCalls();
    expect(week?.sql).not.toMatch(/DROP|@days/);
    expect(day?.params.days).toEqual({ t: "INT64", v: 90 });
    expect(code(call(h, { granularity: "day", days: 400 }))).toBe("INVALID_INPUT");
  });

  it("is per workspace: another workspace is forbidden and nothing is queried", () => {
    const h = as("VIEWER");
    expect(code(h.call("dashboard.score", { tenant: { organization_id: "org-b", workspace_id: "ws-b" }, granularity: "year" }))).toBe("FORBIDDEN");
    expect(h.bq.dataCalls()).toHaveLength(0);
  });
});

describe("dashboard.summary: spend and outcome per model", () => {
  it("reads the raw analyses (not the latest view, which keeps one analysis per content) for the same period and tenant as the cost", () => {
    const h = as("VIEWER");
    ok(h.call("dashboard.summary", { tenant: A, days: 90 }));
    const q = h.bq.dataCalls().find((c) => /GROUP BY model/.test(c.sql) && /COUNT\(DISTINCT IF\(analysis_status/.test(c.sql));
    expect(q?.sql).toMatch(/FROM `[^`]*session_analyses` WHERE organization_id = @org AND workspace_id = @ws AND DATE\(started_at\) >= DATE_SUB\(CURRENT_DATE\(\), INTERVAL @days DAY\)/);
    expect(q?.sql).not.toMatch(/latest_session_analyses/);
    expect(q?.params.days).toEqual({ t: "INT64", v: 90 });
  });

  it("adds the API of each model from the catalog, and null for a model that is not in it", () => {
    const h = as("VIEWER");
    h.bq.on(/GROUP BY model/, [
      { model: "gpt-6-luna", analyses: 2, cost_usd: 0.0004, completed: 2 },
      { model: "gpt-4o", analyses: 28, cost_usd: 0.15, completed: 23 },
      { model: "gpt-3.5-turbo", analyses: 1, cost_usd: 0.001, completed: 1 },
      { model: null, analyses: 1, cost_usd: 0, completed: 0 },
    ]);
    const d = ok(h.call("dashboard.summary", { tenant: A })) as { models: Array<{ model: string | null; provider: string | null }> };
    expect(d.models.map((m) => `${m.model}:${m.provider}`)).toEqual(["gpt-6-luna:decisions", "gpt-4o:responses", "gpt-3.5-turbo:null", "null:null"]);
  });
});

describe("dashboard.summary: coverage of the workspace", () => {
  it("counts the sessions analysed in the period by the day of the analysis (distinct sessions) against all the sessions of the last 365 days, for this tenant only", () => {
    const h = as("VIEWER");
    h.bq.on(/COUNT\(DISTINCT r\.session_id\)/, [{ sessions: 29, analysed: 15 }]);
    const d = ok(h.call("dashboard.summary", { tenant: A, days: 7 })) as { coverage: Array<{ sessions: number; analysed: number }> };
    expect(d.coverage).toEqual([{ sessions: 29, analysed: 15 }]);
    const q = h.bq.dataCalls().find((c) => /COUNT\(DISTINCT r\.session_id\)/.test(c.sql));
    expect(q?.sql).toMatch(/DATE\(r\.completed_at\) >= DATE_SUB\(CURRENT_DATE\(\), INTERVAL @days DAY\)/); // the period follows the analysis, like the other figures
    expect(q?.sql).toMatch(/DATE\(started_at\) >= DATE_SUB\(CURRENT_DATE\(\), INTERVAL 365 DAY\)/);
    expect(q?.sql).toMatch(/DATE\(s\.started_at\) >= DATE_SUB\(CURRENT_DATE\(\), INTERVAL 365 DAY\)/); // only sessions inside the total are counted as analysed
    expect(q?.sql).toMatch(/r\.organization_id = @org AND r\.workspace_id = @ws/);
    expect(q?.sql).toMatch(/s\.organization_id = @org AND s\.workspace_id = @ws/);
    expect(q?.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    expect(q?.params.days).toEqual({ t: "INT64", v: 7 });
  });

  it('the Sessões list still accepts the "has an analysis" status, and does not bind it as a status value', () => {
    const h = as("VIEWER");
    ok(h.call("sessions.list", { tenant: A, from: "2026-01-01", to: "2026-01-31", status: "ANALYSED" }));
    const q = h.bq.dataCalls().find((c) => /FROM `[^`]*sessions` s LEFT JOIN/.test(c.sql));
    expect(q?.sql).toContain("AND r.analysis_id IS NOT NULL");
    expect(q?.sql).not.toContain("r.analysis_status = @status");
    expect(q?.params.status).toBeUndefined();
    expect(code(h.call("sessions.list", { tenant: A, from: "2026-01-01", to: "2026-01-31", status: "ANALYSED_ALL" }))).toBe("INVALID_INPUT");
  });
});
