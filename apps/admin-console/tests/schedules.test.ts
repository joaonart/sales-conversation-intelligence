import { describe, expect, it } from "vitest";
import { nextRun } from "../src/server/services/schedules";
import { A, B, code, harness, ok, type Harness } from "./helpers";

const ESTIMATE = [{ sessions: 12, with_messages: 10, already: 2, tokens: 8000 }];
const BODY = { name: "Diária de vendas", frequency: "DAILY", hour_utc: 2, minute_utc: 0, window_days: 7, max_sessions: 200, rubric_id: "sales_quality", rubric_version: 5, max_cost_usd: 0.5, only_routed: false };

function as(role: string): Harness {
  const h = harness({ "ana@example.com": [[A, role]] });
  h.bq.on(/WITH s AS/, ESTIMATE);
  h.bq.on(/FROM `[^`]*evaluation_rubrics` WHERE/, [{ status: "PUBLISHED" }]);
  return h;
}
const create = (h: Harness, over: Record<string, unknown> = {}, tenant = A): ReturnType<Harness["call"]> => h.call("schedules.create", { tenant, ...BODY, confirm: true, ...over });
const inserts = (h: Harness) => h.bq.calls.filter((c) => /INSERT INTO `[^`]*run_schedules`/.test(c.sql));

describe("schedules: only ADMIN", () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ["schedules.list", {}],
    ["schedules.create", { ...BODY, confirm: true }],
    ["schedules.setStatus", { schedule_id: "s1", action: "pause" }],
  ];

  it.each(["VIEWER", "EDITOR"])("refuses a %s on every method before anything is read or written", (role) => {
    for (const [method, payload] of calls) {
      const h = as(role);
      expect(code(h.call(method, { tenant: A, ...payload })), method).toBe("FORBIDDEN");
      expect(h.bq.dataCalls(), method).toHaveLength(0);
    }
  });

  it("is refused for a workspace the admin does not belong to, and every statement is scoped to the tenant", () => {
    const h = as("ADMIN");
    expect(code(create(h, {}, B))).toBe("FORBIDDEN");
    expect(h.bq.dataCalls()).toHaveLength(0);
    h.bq.on(/SELECT status FROM `[^`]*run_schedules`/, [{ status: "ACTIVE" }]);
    ok(create(h));
    ok(h.call("schedules.list", { tenant: A }));
    ok(h.call("schedules.setStatus", { tenant: A, schedule_id: "s1", action: "pause" }));
    for (const c of h.bq.dataCalls()) {
      if (!/^INSERT INTO [^S]*VALUES/.test(c.sql)) expect(c.sql, c.sql).toMatch(/organization_id = @org AND workspace_id = @ws/);
      expect(c.params.org).toEqual({ t: "STRING", v: "org-a" });
      expect(c.params.ws).toEqual({ t: "STRING", v: "ws-a" });
    }
  });
});

describe("schedules.create: a standing authorization to spend", () => {
  it("records who created it from the Google session (never from the body), the ceiling and the normalised settings, and returns the next run", () => {
    const h = as("ADMIN");
    const r = ok(create(h, { created_by: "boss@example.com", requested_by: "boss@example.com" })) as { schedule_id: string; status: string; next_run: string };
    expect(r.status).toBe("ACTIVE");
    expect(Date.parse(r.next_run)).toBeGreaterThan(Date.now());
    const [ins] = inserts(h);
    expect(ins?.params.by).toEqual({ t: "STRING", v: "ana@example.com" });
    expect(JSON.stringify(ins?.params)).not.toContain("boss@");
    expect(ins?.params).toMatchObject({ frequency: { v: "DAILY" }, hour: { v: 2 }, minute: { v: 0 }, weekday: { v: null }, win: { v: 7 }, max: { v: 200 }, cap: { t: "FLOAT64", v: 0.5 },
      rid: { v: "sales_quality" }, ver: { v: 5 }, provider: { v: "decisions" }, model: { v: "gpt-6-luna" }, routed: { t: "BOOL", v: false } });
    expect(ins?.sql).toMatch(/'ACTIVE'/);
  });

  it("needs an explicit confirmation of the ceiling per run", () => {
    const h = as("ADMIN");
    expect(code(h.call("schedules.create", { tenant: A, ...BODY }))).toBe("INVALID_INPUT");
    expect(code(h.call("schedules.create", { tenant: A, ...BODY, confirm: "yes" }))).toBe("INVALID_INPUT");
    expect(inserts(h)).toHaveLength(0);
  });

  it.each([
    { name: "" }, { name: "x".repeat(81) }, { frequency: "HOURLY" }, { hour_utc: 24 }, { minute_utc: 60 }, { window_days: 0 }, { window_days: 400 }, { max_sessions: 0 },
    { max_sessions: 5000 }, { max_cost_usd: 0 }, { max_cost_usd: 99 }, { frequency: "WEEKLY" }, { frequency: "WEEKLY", weekday: 7 }, { rubric_id: "x'; DROP TABLE t; --" },
    { model: "gpt-9" }, { provider: "responses", model: "gpt-6-luna" },
  ])("refuses %j before anything is written", (over) => {
    const h = as("ADMIN");
    expect(code(create(h, over))).toBe("INVALID_INPUT");
    expect(inserts(h)).toHaveLength(0);
  });

  it("accepts a weekly schedule with its weekday and no weekday for a daily one", () => {
    const h = as("ADMIN");
    ok(create(h, { frequency: "WEEKLY", weekday: 2, name: "Semanal" }));
    expect(inserts(h)[0]?.params.weekday).toEqual({ t: "INT64", v: 2 });
    const d = as("ADMIN");
    ok(create(d, { weekday: 3 }));
    expect(inserts(d)[0]?.params.weekday).toEqual({ t: "INT64", v: null });
  });

  it("only a published rubric of this workspace can be scheduled", () => {
    const h = as("ADMIN");
    h.bq.on(/FROM `[^`]*evaluation_rubrics` WHERE/, [{ status: "DRAFT" }]);
    expect(code(create(h))).toBe("INVALID_INPUT");
    h.bq.on(/FROM `[^`]*evaluation_rubrics` WHERE/, []);
    expect(code(create(h))).toBe("NOT_FOUND");
    expect(inserts(h)).toHaveLength(0);
  });

  it("refuses a ceiling below the estimate of a run over today's window", () => {
    const h = as("ADMIN");
    expect(code(create(h, { max_cost_usd: 0.000001 }))).toBe("INVALID_INPUT");
    expect(inserts(h)).toHaveLength(0);
  });

  it("is limited to ten schedules per workspace and to one name", () => {
    const h = as("ADMIN");
    h.bq.on(/AND status != 'ARCHIVED'/, Array.from({ length: 10 }, (_, k) => ({ name: `Agenda ${k}` })));
    expect(code(create(h))).toBe("CONFLICT");
    h.bq.on(/AND status != 'ARCHIVED'/, [{ name: "diária de VENDAS" }]);
    expect(code(create(h))).toBe("CONFLICT");
    expect(inserts(h)).toHaveLength(0);
  });
});

describe("schedules.setStatus: pause, resume, archive", () => {
  const status = (h: Harness, s: string): void => void h.bq.on(/SELECT status FROM `[^`]*run_schedules`/, [{ status: s }]);

  it.each([["pause", "ACTIVE", "PAUSED"], ["resume", "PAUSED", "ACTIVE"], ["archive", "ACTIVE", "ARCHIVED"], ["archive", "PAUSED", "ARCHIVED"]])("%s: %s -> %s as a new row of the actor", (action, from, to) => {
    const h = as("ADMIN");
    status(h, from);
    expect(ok(h.call("schedules.setStatus", { tenant: A, schedule_id: "s1", action }))).toEqual({ schedule_id: "s1", status: to });
    const [ins] = inserts(h);
    expect(ins?.params.to).toEqual({ t: "STRING", v: to });
    expect(ins?.params.by).toEqual({ t: "STRING", v: "ana@example.com" });
    expect(ins?.sql).toMatch(/CURRENT_TIMESTAMP\(\)/); // the change time moves, so the change counts from the next slot (see the executor)
  });

  it.each([["pause", "PAUSED"], ["pause", "ARCHIVED"], ["resume", "ACTIVE"], ["resume", "ARCHIVED"], ["archive", "ARCHIVED"]])("cannot %s a schedule that is %s", (action, from) => {
    const h = as("ADMIN");
    status(h, from);
    expect(code(h.call("schedules.setStatus", { tenant: A, schedule_id: "s1", action }))).toBe("CONFLICT");
    expect(inserts(h)).toHaveLength(0);
  });

  it("is NOT_FOUND for a schedule of another workspace, and refuses an unknown action or an invalid id before reading", () => {
    const h = as("ADMIN");
    expect(code(h.call("schedules.setStatus", { tenant: A, schedule_id: "nope", action: "pause" }))).toBe("NOT_FOUND");
    const bad = as("ADMIN");
    expect(code(bad.call("schedules.setStatus", { tenant: A, schedule_id: "s1", action: "delete" }))).toBe("INVALID_INPUT");
    expect(code(bad.call("schedules.setStatus", { tenant: A, schedule_id: "x'; --", action: "pause" }))).toBe("INVALID_INPUT");
    expect(bad.bq.dataCalls()).toHaveLength(0);
  });
});

describe("schedules.list", () => {
  const ROW = { schedule_id: "s1", name: "Diária", status: "ACTIVE", frequency: "DAILY", hour_utc: 2, minute_utc: 0, weekday: null, rubric_id: "sales_quality", rubric_version: 5 };

  it("shows the latest version of each schedule with its next run, and none for a paused one", () => {
    const h = as("ADMIN");
    h.bq.on(/FROM `[^`]*run_schedules`/, [ROW, { ...ROW, schedule_id: "s2", status: "PAUSED" }]);
    const { rows } = ok(h.call("schedules.list", { tenant: A })) as { rows: Array<{ schedule_id: string; next_run: string | null }> };
    expect(Date.parse(String(rows[0]?.next_run))).toBeGreaterThan(Date.now());
    expect(rows[1]?.next_run).toBeNull();
    const c = h.bq.dataCalls().at(-1)!;
    expect(c.params.statuses).toEqual({ t: "ARRAY", of: "STRING", v: ["ACTIVE", "PAUSED"] }); // archived ones only on request
    expect(c.sql).toMatch(/QUALIFY ROW_NUMBER\(\) OVER \(PARTITION BY schedule_id ORDER BY changed_at DESC\) = 1/);
    expect(c.sql).toMatch(/JSON_VALUE\(params, '\$\.schedule_id'\)/); // the last request each schedule made
    ok(h.call("schedules.list", { tenant: A, include_archived: true }));
    expect(h.bq.dataCalls().at(-1)!.params.statuses).toEqual({ t: "ARRAY", of: "STRING", v: ["ACTIVE", "PAUSED", "ARCHIVED"] });
  });
});

describe("nextRun", () => {
  const at = (iso: string): Date => new Date(iso);
  it("daily: later today if the time has not passed, else tomorrow", () => {
    expect(nextRun("DAILY", 2, 0, null, at("2026-11-02T01:00:00Z")).toISOString()).toBe("2026-11-02T02:00:00.000Z");
    expect(nextRun("DAILY", 2, 0, null, at("2026-11-02T02:00:00Z")).toISOString()).toBe("2026-11-03T02:00:00.000Z"); // strictly after
    expect(nextRun("DAILY", 2, 30, null, at("2026-11-30T23:59:00Z")).toISOString()).toBe("2026-12-01T02:30:00.000Z"); // month change
  });
  it("weekly: the next weekday (0 = Monday), including the same day when still ahead", () => {
    expect(nextRun("WEEKLY", 4, 30, 2, at("2026-11-02T10:00:00Z")).toISOString()).toBe("2026-11-04T04:30:00.000Z"); // Monday -> Wednesday
    expect(nextRun("WEEKLY", 4, 30, 2, at("2026-11-04T04:00:00Z")).toISOString()).toBe("2026-11-04T04:30:00.000Z");
    expect(nextRun("WEEKLY", 4, 30, 2, at("2026-11-04T05:00:00Z")).toISOString()).toBe("2026-11-11T04:30:00.000Z");
    expect(nextRun("WEEKLY", 0, 0, 6, at("2026-11-01T12:00:00Z")).toISOString()).toBe("2026-11-08T00:00:00.000Z"); // Sunday 12:00 -> next Sunday
  });
});
