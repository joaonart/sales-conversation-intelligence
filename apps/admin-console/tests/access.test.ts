import { describe, expect, it } from "vitest";
import { A, B, code, harness, ok } from "./helpers";

const tenantA = { tenant: A };

describe("authentication", () => {
  it("rejects callers without a Google identity", () => {
    const h = harness({});
    expect(code(h.call("rubrics.list", tenantA, null))).toBe("UNAUTHENTICATED");
  });

  it("rejects accounts outside the Workspace domain even if they have a membership row", () => {
    const h = harness({ "eve@evil.com": [[A, "ADMIN"]] });
    expect(code(h.call("rubrics.list", tenantA, "eve@evil.com"))).toBe("FORBIDDEN");
    expect(h.bq.calls).toHaveLength(0);
  });

  it("normalises the email case", () => {
    const h = harness({ "ana@example.com": [[A, "VIEWER"]] });
    expect(code(h.call("rubrics.list", tenantA, " Ana@Example.com "))).toBe("OK");
  });
});

describe("tenant isolation", () => {
  it("never queries data for a tenant the caller does not belong to", () => {
    const h = harness({ "ana@example.com": [[A, "ADMIN"]] });
    for (const m of ["dashboard.summary", "pipeline.overview", "sessions.list", "sessions.count", "sessions.channels", "sessions.get", "rubrics.list", "review.list", "review.decide", "runs.list", "runs.facets", "runs.get", "runs.failures", "users.list", "audit.list", "audit.get", "audit.facets"]) {
      expect(code(h.call(m, { tenant: B, from: "2026-01-01", to: "2026-01-31", sessionId: "s1" })), m).toBe("FORBIDDEN");
    }
    expect(h.bq.dataCalls()).toHaveLength(0);
  });

  it("is per workspace, not only per organization", () => {
    const h = harness({ "ana@example.com": [[A, "VIEWER"]] });
    expect(code(h.call("rubrics.list", { tenant: { organization_id: "org-a", workspace_id: "other-ws" } }))).toBe("FORBIDDEN");
  });

  it("puts the tenant predicate and the claimed tenant in every data statement of every read method", () => {
    const h = harness({ "ana@example.com": [[A, "ADMIN"]] });
    const payloads: Record<string, Record<string, unknown>> = {
      "dashboard.summary": {},
      "pipeline.overview": {},
      "sessions.list": { from: "2026-01-01", to: "2026-01-31", status: "NEEDS_REVIEW", query: "s1" },
      "sessions.count": { from: "2026-01-01", to: "2026-01-31", channel: "whatsapp", result: "APPROVED", rubric: "r1" },
      "sessions.channels": { from: "2026-01-01", to: "2026-01-31" },
      "sessions.get": { sessionId: "s1" },
      "rubrics.list": {},
      "rubrics.get": { rubric_id: "r1", version: 1 },
      "review.list": {},
      "runs.list": {},
      "runs.facets": {},
      "runs.get": { run_id: "r1" },
      "runs.failures": { run_id: "r1" },
      "users.list": {},
      "audit.list": {},
      "audit.get": { event_id: "e1" },
      "audit.facets": {},
    };
    h.bq.on(/FROM `[^`]*sessions` WHERE/, [{ session_id: "s1", started_at: "2026-01-02T00:00:00.000Z" }]);
    h.bq.on(/FROM `[^`]*evaluation_rubrics`/, [{ rubric_id: "r1", version: 1, name: "n", status: "DRAFT" }]);
    h.bq.on(/FROM `[^`]*latest_analysis_runs` WHERE/, [{ run_id: "r1", run_status: "COMPLETED" }]);
    h.bq.on(/FROM `[^`]*audit_log` WHERE organization_id/, [{ event_id: "e1", action: "session.view", outcome: "SUCCESS", details: "{}" }]);
    for (const [method, payload] of Object.entries(payloads)) {
      h.bq.calls.length = 0;
      ok(h.call(method, { tenant: A, ...payload }));
      const data = h.bq.dataCalls();
      expect(data.length, method).toBeGreaterThan(0);
      for (const c of data) {
        expect(c.sql, `${method}: ${c.sql}`).toMatch(/organization_id = @org/);
        expect(c.sql, method).toMatch(/workspace_id = @ws/);
        expect(c.params.org, method).toEqual({ t: "STRING", v: "org-a" });
        expect(c.params.ws, method).toEqual({ t: "STRING", v: "ws-a" });
      }
    }
  });

  it("never interpolates request values into SQL text", () => {
    const h = harness({ "ana@example.com": [[A, "ADMIN"]] });
    h.bq.on(/FROM `[^`]*sessions` WHERE/, [{ session_id: "s1", started_at: "2026-01-02T00:00:00.000Z" }]);
    ok(h.call("sessions.list", { tenant: A, from: "2026-01-01", to: "2026-01-31", query: "s1", status: "COMPLETED" }));
    ok(h.call("sessions.get", { tenant: A, sessionId: "s1" }));
    for (const c of h.bq.dataCalls()) {
      expect(c.sql).not.toContain("org-a");
      expect(c.sql).not.toContain("s1'");
    }
  });

  it("rejects injection attempts in identifiers before any query", () => {
    const h = harness({ "ana@example.com": [[A, "ADMIN"]] });
    const evil = "s1' OR '1'='1";
    expect(code(h.call("sessions.get", { tenant: A, sessionId: evil }))).toBe("INVALID_INPUT");
    expect(code(h.call("sessions.list", { tenant: A, from: "2026-01-01", to: "2026-01-31", query: evil }))).toBe("INVALID_INPUT");
    expect(code(h.call("rubrics.get", { tenant: A, rubric_id: "x`; DROP", version: 1 }))).toBe("INVALID_INPUT");
    expect(h.bq.dataCalls()).toHaveLength(0);
  });
});

describe("roles", () => {
  it("viewers cannot write", () => {
    const h = harness({ "ana@example.com": [[A, "VIEWER"]] });
    expect(code(h.call("rubrics.createDraft", { tenant: A, rubric_id: "r1", name: "n" }))).toBe("FORBIDDEN");
    expect(code(h.call("users.list", { tenant: A }))).toBe("FORBIDDEN");
    expect(h.bq.dataCalls()).toHaveLength(0);
  });

  it("editors edit drafts but cannot publish or manage users", () => {
    const h = harness({ "ana@example.com": [[A, "EDITOR"]] });
    expect(code(h.call("rubrics.publish", { tenant: A, rubric_id: "r1", version: 1, etag: "x" }))).toBe("FORBIDDEN");
    expect(code(h.call("users.upsert", { tenant: A, email: "b@example.com", role: "ADMIN" }))).toBe("FORBIDDEN");
    expect(code(h.call("audit.list", { tenant: A }))).toBe("FORBIDDEN");
  });

  it("a denied attempt is audited", () => {
    const h = harness({ "ana@example.com": [[A, "VIEWER"]] });
    h.call("rubrics.publish", { tenant: A, rubric_id: "r1", version: 1, etag: "x" });
    const audit = h.bq.calls.find((c) => /audit_log/.test(c.sql));
    expect(audit?.params.outcome).toEqual({ t: "STRING", v: "DENIED" });
    expect(audit?.params.actor).toEqual({ t: "STRING", v: "ana@example.com" });
  });

  it("memberships for other emails cannot be borrowed through the payload", () => {
    const h = harness({ "ana@example.com": [[A, "VIEWER"]], "boss@example.com": [[A, "ADMIN"]] });
    expect(code(h.call("users.list", { tenant: A, email: "boss@example.com", actor: "boss@example.com" }))).toBe("FORBIDDEN");
  });
});

describe("revocation and bootstrap", () => {
  it("a disabled user loses access once the short cache expires", () => {
    const h = harness({ "ana@example.com": [[A, "VIEWER"]] });
    expect(code(h.call("rubrics.list", tenantA))).toBe("OK");
    h.bq.on(/FROM `[^`]*app_users` WHERE email = @email QUALIFY/, [{ ...A, role: "VIEWER", status: "DISABLED" }]);
    h.cache.store.clear();
    expect(code(h.call("rubrics.list", tenantA))).toBe("FORBIDDEN");
  });

  it("bootstraps only listed emails that never had a row, and audits it", () => {
    const h = harness({}, { cfg: { bootstrapAdmins: [{ email: "root@example.com", ...A }] } });
    expect(code(h.call("rubrics.list", tenantA, "someone@example.com"))).toBe("FORBIDDEN");
    expect(code(h.call("rubrics.list", tenantA, "root@example.com"))).toBe("OK");
    const insert = h.bq.calls.find((c) => /INSERT INTO `[^`]*app_users`/.test(c.sql));
    expect(insert?.sql).toContain("'ADMIN'");
    expect(h.bq.calls.some((c) => /audit_log/.test(c.sql) && (c.params.action as { v: string }).v === "user.bootstrap_admin")).toBe(true);
  });

  it("does not re-bootstrap an email that was disabled (it still has a row)", () => {
    const h = harness({ "root@example.com": [] }, { cfg: { bootstrapAdmins: [{ email: "root@example.com", ...A }] } });
    expect(code(h.call("rubrics.list", tenantA, "root@example.com"))).toBe("FORBIDDEN");
    expect(h.bq.calls.some((c) => /INSERT INTO `[^`]*app_users`/.test(c.sql))).toBe(false);
  });
});


describe("a user with several workspaces", () => {
  const A2 = { organization_id: "org-a", workspace_id: "ws-second" }; // same organization, other workspace

  /** A fake that answers like BigQuery would: only rows of the tenant in the statement's parameters. */
  function twoTenantData(h: ReturnType<typeof harness>): void {
    const rows = [
      { organization_id: "org-a", workspace_id: "ws-a", rubric_id: "ra", rubric_version: 1, day: "2026-01-02", sessions: 14, scored_sessions: 11, avg_score: 80, approved: 5, rejected: 6, needs_review: 1, not_evaluable: 2, approval_rate: 0.45 },
      { organization_id: "org-b", workspace_id: "ws-b", rubric_id: "rb", rubric_version: 1, day: "2026-01-02", sessions: 10, scored_sessions: 8, avg_score: 60, approved: 4, rejected: 4, needs_review: 0, not_evaluable: 2, approval_rate: 0.5 },
      { organization_id: "org-a", workspace_id: "ws-second", rubric_id: "rc", rubric_version: 1, day: "2026-01-02", sessions: 3, scored_sessions: 3, avg_score: 90, approved: 3, rejected: 0, needs_review: 0, not_evaluable: 0, approval_rate: 1 },
    ];
    h.bq.on(/gold_daily_quality/, (c) => {
      const org = (c.params.org as { v: string }).v;
      const ws = (c.params.ws as { v: string }).v;
      return rows.filter((r) => r.organization_id === org && r.workspace_id === ws);
    });
  }

  it("lists every membership and returns, per claimed workspace, only that workspace's dashboard", () => {
    const h = harness({ "ana@example.com": [[A, "ADMIN"], [B, "VIEWER"], [A2, "EDITOR"]] });
    twoTenantData(h);
    const me = ok(h.call("me")) as { memberships: Array<{ organization_id: string; workspace_id: string }> };
    expect(me.memberships.map((m) => `${m.organization_id}/${m.workspace_id}`).sort()).toEqual(["org-a/ws-a", "org-a/ws-second", "org-b/ws-b"]);
    const sessions = (t: typeof A): number[] => ((ok(h.call("dashboard.summary", { tenant: t })) as { quality: Array<{ sessions: number }> }).quality).map((r) => r.sessions);
    expect(sessions(A)).toEqual([14]);
    expect(sessions(B)).toEqual([10]);
    expect(sessions(A2)).toEqual([3]); // same organization, different workspace: still separate
    expect(sessions(A)).toEqual([14]); // switching back and forth never carries data over
  });

  it("never sums workspaces: the dashboard of one has no row of another, and a workspace without membership is refused", () => {
    const h = harness({ "ana@example.com": [[A, "ADMIN"]] });
    twoTenantData(h);
    const quality = (ok(h.call("dashboard.summary", { tenant: A })) as { quality: Array<{ organization_id?: string; workspace_id?: string }> }).quality;
    expect(quality.every((r) => r.organization_id === "org-a" && r.workspace_id === "ws-a")).toBe(true);
    expect(code(h.call("dashboard.summary", { tenant: B }))).toBe("FORBIDDEN");
    expect(code(h.call("dashboard.summary", { tenant: A2 }))).toBe("FORBIDDEN");
  });

  it("uses the role of the claimed workspace, not the highest one the user has elsewhere", () => {
    const h = harness({ "ana@example.com": [[A, "ADMIN"], [B, "VIEWER"]] });
    expect(code(h.call("users.list", { tenant: A }))).toBe("OK");
    expect(code(h.call("users.list", { tenant: B }))).toBe("FORBIDDEN");
  });
});
