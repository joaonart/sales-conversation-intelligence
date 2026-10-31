import { describe, expect, it } from "vitest";
import { A, B, code, harness, ok, type Harness } from "./helpers";

const ESTIMATE = [{ sessions: 12, with_messages: 10, already: 2, tokens: 8000 }];
const WINDOW = { start: "2026-01-01", end: "2026-01-31", max_sessions: 50, max_cost_usd: 0.5 };

function as(role: string): Harness {
  const h = harness({ "ana@example.com": [[A, role]] });
  h.bq.on(/WITH s AS/, ESTIMATE);
  h.bq.on(/FROM `[^`]*evaluation_rubrics` WHERE/, [{ status: "PUBLISHED" }]);
  return h;
}
const req = (h: Harness, over: Record<string, unknown> = {}, tenant = A): ReturnType<Harness["call"]> =>
  h.call("executions.request", { tenant, kind: "ROUTING", ...WINDOW, confirm: true, ...over });
const inserts = (h: Harness) => h.bq.calls.filter((c) => /INSERT INTO `[^`]*run_requests`/.test(c.sql));
const ACTIVE = /AND status IN UNNEST\(@statuses\)/;

describe("executions: only ADMIN", () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ["executions.preview", { kind: "ROUTING", ...WINDOW }],
    ["executions.list", {}],
    ["executions.request", { kind: "ROUTING", ...WINDOW, confirm: true }],
    ["executions.cancel", { request_id: "r1" }],
  ];

  it.each(["VIEWER", "EDITOR"])("refuses a %s on every method before anything is read or written", (role) => {
    for (const [method, payload] of calls) {
      const h = as(role);
      expect(code(h.call(method, { tenant: A, ...payload })), method).toBe("FORBIDDEN");
      expect(h.bq.dataCalls(), method).toHaveLength(0);
    }
  });

  it("lets an ADMIN preview, request, list and cancel", () => {
    const h = as("ADMIN");
    h.bq.on(/SELECT status FROM `[^`]*run_requests`/, [{ status: "REQUESTED" }]);
    expect(code(h.call("executions.preview", { tenant: A, kind: "ROUTING", ...WINDOW }))).toBe("OK");
    expect(code(req(h))).toBe("OK");
    expect(code(h.call("executions.list", { tenant: A }))).toBe("OK");
    expect(code(h.call("executions.cancel", { tenant: A, request_id: "r1" }))).toBe("OK");
  });

  it("is refused for a workspace the admin does not belong to, and every statement is scoped to the tenant", () => {
    const h = as("ADMIN");
    expect(code(req(h, {}, B))).toBe("FORBIDDEN");
    expect(h.bq.dataCalls()).toHaveLength(0);
    ok(req(h));
    ok(h.call("executions.list", { tenant: A }));
    for (const c of h.bq.dataCalls()) {
      if (!/^INSERT INTO [^S]*VALUES/.test(c.sql)) expect(c.sql, c.sql).toMatch(/organization_id = @org AND workspace_id = @ws/); // an INSERT ... VALUES carries the tenant as values
      expect(c.params.org).toEqual({ t: "STRING", v: "org-a" });
      expect(c.params.ws).toEqual({ t: "STRING", v: "ws-a" });
    }
  });
});

describe("executions.request: what is recorded", () => {
  it("records who asked from the Google session (never from the body), the ceiling, the estimate and the normalised parameters", () => {
    const h = as("ADMIN");
    const r = ok(req(h, { requested_by: "boss@example.com", actor: "boss@example.com", changed_by: "boss@example.com" })) as { request_id: string; status: string };
    expect(r.status).toBe("REQUESTED");
    const [ins] = inserts(h);
    expect(ins?.params.by).toEqual({ t: "STRING", v: "ana@example.com" });
    expect(JSON.stringify(ins?.params)).not.toContain("boss@");
    expect(ins?.params.cap).toEqual({ t: "FLOAT64", v: 0.5 });
    expect(JSON.parse(String((ins?.params.params as { v: string }).v))).toEqual({ start: "2026-01-01", end: "2026-01-31", max_sessions: 50 });
    expect(ins?.sql).toMatch(/'REQUESTED'/);
    // 8 tokens-thousand + 8 sessions x 170 overhead, at the indicative prices
    expect(ins?.params.low).toEqual({ t: "FLOAT64", v: ((8000 + 8 * 170) * 0.125) / 1e6 });
  });

  it("audits the request with metadata only", () => {
    const h = as("ADMIN");
    ok(h.call("executions.request", { tenant: A, kind: "ANALYSIS", ...WINDOW, rubric_id: "sales_quality", rubric_version: 5, only_routed: true, confirm: true }));
    const audit = h.bq.calls.find((c) => /INSERT INTO `[^`]*audit_log`/.test(c.sql) && /executions\.request/.test(JSON.stringify(c.params)));
    const text = JSON.stringify(audit?.params);
    expect(text).toContain("sales_quality");
    expect(text).toContain("only_routed");
  });

  it("keeps rubric, version and the routed filter for an analysis, and the session for a single-session analysis", () => {
    const h = as("ADMIN");
    ok(req(h, { kind: "ANALYSIS", rubric_id: "sales_quality", rubric_version: 5, only_routed: true }));
    ok(req(h, { kind: "SESSION_ANALYSIS", session_id: "s0151", rubric_id: "after_sales_quality", rubric_version: 1, start: undefined, end: undefined, max_sessions: undefined }));
    const [a, b] = inserts(h).map((c) => JSON.parse(String((c.params.params as { v: string }).v)) as Record<string, unknown>);
    expect(a).toEqual({ start: "2026-01-01", end: "2026-01-31", max_sessions: 50, rubric_id: "sales_quality", rubric_version: 5, only_routed: true });
    expect(b).toEqual({ session_id: "s0151", rubric_id: "after_sales_quality", rubric_version: 1 });
  });
});

describe("executions.request: guard rails", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["without the explicit confirmation", { confirm: undefined }],
    ["with a ceiling above the configured maximum", { max_cost_usd: 5 }],
    ["with a zero ceiling", { max_cost_usd: 0 }],
    ["with a limit of sessions above the configured maximum", { max_sessions: 5000 }],
    ["with an unknown kind", { kind: "DELETE_EVERYTHING" }],
    ["with an end before the start", { start: "2026-02-01", end: "2026-01-01" }],
    ["with a window over a year", { start: "2024-01-01", end: "2026-01-01" }],
    ["with an end in the future", { end: "2999-01-01" }],
    ["with an impossible date", { start: "2026-02-30" }],
    ["analysis without a rubric", { kind: "ANALYSIS" }],
    ["a model chosen by the request (not accepted: the executor decides)", { kind: "ROUTING", model: "gpt-9" }, ],
  ];
  it.each(cases.slice(0, -1))("is refused %s", (_name, over) => {
    const h = as("ADMIN");
    expect(code(req(h, over))).toBe("INVALID_INPUT");
    expect(inserts(h)).toHaveLength(0);
  });

  it("ignores fields it does not know (the model, prices and provider belong to the executor)", () => {
    const h = as("ADMIN");
    ok(req(h, { model: "gpt-9", provider: "responses", input_price: 0 }));
    expect(JSON.stringify(inserts(h)[0]?.params)).not.toContain("gpt-9");
  });

  it("refuses a rubric that is not published or does not exist", () => {
    const h = as("ADMIN");
    h.bq.on(/FROM `[^`]*evaluation_rubrics` WHERE/, [{ status: "DRAFT" }]);
    expect(code(req(h, { kind: "ANALYSIS", rubric_id: "after_sales_quality", rubric_version: 1 }))).toBe("INVALID_INPUT");
    h.bq.on(/FROM `[^`]*evaluation_rubrics` WHERE/, []);
    expect(code(req(h, { kind: "ANALYSIS", rubric_id: "ghost", rubric_version: 1 }))).toBe("NOT_FOUND");
    expect(inserts(h)).toHaveLength(0);
  });

  it("refuses a ceiling below the estimated worst case, with the numbers in the message", () => {
    const h = as("ADMIN");
    h.bq.on(/WITH s AS/, [{ sessions: 10, with_messages: 10, already: 0, tokens: 40_000_000 }]);
    const r = req(h, { max_cost_usd: 0.5 });
    expect(code(r)).toBe("INVALID_INPUT");
    expect(!r.ok && r.error.message).toMatch(/menor que a estimativa/);
    expect(inserts(h)).toHaveLength(0);
  });

  it("refuses when there is nothing to process, or more than the session limit", () => {
    const h = as("ADMIN");
    h.bq.on(/WITH s AS/, [{ sessions: 5, with_messages: 5, already: 5, tokens: 100 }]);
    expect(code(req(h))).toBe("INVALID_INPUT");
    h.bq.on(/WITH s AS/, [{ sessions: 500, with_messages: 500, already: 0, tokens: 100 }]);
    expect(code(req(h, { max_sessions: 10 }))).toBe("INVALID_INPUT");
    expect(inserts(h)).toHaveLength(0);
  });

  it("refuses a single-session request for a session that is not in the workspace", () => {
    const h = as("ADMIN");
    h.bq.on(/WITH s AS/, [{ sessions: 0, with_messages: 0, already: 0, tokens: 0 }]);
    expect(code(req(h, { kind: "SESSION_ANALYSIS", session_id: "nope", rubric_id: "r", rubric_version: 1 }))).toBe("NOT_FOUND");
  });

  it("allows at most 3 waiting or running requests per workspace and refuses an identical one", () => {
    const h = as("ADMIN");
    const one = { request_id: "r1", kind: "ROUTING", status: "REQUESTED", params: JSON.stringify({ end: "2026-01-31", max_sessions: 50, start: "2026-01-01" }) };
    h.bq.on(ACTIVE, [one]);
    expect(code(req(h))).toBe("CONFLICT"); // same kind and parameters, key order does not matter
    expect(code(req(h, { end: "2026-01-30" }))).toBe("OK");
    h.bq.on(ACTIVE, [one, { ...one, request_id: "r2" }, { ...one, request_id: "r3" }]);
    expect(code(req(h, { end: "2026-01-29" }))).toBe("CONFLICT");
    expect(inserts(h)).toHaveLength(1);
  });
});

describe("executions.cancel", () => {
  it("cancels only a request that has not started, with the guard inside the statement", () => {
    const h = as("ADMIN");
    h.bq.on(/SELECT status FROM `[^`]*run_requests`/, [{ status: "RUNNING" }]);
    expect(code(h.call("executions.cancel", { tenant: A, request_id: "r1" }))).toBe("CONFLICT");
    h.bq.on(/SELECT status FROM `[^`]*run_requests`/, []);
    expect(code(h.call("executions.cancel", { tenant: A, request_id: "r1" }))).toBe("NOT_FOUND");
    h.bq.on(/SELECT status FROM `[^`]*run_requests`/, [{ status: "REQUESTED" }]);
    expect(code(h.call("executions.cancel", { tenant: A, request_id: "r1" }))).toBe("OK");
    const [ins] = inserts(h);
    expect(ins?.sql).toMatch(/'CANCELLED'/);
    expect(ins?.sql).toMatch(/WHERE status = 'REQUESTED'/);
    expect(ins?.params.by).toEqual({ t: "STRING", v: "ana@example.com" });
  });
});

describe("executions.list", () => {
  it("returns the latest row per request, newest first, one page at a time", () => {
    const h = as("ADMIN");
    ok(h.call("executions.list", { tenant: A, limit: 20 }));
    const c = h.bq.dataCalls().find((x) => /FROM `[^`]*run_requests`/.test(x.sql));
    expect(c?.sql).toMatch(/QUALIFY ROW_NUMBER\(\) OVER \(PARTITION BY request_id ORDER BY changed_at DESC\) = 1/);
    expect(c?.sql).toMatch(/ORDER BY requested_at DESC, request_id ASC LIMIT @limit/);
    expect(c?.params.limit).toEqual({ t: "INT64", v: 21 });
  });
});
