import { describe, expect, it } from "vitest";
import { ReviewService } from "../src/server/services/reviews";
import { Tables } from "../src/server/sql";
import { A, B, CFG, FakeBq, code, harness, ok, type Harness } from "./helpers";

const QUEUED = [{ analysis_id: "a1" }];

function as(role: string): Harness {
  return harness({ "ana@example.com": [[A, role]] });
}
/** An analysis that is in the review queue and has no decision yet. */
function queued(h: Harness): Harness {
  h.bq.on(/FROM `[^`]*review_queue` WHERE/, QUEUED);
  return h;
}
const decide = (h: Harness, over: Record<string, unknown> = {}): ReturnType<Harness["call"]> =>
  h.call("review.decide", { tenant: A, sessionId: "s1", analysisId: "a1", decision: "CONFIRMED", ...over });
const inserts = (h: Harness) => h.bq.calls.filter((c) => /INSERT INTO `[^`]*review_decisions`/.test(c.sql));

describe("review.decide: who may decide", () => {
  it("is refused for a VIEWER before anything is read or written", () => {
    const h = queued(as("VIEWER"));
    expect(code(decide(h))).toBe("FORBIDDEN");
    expect(h.bq.dataCalls()).toHaveLength(0);
  });

  it.each(["EDITOR", "ADMIN"])("lets a %s record a decision", (role) => {
    const h = queued(as(role));
    expect(code(decide(h))).toBe("OK");
    expect(inserts(h)).toHaveLength(1);
  });

  it("is refused for a tenant the caller does not belong to", () => {
    const h = queued(as("ADMIN"));
    expect(code(h.call("review.decide", { tenant: B, sessionId: "s1", analysisId: "a1", decision: "CONFIRMED" }))).toBe("FORBIDDEN");
    expect(h.bq.dataCalls()).toHaveLength(0);
  });
});

describe("review.decide: what is stored", () => {
  it("stores the decision next to the analysis, with the reviewer taken from the Google session, never from the request", () => {
    const h = queued(as("EDITOR"));
    ok(decide(h, { decision: "DISAGREED", comment: "O vendedor tratou a objeção.", reviewer: "boss@example.com", reviewer_email: "boss@example.com", actor: "boss@example.com" }));
    const [ins] = inserts(h);
    expect(ins?.params.by).toEqual({ t: "STRING", v: "ana@example.com" });
    expect(ins?.params.decision).toEqual({ t: "STRING", v: "DISAGREED" });
    expect(ins?.params.aid).toEqual({ t: "STRING", v: "a1" });
    expect(ins?.params.org).toEqual({ t: "STRING", v: "org-a" });
    expect(JSON.stringify(ins?.params)).not.toContain("boss@");
  });

  it("is append-only and never touches the analysis, its score or its status", () => {
    const h = queued(as("EDITOR"));
    ok(decide(h));
    const writes = h.bq.calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE|MERGE)/i.test(c.sql) && !/audit_log/.test(c.sql));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.sql).toMatch(/^INSERT INTO `[^`]*review_decisions`/);
    expect(h.bq.calls.some((c) => /(UPDATE|DELETE FROM|MERGE)\s+`[^`]*(session_analyses|session_criterion_results|current_session_results)/.test(c.sql))).toBe(false);
  });

  it("repeats the one-decision-per-analysis guard and the tenant filter inside the INSERT itself", () => {
    const h = queued(as("EDITOR"));
    ok(decide(h));
    const sql = inserts(h)[0]?.sql ?? "";
    expect(sql).toMatch(/FROM `[^`]*review_queue` WHERE organization_id = @org AND workspace_id = @ws AND session_id = @sid AND analysis_id = @aid/);
    expect(sql).toMatch(/AND NOT EXISTS \(SELECT 1 FROM `[^`]*review_decisions` d WHERE d\.organization_id = @org AND d\.workspace_id = @ws AND d\.analysis_id = @aid\)/);
  });

  it("masks personal data in the comment before it is stored", () => {
    const h = queued(as("EDITOR"));
    ok(decide(h, { decision: "DISAGREED", comment: "Cliente deu CPF 123.456.789-09 e o e-mail a@b.com" }));
    const stored = String((inserts(h)[0]?.params.comment as { v: string }).v);
    expect(stored).toBe("Cliente deu CPF [CPF] e o e-mail [EMAIL]");
  });

  it("keeps the comment out of the audit trail (ids and flags only)", () => {
    const h = queued(as("EDITOR"));
    ok(decide(h, { decision: "REANALYSIS", comment: "texto livre do revisor" }));
    const audit = h.bq.calls.find((c) => /INSERT INTO `[^`]*audit_log`/.test(c.sql) && (c.params.action as { v: string }).v === "review.decide");
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit?.params)).not.toContain("texto livre");
    expect(JSON.parse(String((audit?.params.details as { v: string }).v))).toEqual({ session_id: "s1", analysis_id: "a1", decision: "REANALYSIS", has_comment: true });
  });
});

describe("review.decide: rules", () => {
  it("rejects an unknown decision and malformed ids", () => {
    const h = queued(as("EDITOR"));
    expect(code(decide(h, { decision: "APPROVED" }))).toBe("INVALID_INPUT");
    expect(code(decide(h, { decision: undefined }))).toBe("INVALID_INPUT");
    expect(code(decide(h, { analysisId: "a1'; DROP TABLE x;--" }))).toBe("INVALID_INPUT");
    expect(code(decide(h, { sessionId: "" }))).toBe("INVALID_INPUT");
    expect(inserts(h)).toHaveLength(0);
  });

  it("confirming needs no comment; disagreeing or asking for a new analysis must say why", () => {
    expect(code(decide(queued(as("EDITOR")), { decision: "CONFIRMED" }))).toBe("OK");
    for (const decision of ["DISAGREED", "REANALYSIS"]) {
      const h = queued(as("EDITOR"));
      expect(code(decide(h, { decision })), decision).toBe("INVALID_INPUT");
      expect(code(decide(h, { decision, comment: "  " })), decision).toBe("INVALID_INPUT");
      expect(code(decide(h, { decision, comment: "ok, motivo" })), decision).toBe("OK");
    }
  });

  it("limits the comment length", () => {
    const h = queued(as("EDITOR"));
    expect(code(decide(h, { decision: "DISAGREED", comment: "x".repeat(1001) }))).toBe("INVALID_INPUT");
    expect(code(decide(h, { decision: "DISAGREED", comment: "x".repeat(1000) }))).toBe("OK");
  });

  it("refuses an analysis that is not (or no longer) in the queue, without writing", () => {
    const h = as("EDITOR"); // the fake queue is empty
    expect(code(decide(h))).toBe("NOT_FOUND");
    expect(inserts(h)).toHaveLength(0);
  });

  it("refuses a second decision for the same analysis", () => {
    const h = queued(as("EDITOR"));
    h.bq.on(/SELECT decision_id FROM `[^`]*review_decisions`/, [{ decision_id: "d1" }]);
    expect(code(decide(h))).toBe("CONFLICT");
    expect(inserts(h)).toHaveLength(0);
  });

  it("checks the queue, checks for an earlier decision and writes inside one platform lock", () => {
    const events: string[] = [];
    const bq = new FakeBq();
    bq.on(/review_queue` WHERE/, () => (events.push("check-queue"), QUEUED));
    bq.on(/SELECT decision_id FROM/, () => (events.push("check-decision"), []));
    bq.on(/INSERT INTO/, () => (events.push("insert"), []));
    const service = new ReviewService(bq, new Tables(CFG), { newId: () => "d1", withLock: (fn) => (events.push("lock"), fn(), events.push("unlock")) as never });
    service.decide("ana@example.com", A, { sessionId: "s1", analysisId: "a1", decision: "CONFIRMED" });
    expect(events).toEqual(["lock", "check-queue", "check-decision", "insert", "unlock"]);
  });
});

describe("review.list", () => {
  it("is readable by a VIEWER, scoped to the tenant, and hides decided analyses by default", () => {
    const h = as("VIEWER");
    ok(h.call("review.list", { tenant: A }));
    const sql = h.bq.dataCalls()[0]?.sql ?? "";
    expect(sql).toMatch(/WHERE dec\.analysis_id IS NULL/);
    expect(sql).toMatch(/organization_id = @org AND workspace_id = @ws/);
    expect(h.bq.dataCalls()[0]?.params.org).toEqual({ t: "STRING", v: "org-a" });
  });

  it.each([
    ["decided", /WHERE dec\.analysis_id IS NOT NULL/],
    ["all", /^(?!.*WHERE dec\.)/s],
  ])("supports the %s filter", (filter, pattern) => {
    const h = as("VIEWER");
    ok(h.call("review.list", { tenant: A, filter }));
    expect(h.bq.dataCalls()[0]?.sql).toMatch(pattern);
  });

  it("rejects an unknown filter and bounds the window and the page size", () => {
    const h = as("VIEWER");
    expect(code(h.call("review.list", { tenant: A, filter: "x" }))).toBe("INVALID_INPUT");
    expect(code(h.call("review.list", { tenant: A, days: 0 }))).toBe("INVALID_INPUT");
    expect(code(h.call("review.list", { tenant: A, limit: 501 }))).toBe("INVALID_INPUT");
  });

  it("prunes the criteria scan by date, so a large table is not read in full", () => {
    const h = as("VIEWER");
    ok(h.call("review.list", { tenant: A }));
    expect(h.bq.dataCalls()[0]?.sql).toMatch(/evaluated_at >= TIMESTAMP_SUB\(CURRENT_TIMESTAMP\(\), INTERVAL @days DAY\)/);
  });
});

describe("sessions.get returns the decisions recorded for the session", () => {
  it("reads them with the tenant predicate", () => {
    const h = as("VIEWER");
    h.bq.on(/FROM `[^`]*sessions` WHERE/, [{ session_id: "s1", started_at: "2026-01-02T00:00:00.000Z" }]);
    h.bq.on(/FROM `[^`]*review_decisions`/, [{ decision_id: "d1", analysis_id: "a1", decision: "CONFIRMED", reviewer_email: "x@example.com" }]);
    const data = ok(h.call("sessions.get", { tenant: A, sessionId: "s1" })) as { decisions: Array<{ decision: string }> };
    expect(data.decisions[0]?.decision).toBe("CONFIRMED");
    const sql = h.bq.calls.find((c) => /FROM `[^`]*review_decisions`/.test(c.sql))?.sql ?? "";
    expect(sql).toMatch(/organization_id = @org AND workspace_id = @ws/);
  });
});
