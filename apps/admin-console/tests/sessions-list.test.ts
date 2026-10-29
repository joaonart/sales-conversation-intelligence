import { describe, expect, it } from "vitest";
import { A, B, code, harness, ok, type Harness } from "./helpers";

const RANGE = { from: "2026-01-01", to: "2026-01-31" };
const listSql = (h: Harness) => h.bq.dataCalls().find((c) => /FROM `[^`]*sessions` s/.test(c.sql) && /ORDER BY/.test(c.sql));
const as = (role = "VIEWER"): Harness => harness({ "ana@example.com": [[A, role]] });

describe("sessions.list filters", () => {
  it.each([
    ["channel", "whatsapp", /AND s\.channel = @channel/, "channel"],
    ["result", "REJECTED", /AND r\.approval_status = @result/, "result"],
    ["rubric", "sales_quality", /AND r\.rubric_id = @rubric/, "rubric"],
  ])("filters by %s with a bound parameter, never by text in the SQL", (field, value, pattern, param) => {
    const h = as();
    ok(h.call("sessions.list", { tenant: A, ...RANGE, [field]: value }));
    const c = listSql(h);
    expect(c?.sql).toMatch(pattern);
    expect(c?.params[param]).toEqual({ t: "STRING", v: value });
    expect(c?.sql).not.toContain(value);
  });

  it("combines every filter and keeps the tenant predicate", () => {
    const h = as();
    ok(h.call("sessions.list", { tenant: A, ...RANGE, status: "COMPLETED", channel: "webchat", result: "APPROVED", rubric: "sales_quality", query: "s1" }));
    const c = listSql(h);
    for (const frag of ["r.analysis_status = @status", "s.channel = @channel", "r.approval_status = @result", "r.rubric_id = @rubric", "s.session_id = @q", "s.organization_id = @org AND s.workspace_id = @ws"]) {
      expect(c?.sql, frag).toContain(frag);
    }
  });

  it("an empty filter means no filter", () => {
    const h = as();
    ok(h.call("sessions.list", { tenant: A, ...RANGE, channel: "", result: "", rubric: "" }));
    expect(listSql(h)?.sql).not.toMatch(/@channel|@result|@rubric/);
  });

  it("rejects unknown results and malformed channel or rubric values", () => {
    const h = as();
    expect(code(h.call("sessions.list", { tenant: A, ...RANGE, result: "MAYBE" }))).toBe("INVALID_INPUT");
    expect(code(h.call("sessions.list", { tenant: A, ...RANGE, channel: "x' OR 1=1 --" }))).toBe("INVALID_INPUT");
    expect(code(h.call("sessions.list", { tenant: A, ...RANGE, rubric: "a b" }))).toBe("INVALID_INPUT");
    expect(h.bq.dataCalls()).toHaveLength(0);
  });
});

describe("sessions.list pagination", () => {
  it("uses a keyset cursor on a total order and never OFFSET", () => {
    const h = as();
    ok(h.call("sessions.list", { tenant: A, ...RANGE, cursor: { started_at: "2026-01-02T03:04:05.123456Z", session_id: "s1" } }));
    const c = listSql(h);
    expect(c?.sql).toContain("ORDER BY s.started_at DESC, s.session_id ASC");
    expect(c?.sql).toContain("(s.started_at < @cur_ts OR (s.started_at = @cur_ts AND s.session_id > @cur_sid))");
    expect(c?.sql).not.toMatch(/OFFSET/i);
    expect(c?.params.cur_ts).toEqual({ t: "TIMESTAMP", v: "2026-01-02T03:04:05.123456Z" });
  });

  it("returns the cursor with microseconds from the database, formatted by BigQuery itself", () => {
    const h = as();
    ok(h.call("sessions.list", { tenant: A, ...RANGE }));
    expect(listSql(h)?.sql).toContain("FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', s.started_at) AS cursor_ts");
  });

  it("reads one extra row to know whether there is a next page, and has none on the last page", () => {
    const h = as();
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ session_id: `s${i}`, started_at: "2026-01-02T00:00:00.000Z", cursor_ts: "2026-01-02T00:00:00.000000Z" }));
    h.bq.on(/FROM `[^`]*sessions` s/, rows(25));
    expect((ok(h.call("sessions.list", { tenant: A, ...RANGE, limit: 25 })) as { nextCursor: unknown }).nextCursor).toBeNull();
    h.bq.on(/FROM `[^`]*sessions` s/, rows(26));
    expect((ok(h.call("sessions.list", { tenant: A, ...RANGE, limit: 25 })) as { nextCursor: unknown }).nextCursor).not.toBeNull();
  });

  it("rejects malformed cursors", () => {
    const h = as();
    for (const cursor of [{ started_at: "2026-01-02", session_id: "s1" }, { started_at: "2026-01-02T00:00:00Z", session_id: "x y" }, "s1", []]) {
      expect(code(h.call("sessions.list", { tenant: A, ...RANGE, cursor })), JSON.stringify(cursor)).toBe("INVALID_INPUT");
    }
  });
});

describe("sessions.count", () => {
  it("counts exactly the rows the list would page through (same filters, same join)", () => {
    const h = as();
    h.bq.on(/SELECT COUNT\(\*\) AS total/, [{ total: 1234 }]);
    const filters = { ...RANGE, status: "COMPLETED", channel: "webchat", result: "APPROVED", rubric: "sales_quality" };
    expect(ok(h.call("sessions.count", { tenant: A, ...filters }))).toEqual({ total: 1234 });
    ok(h.call("sessions.list", { tenant: A, ...filters }));
    const where = (sql: string) => sql.slice(sql.indexOf("WHERE"), /ORDER BY/.test(sql) ? sql.indexOf("ORDER BY") : undefined).trim();
    const [count, list] = [h.bq.dataCalls().find((c) => /COUNT\(\*\)/.test(c.sql)), listSql(h)];
    expect(where(count?.sql ?? "")).toBe(where(list?.sql ?? ""));
    expect(count?.sql).toMatch(/FROM `[^`]*sessions` s LEFT JOIN `[^`]*current_session_results` r ON r\.organization_id = @org/);
  });

  it("is tenant-scoped and refused for another tenant", () => {
    const h = as();
    expect(code(h.call("sessions.count", { tenant: B, ...RANGE }))).toBe("FORBIDDEN");
    ok(h.call("sessions.count", { tenant: A, ...RANGE }));
    expect(h.bq.dataCalls()[0]?.params.org).toEqual({ t: "STRING", v: "org-a" });
  });

  it("returns zero when the database returns no row", () => {
    expect(ok(as().call("sessions.count", { tenant: A, ...RANGE }))).toEqual({ total: 0 });
  });
});

describe("sessions.channels", () => {
  it("lists the distinct channels of the period for the filter, tenant-scoped and bounded", () => {
    const h = as();
    h.bq.on(/SELECT DISTINCT channel/, [{ channel: "webchat" }, { channel: "whatsapp" }]);
    expect(ok(h.call("sessions.channels", { tenant: A, ...RANGE }))).toEqual(["webchat", "whatsapp"]);
    const c = h.bq.dataCalls()[0];
    expect(c?.sql).toMatch(/organization_id = @org AND workspace_id = @ws AND DATE\(started_at\) BETWEEN @from AND @to/);
    expect(c?.sql).toContain("LIMIT 100");
    expect(code(h.call("sessions.channels", { tenant: A, from: "2026-02-01", to: "2026-01-01" }))).toBe("INVALID_INPUT");
  });
});
