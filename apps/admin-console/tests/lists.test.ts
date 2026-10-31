import { describe, expect, it } from "vitest";
import { A, B, code, harness, ok, type Harness } from "./helpers";

const as = (role = "ADMIN"): Harness => harness({ "ana@example.com": [[A, role]] });
const AT = "2026-01-02T03:04:05.123456Z";
const lastCall = (h: Harness) => h.bq.dataCalls().at(-1);
const tsRows = (n: number, idKey: string) => Array.from({ length: n }, (_, i) => ({ [idKey]: `id${i}`, cursor_ts: `2026-01-0${n - i}T00:00:00.${String(i).padStart(6, "0")}Z` }));

/** The three lists that are ordered by time share one contract; the two keyed by name (users, rubrics) share another. */
describe.each([
  { method: "review.list", count: "review.count", table: "review_queue", id: "analysis_id", order: "q.completed_at DESC, q.analysis_id ASC", after: "(q.completed_at < @cur_ts OR (q.completed_at = @cur_ts AND q.analysis_id > @cur_id))", role: "VIEWER" },
  { method: "runs.list", count: "runs.count", table: "latest_analysis_runs", id: "run_id", order: "created_at DESC, run_id ASC", after: "(created_at < @cur_ts OR (created_at = @cur_ts AND run_id > @cur_id))", role: "VIEWER" },
  { method: "audit.list", count: "audit.count", table: "audit_log", id: "event_id", order: "occurred_at DESC, event_id ASC", after: "(occurred_at < @cur_ts OR (occurred_at = @cur_ts AND event_id > @cur_id))", role: "ADMIN" },
])("$method (keyset by time)", ({ method, count, table, id, order, after, role }) => {
  it("orders by a total order and never uses OFFSET", () => {
    const h = as(role);
    ok(h.call(method, { tenant: A }));
    const sql = lastCall(h)?.sql ?? "";
    expect(sql).toContain(`ORDER BY ${order}`);
    expect(sql).not.toMatch(/OFFSET/i);
    expect(sql).toContain("FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ'");
    expect(sql).toMatch(table);
  });

  it("continues strictly after the cursor, with the timestamp bound as a parameter", () => {
    const h = as(role);
    ok(h.call(method, { tenant: A, cursor: { at: AT, id: "x1" } }));
    const c = lastCall(h);
    expect(c?.sql).toContain(after);
    expect(c?.params.cur_ts).toEqual({ t: "TIMESTAMP", v: AT });
    expect(c?.params.cur_id).toEqual({ t: "STRING", v: "x1" });
    expect(c?.sql).not.toContain("x1");
  });

  it("reads one extra row to know whether there is a next page, and strips the helper column", () => {
    const h = as(role);
    h.bq.on(new RegExp(table), tsRows(3, id));
    const page = ok(h.call(method, { tenant: A, limit: 2 })) as { rows: Array<Record<string, unknown>>; nextCursor: { at: string; id: string } | null };
    expect(lastCall(h)?.params.limit).toEqual({ t: "INT64", v: 3 });
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]).not.toHaveProperty("cursor_ts");
    expect(page.nextCursor).toEqual({ at: "2026-01-02T00:00:00.000001Z", id: "id1" }); // microseconds kept, built from the LAST row of the page
    h.bq.on(new RegExp(table), tsRows(2, id));
    expect((ok(h.call(method, { tenant: A, limit: 2 })) as { nextCursor: unknown }).nextCursor).toBeNull();
  });

  it("rejects malformed cursors and out-of-range sizes before touching the database", () => {
    const h = as(role);
    for (const cursor of [{ at: "2026-01-02", id: "x" }, { at: AT, id: "" }, { at: AT }, "x", []]) expect(code(h.call(method, { tenant: A, cursor })), JSON.stringify(cursor)).toBe("INVALID_INPUT");
    expect(code(h.call(method, { tenant: A, limit: 0 }))).toBe("INVALID_INPUT");
    expect(code(h.call(method, { tenant: A, limit: 101 }))).toBe("INVALID_INPUT");
    expect(h.bq.dataCalls()).toHaveLength(0);
  });

  it("is scoped to the tenant on the page and on the total, and refused for another tenant", () => {
    const h = as(role);
    ok(h.call(method, { tenant: A }));
    ok(h.call(count, { tenant: A }));
    for (const c of h.bq.dataCalls()) {
      expect(c.sql).toMatch(/organization_id = @org AND workspace_id = @ws/);
      expect(c.params.org).toEqual({ t: "STRING", v: "org-a" });
    }
    expect(code(h.call(method, { tenant: B }))).toBe("FORBIDDEN");
    expect(code(h.call(count, { tenant: B }))).toBe("FORBIDDEN");
  });

  it("counts exactly, defaulting to zero", () => {
    const h = as(role);
    expect(ok(h.call(count, { tenant: A }))).toEqual({ total: 0 });
    h.bq.on(/SELECT COUNT\(\*\) AS total/, [{ total: 4321 }]);
    expect(ok(h.call(count, { tenant: A }))).toEqual({ total: 4321 });
  });
});

describe("who may read each list", () => {
  it("audit and users are administrator-only, including their totals; the rest are open to a Leitor", () => {
    const h = as("VIEWER");
    for (const m of ["audit.list", "audit.count", "users.list", "users.count"]) expect(code(h.call(m, { tenant: A })), m).toBe("FORBIDDEN");
    for (const m of ["review.list", "review.count", "runs.list", "runs.count", "rubrics.list", "rubrics.count", "rubrics.ids"]) expect(code(h.call(m, { tenant: A })), m).toBe("OK");
  });
});

describe("users.list (keyset by e-mail)", () => {
  it("is ordered by e-mail, starts after the cursor and never uses OFFSET", () => {
    const h = as();
    ok(h.call("users.list", { tenant: A, cursor: { key: "Bruno@Example.com" } }));
    const c = lastCall(h);
    expect(c?.sql).toContain("WHERE email > @cur_key ORDER BY email LIMIT @limit");
    expect(c?.sql).not.toMatch(/OFFSET/i);
    expect(c?.sql).toMatch(/QUALIFY ROW_NUMBER\(\) OVER \(PARTITION BY email ORDER BY changed_at DESC\) = 1/); // the latest row per person, then the page
    expect(c?.params.cur_key).toEqual({ t: "STRING", v: "bruno@example.com" });
  });

  it("returns the next cursor from the last e-mail of the page", () => {
    const h = as();
    h.bq.on(/FROM \(SELECT email, role, status, changed_at, changed_by/, [{ email: "a@example.com" }, { email: "b@example.com" }, { email: "c@example.com" }]);
    const page = ok(h.call("users.list", { tenant: A, limit: 2 })) as { rows: unknown[]; nextCursor: { key: string } | null };
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).toEqual({ key: "b@example.com" });
  });

  it("rejects a cursor that is not an e-mail", () => {
    expect(code(as().call("users.list", { tenant: A, cursor: { key: "x'; DROP" } }))).toBe("INVALID_INPUT");
  });

  it("counts the people (latest row each), tenant-scoped", () => {
    const h = as();
    h.bq.on(/SELECT COUNT\(\*\) AS total/, [{ total: 58 }]);
    expect(ok(h.call("users.count", { tenant: A }))).toEqual({ total: 58 });
    expect(lastCall(h)?.sql).toMatch(/QUALIFY ROW_NUMBER\(\)/);
  });
});

describe("rubrics.list (a page of rubrics, each with all its versions)", () => {
  it("first picks the rubric ids of the page by keyset, then reads every version of exactly those", () => {
    const h = as("VIEWER");
    h.bq.on(/SELECT DISTINCT rubric_id FROM/, [{ rubric_id: "a" }, { rubric_id: "b" }, { rubric_id: "c" }]);
    h.bq.on(/rubric_id IN UNNEST/, [{ rubric_id: "a", version: 2 }, { rubric_id: "a", version: 1 }, { rubric_id: "b", version: 1 }]);
    const page = ok(h.call("rubrics.list", { tenant: A, limit: 2, cursor: { key: "0" } })) as { rows: unknown[]; nextCursor: { key: string } | null };
    const [ids, versions] = h.bq.dataCalls();
    expect(ids?.sql).toContain("rubric_id > @cur_key ORDER BY rubric_id LIMIT @limit");
    expect(ids?.params.limit).toEqual({ t: "INT64", v: 3 });
    expect(versions?.params.ids).toEqual({ t: "ARRAY", of: "STRING", v: ["a", "b"] }); // the extra id only decided that there is a next page
    expect(page.rows).toHaveLength(3);
    expect(page.nextCursor).toEqual({ key: "b" });
  });

  it("reads nothing more when the page is empty and has no next page on the last one", () => {
    const h = as("VIEWER");
    expect(ok(h.call("rubrics.list", { tenant: A }))).toEqual({ rows: [], nextCursor: null });
    expect(h.bq.dataCalls()).toHaveLength(1);
    h.bq.on(/SELECT DISTINCT rubric_id FROM/, [{ rubric_id: "a" }]);
    expect((ok(h.call("rubrics.list", { tenant: A, limit: 5 })) as { nextCursor: unknown }).nextCursor).toBeNull();
  });

  it("keeps the tenant predicate on both statements and rejects a malformed cursor", () => {
    const h = as("VIEWER");
    h.bq.on(/SELECT DISTINCT rubric_id FROM/, [{ rubric_id: "a" }]);
    ok(h.call("rubrics.list", { tenant: A }));
    for (const c of h.bq.dataCalls()) expect(c.sql).toMatch(/organization_id = @org AND workspace_id = @ws/);
    expect(code(h.call("rubrics.list", { tenant: A, cursor: { key: "a b" } }))).toBe("INVALID_INPUT");
    expect(code(h.call("rubrics.list", { tenant: A, limit: 101 }))).toBe("INVALID_INPUT");
  });

  it("counts distinct rubrics and lists ids for the filters, both bounded and tenant-scoped", () => {
    const h = as("VIEWER");
    h.bq.on(/COUNT\(DISTINCT rubric_id\)/, [{ total: 14 }]);
    h.bq.on(/SELECT DISTINCT rubric_id FROM .* LIMIT 500/, [{ rubric_id: "a" }, { rubric_id: "b" }]);
    expect(ok(h.call("rubrics.count", { tenant: A }))).toEqual({ total: 14 });
    expect(ok(h.call("rubrics.ids", { tenant: A }))).toEqual(["a", "b"]);
  });
});

describe("review.list filters still work with paging", () => {
  it("applies the situation filter and the cursor together, and counts the same set without the criteria join", () => {
    const h = as("VIEWER");
    ok(h.call("review.list", { tenant: A, filter: "decided", cursor: { at: AT, id: "a9" }, days: 30 }));
    const page = lastCall(h)?.sql ?? "";
    expect(page).toContain("WHERE dec.analysis_id IS NOT NULL AND (q.completed_at < @cur_ts");
    ok(h.call("review.count", { tenant: A, filter: "decided", days: 30 }));
    const count = lastCall(h)?.sql ?? "";
    expect(count).toContain("WHERE dec.analysis_id IS NOT NULL");
    expect(count).not.toContain("cr AS");
    expect(lastCall(h)?.params.days).toEqual({ t: "INT64", v: 30 });
  });
});


describe("pipeline overview (Como funciona)", () => {
  it("is read-only, open to a viewer and scoped to the claimed workspace in every statement", () => {
    const h = harness({ "ana@example.com": [[A, "VIEWER"], [B, "VIEWER"]] });
    h.bq.on(/COUNT\(\*\) AS sessions FROM/, [{ sessions: 24 }]);
    h.bq.on(/GROUP BY analysis_status, approval_status/, [{ analysis_status: "COMPLETED", approval_status: "REJECTED", analyses: 6 }]);
    const data = ok(h.call("pipeline.overview", { tenant: A })) as Record<string, Array<Record<string, unknown>>>;
    expect(Object.keys(data).sort()).toEqual(["cost", "decided", "lastRun", "models", "results", "source"]);
    expect(data.source?.[0]?.sessions).toBe(24);
    const calls = h.bq.dataCalls();
    expect(calls).toHaveLength(6);
    for (const c of calls) {
      expect(c.sql).toMatch(/organization_id = @org AND workspace_id = @ws/);
      expect(c.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
      expect(c.params.org).toEqual({ t: "STRING", v: "org-a" });
      expect(c.params.ws).toEqual({ t: "STRING", v: "ws-a" });
    }
    h.bq.calls.length = 0;
    ok(h.call("pipeline.overview", { tenant: B }));
    expect(h.bq.dataCalls().every((c) => (c.params.org as { v: string }).v === "org-b")).toBe(true);
  });
});

describe("runs: filters (history of executions)", () => {
  const as = (): Harness => harness({ "ana@example.com": [[A, "VIEWER"]] });
  const sqlOf = (h: Harness, re: RegExp) => h.bq.dataCalls().find((c) => re.test(c.sql));

  it("filters by period, status, mode, rubric and run id, all bound as parameters, in the page and in the count", () => {
    const h = as();
    const f = { from: "2026-10-01", to: "2026-10-31", status: "FAILED", mode: "historical", rubric: "sales_quality", query: "hist-abc" };
    ok(h.call("runs.list", { tenant: A, ...f }));
    ok(h.call("runs.count", { tenant: A, ...f }));
    for (const re of [/SELECT run_id, rubric_id/, /SELECT COUNT\(\*\)/]) {
      const c = sqlOf(h, re);
      expect(c?.sql).toMatch(/DATE\(created_at\) BETWEEN @from AND @to/);
      for (const [col, key] of [["run_status", "status"], ["processing_mode", "mode"], ["rubric_id", "rubric"], ["run_id", "query"]]) expect(c?.sql).toContain(`${col} = @${key}`);
      expect(c?.params.status).toEqual({ t: "STRING", v: "FAILED" });
      expect(c?.params.org).toEqual({ t: "STRING", v: "org-a" });
      expect(c?.sql).not.toContain("FAILED"); // values travel as parameters, never inside the text
    }
  });

  it("leaves a filter out when it is empty, and keeps the last-days behaviour when no period is given", () => {
    const h = as();
    ok(h.call("runs.list", { tenant: A, status: "", mode: "" }));
    const c = sqlOf(h, /SELECT run_id, rubric_id/);
    expect(c?.sql).toMatch(/INTERVAL @days DAY/);
    expect(c?.sql).not.toMatch(/run_status = @status|processing_mode = @mode/);
  });

  it.each([
    [{ from: "2026-10-31", to: "2026-10-01" }],
    [{ from: "2024-01-01", to: "2026-10-01" }],
    [{ from: "2026-10-01" }],
    [{ status: "A B" }],
    [{ status: "x'; DROP TABLE runs; --" }],
    [{ query: "a".repeat(200) }],
  ])("rejects an invalid filter %j before reading anything", (bad) => {
    const h = as();
    expect(code(h.call("runs.list", { tenant: A, ...bad }))).toBe("INVALID_INPUT");
    expect(h.bq.dataCalls()).toHaveLength(0);
  });

  it("offers the values that exist in the period for the status, mode and rubric filters", () => {
    const h = as();
    h.bq.on(/SELECT DISTINCT run_status, processing_mode, rubric_id/, [
      { run_status: "COMPLETED", processing_mode: "historical", rubric_id: "sales_quality" },
      { run_status: "FAILED", processing_mode: "live", rubric_id: "after_sales_quality" },
      { run_status: "COMPLETED", processing_mode: "live", rubric_id: null },
    ]);
    expect(ok(h.call("runs.facets", { tenant: A, from: "2026-10-01", to: "2026-10-31" }))).toEqual({
      statuses: ["COMPLETED", "FAILED"], modes: ["historical", "live"], rubrics: ["after_sales_quality", "sales_quality"],
    });
    expect(sqlOf(h, /SELECT DISTINCT run_status/)?.sql).toMatch(/organization_id = @org AND workspace_id = @ws/);
  });
});

describe("runs.get and runs.failures: why a run failed", () => {
  const as = (role = "VIEWER"): Harness => harness({ "ana@example.com": [[A, role]] });
  const RUN = [{ run_id: "hist-1", run_status: "COMPLETED_WITH_FAILURES", sessions_failed: 3, rubric_id: "sales_quality", rubric_version: 5 }];

  it("returns the run with its failures grouped by cause, tenant-scoped, for any role", () => {
    for (const role of ["VIEWER", "EDITOR", "ADMIN"]) {
      const h = as(role);
      h.bq.on(/FROM `[^`]*latest_analysis_runs` WHERE/, RUN);
      h.bq.on(/GROUP BY error_code/, [{ error_code: "PROVIDER_UNAVAILABLE", n: 2 }, { error_code: "PROVIDER_AUTH", n: 1 }]);
      const d = ok(h.call("runs.get", { tenant: A, run_id: "hist-1" })) as { run: { run_id: string }; failures: { available: boolean; total: number; by_code: unknown[] } };
      expect(d.run.run_id).toBe("hist-1");
      expect(d.failures).toMatchObject({ available: true, total: 3 });
      for (const c of h.bq.dataCalls()) {
        expect(c.sql).toMatch(/organization_id = @org AND workspace_id = @ws/);
        expect(c.params.org).toEqual({ t: "STRING", v: "org-a" });
        expect(c.params.run_id).toEqual({ t: "STRING", v: "hist-1" });
      }
    }
  });

  it("says the details are not available instead of failing when the failures table is missing or empty (older runs)", () => {
    const h = as();
    h.bq.on(/FROM `[^`]*latest_analysis_runs` WHERE/, RUN);
    h.bq.on(/GROUP BY error_code/, new Error("Not found: Table run_failures"));
    expect(ok(h.call("runs.get", { tenant: A, run_id: "hist-1" }))).toMatchObject({ failures: { available: false, total: 0, by_code: [] } });
    h.bq.on(/GROUP BY error_code/, []);
    expect(ok(h.call("runs.get", { tenant: A, run_id: "hist-1" }))).toMatchObject({ failures: { available: true, total: 0 } });
  });

  it("is NOT_FOUND for a run of another workspace or one that does not exist, and refuses an invalid id before reading", () => {
    const h = as();
    expect(code(h.call("runs.get", { tenant: A, run_id: "nope" }))).toBe("NOT_FOUND");
    expect(code(h.call("runs.get", { tenant: B, run_id: "hist-1" }))).toBe("FORBIDDEN");
    const bad = as();
    expect(code(bad.call("runs.get", { tenant: A, run_id: "x'; DROP TABLE t; --" }))).toBe("INVALID_INPUT");
    expect(code(bad.call("runs.failures", { tenant: A }))).toBe("INVALID_INPUT");
    expect(bad.bq.dataCalls()).toHaveLength(0);
  });

  it("pages the failed sessions newest first with the shared keyset cursor", () => {
    const h = as();
    h.bq.on(/FROM `[^`]*run_failures` WHERE/, tsRows(3, "failure_id"));
    const page = ok(h.call("runs.failures", { tenant: A, run_id: "hist-1", limit: 2 })) as { rows: unknown[]; nextCursor: unknown };
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const c = lastCall(h);
    expect(c?.sql).toMatch(/ORDER BY occurred_at DESC, failure_id ASC LIMIT @limit/);
    expect(c?.sql).toMatch(/DATE\(occurred_at\) >= DATE_SUB\(CURRENT_DATE\(\), INTERVAL 365 DAY\)/);
    expect(c?.params.limit).toEqual({ t: "INT64", v: 3 });
  });

  it("never selects message text, only the safe columns", () => {
    const h = as();
    ok(h.call("runs.failures", { tenant: A, run_id: "hist-1" }));
    const sql = lastCall(h)?.sql ?? "";
    for (const col of ["failure_id", "session_id", "stage", "error_code", "error_type", "http_status", "provider_code", "occurred_at"]) expect(sql).toContain(col);
    expect(sql).not.toMatch(/content|message|detail/i);
  });
});
