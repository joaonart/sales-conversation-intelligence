import { describe, expect, it } from "vitest";
import { A, code, harness, ok, type Harness } from "./helpers";

const SESSION = [{ session_id: "s1", channel: "whatsapp", status: "closed", started_at: "2026-01-02T00:00:00.000Z" }];

function as(role: string): Harness {
  return harness({ "ana@example.com": [[A, role]] });
}

describe("conversation content", () => {
  it("masks PII, records the access before releasing content", () => {
    const h = as("VIEWER");
    h.bq.on(/FROM `[^`]*sessions` WHERE/, SESSION);
    h.bq.on(/FROM `[^`]*messages`/, [
      { message_id: "m1", sender_type: "customer", content: "Meu CPF é 123.456.789-09 e e-mail a@b.com", sequence_number: 1 },
    ]);
    const data = ok(h.call("sessions.get", { tenant: A, sessionId: "s1" })) as { messages: Array<{ content: string }> };
    expect(data.messages[0]?.content).toBe("Meu CPF é [CPF] e e-mail [EMAIL]");
    const order = h.bq.calls.map((c) => (/audit_log/.test(c.sql) ? "audit" : /messages/.test(c.sql) ? "messages" : "other"));
    expect(order.indexOf("audit")).toBeGreaterThan(-1);
    expect(order.indexOf("audit")).toBeLessThan(order.indexOf("messages"));
    const rec = h.bq.calls.find((c) => /audit_log/.test(c.sql));
    expect(JSON.stringify(rec?.params)).not.toContain("123.456");
    expect(rec?.params.action).toEqual({ t: "STRING", v: "session.view" });
  });

  it("fails closed: no content when the audit write fails", () => {
    const h = as("VIEWER");
    h.bq.on(/FROM `[^`]*sessions` WHERE/, SESSION);
    h.bq.on(/FROM `[^`]*messages`/, [{ message_id: "m1", sender_type: "customer", content: "segredo", sequence_number: 1 }]);
    h.bq.on(/INSERT INTO `[^`]*audit_log`/, new Error("audit down"));
    const r = h.call("sessions.get", { tenant: A, sessionId: "s1" });
    expect(code(r)).toBe("INTERNAL");
    expect(JSON.stringify(r)).not.toContain("segredo");
    expect(h.bq.calls.some((c) => /FROM `[^`]*messages`/.test(c.sql))).toBe(false);
  });

  it("returns NOT_FOUND without touching messages for unknown sessions", () => {
    const h = as("VIEWER");
    expect(code(h.call("sessions.get", { tenant: A, sessionId: "nope" }))).toBe("NOT_FOUND");
    expect(h.bq.calls.some((c) => /messages/.test(c.sql))).toBe(false);
  });
});

describe("errors and abuse", () => {
  it("does not leak internal error text to the client", () => {
    const h = as("VIEWER");
    h.bq.on(/FROM `[^`]*evaluation_rubrics`/, new Error("permission denied on proj-123456.conversation_config SECRET-TOKEN-xyz"));
    const r = h.call("rubrics.list", { tenant: A });
    expect(code(r)).toBe("INTERNAL");
    const text = JSON.stringify(r);
    expect(text).not.toContain("SECRET-TOKEN");
    expect(text).not.toContain("permission denied");
    expect(r.ok ? "" : r.error.message).toContain(r.requestId);
  });

  it("rejects malformed, oversized and unknown requests", () => {
    const h = as("ADMIN");
    h.setUser("ana@example.com");
    expect(code(h.call("nope", { tenant: A }))).toBe("INVALID_INPUT");
    expect(code(h.call("__proto__", { tenant: A }))).toBe("INVALID_INPUT");
    expect(code(h.call("constructor", { tenant: A }))).toBe("INVALID_INPUT");
    expect(code(h.call("rubrics.list", {}))).toBe("INVALID_INPUT");
    expect(code(h.call("rubrics.list", { tenant: "org-a" }))).toBe("INVALID_INPUT");
  });

  it("throttles bursts per user", () => {
    const h = as("VIEWER");
    let limited = false;
    for (let i = 0; i < 300; i++) if (code(h.call("rubrics.list", { tenant: A })) === "RATE_LIMITED") limited = true;
    expect(limited).toBe(true);
  });

  it("bounds the session search window", () => {
    const h = as("VIEWER");
    expect(code(h.call("sessions.list", { tenant: A, from: "2020-01-01", to: "2026-01-01" }))).toBe("INVALID_INPUT");
    expect(code(h.call("sessions.list", { tenant: A, from: "2026-02-01", to: "2026-01-01" }))).toBe("INVALID_INPUT");
    expect(code(h.call("sessions.list", { tenant: A, from: "2026-01-01", to: "2026-01-31", limit: 5000 }))).toBe("INVALID_INPUT");
  });

  it("paginates with a keyset cursor and reports the next page", () => {
    const h = as("VIEWER");
    const rows = Array.from({ length: 3 }, (_, i) => ({ session_id: `s${i}`, started_at: `2026-01-0${3 - i}T00:00:00.000Z`, cursor_ts: `2026-01-0${3 - i}T00:00:00.123456Z` }));
    h.bq.on(/FROM `[^`]*sessions` s/, rows);
    const page = ok(h.call("sessions.list", { tenant: A, from: "2026-01-01", to: "2026-01-31", limit: 2 })) as { rows: unknown[]; nextCursor: { session_id: string } | null };
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor?.session_id).toBe("s1");
    // the cursor keeps the microseconds: a JS Date would cut them to milliseconds and the next page would skip rows
    expect(page.nextCursor).toEqual({ started_at: "2026-01-02T00:00:00.123456Z", session_id: "s1" });
    expect(JSON.stringify(page.rows)).not.toContain("cursor_ts");
    const q = h.bq.calls.find((c) => /FROM `[^`]*sessions` s/.test(c.sql));
    expect(q?.params.limit).toEqual({ t: "INT64", v: 3 });
  });
});

const CRIT = (over: Record<string, unknown> = {}) => ({
  criterion_id: "greeting", criterion_name: "Saudação", evaluation_instructions: "Cumprimentou?", evaluation_type: "PREDICATE",
  weight: 10, required: false, enabled: true, score_mapping: { true: 100, false: 0 }, level_descriptions: {}, applicability_rule: null, display_order: 1, ...over,
});
const POLICY = {
  minimum_approval_score: 70, missing_evidence_policy: "NEEDS_REVIEW", max_analyses_per_session: null, max_input_tokens: null,
  monthly_budget_usd: null, min_messages: 3, min_customer_messages: 0, min_seller_messages: 0,
};

function withDraft(h: Harness, status = "DRAFT", criteria: unknown[] = [CRIT()]): void {
  h.bq.on(/FROM `[^`]*evaluation_rubrics` WHERE/, [{ rubric_id: "r1", version: 2, name: "Qual", status, description: "" }]);
  h.bq.on(/FROM `[^`]*evaluation_criteria`/, criteria.map((c) => {
    const x = c as ReturnType<typeof CRIT>;
    const { level_descriptions: _levels, ...rest } = x;
    return { ...rest, score_mapping: JSON.stringify(x.score_mapping), score_levels: null };
  }));
  h.bq.on(/FROM `[^`]*evaluation_policies`/, [{ ...POLICY }]);
}

describe("rubric lifecycle", () => {
  it("drafts are edited in one transaction guarded by status and etag", () => {
    const h = as("EDITOR");
    withDraft(h);
    const current = ok(h.call("rubrics.get", { tenant: A, rubric_id: "r1", version: 2 })) as { etag: string };
    const res = ok(h.call("rubrics.saveDraft", {
      tenant: A, rubric_id: "r1", version: 2, etag: current.etag, draft: { name: "Novo nome", description: "", criteria: [CRIT({ weight: 20 })], policy: POLICY },
    })) as { etag: string; issues: unknown[] };
    expect(res.issues).toEqual([]);
    expect(res.etag).not.toBe(current.etag);
    const script = h.bq.calls.find((c) => /BEGIN TRANSACTION/.test(c.sql) && /UPDATE/.test(c.sql));
    expect(script?.sql).toMatch(/status = 'DRAFT'/);
    expect(script?.sql).toMatch(/SCI_CONFLICT/);
    expect(script?.sql.match(/organization_id = @org AND workspace_id = @ws/g)?.length).toBeGreaterThanOrEqual(3); // UPDATE + 2 DELETEs; the INSERTs take the tenant as values
    const audit = h.bq.calls.filter((c) => /INSERT INTO `[^`]*audit_log`/.test(c.sql)).at(-1);
    expect(audit?.params.action).toEqual({ t: "STRING", v: "rubrics.saveDraft" });
    expect(audit?.params.outcome).toEqual({ t: "STRING", v: "SUCCESS" });
  });

  it("rejects a stale etag (lost update) and never writes", () => {
    const h = as("EDITOR");
    withDraft(h);
    const r = h.call("rubrics.saveDraft", { tenant: A, rubric_id: "r1", version: 2, etag: "stale", draft: { name: "x", description: "", criteria: [CRIT()], policy: POLICY } });
    expect(code(r)).toBe("CONFLICT");
    expect(h.bq.calls.some((c) => /BEGIN TRANSACTION/.test(c.sql))).toBe(false);
  });

  it("published rubrics are immutable", () => {
    const h = as("ADMIN");
    withDraft(h, "PUBLISHED");
    const g = ok(h.call("rubrics.get", { tenant: A, rubric_id: "r1", version: 2 })) as { etag: string };
    expect(code(h.call("rubrics.saveDraft", { tenant: A, rubric_id: "r1", version: 2, etag: g.etag, draft: { name: "x", description: "", criteria: [CRIT()], policy: POLICY } }))).toBe("CONFLICT");
    expect(code(h.call("rubrics.publish", { tenant: A, rubric_id: "r1", version: 2, etag: g.etag }))).toBe("CONFLICT");
    expect(code(h.call("rubrics.deleteDraft", { tenant: A, rubric_id: "r1", version: 2 }))).toBe("OK"); // server-side guard is in SQL
    const del = h.bq.calls.find((c) => /DELETE FROM `[^`]*evaluation_rubrics`/.test(c.sql));
    expect(del?.sql).toMatch(/status = 'DRAFT'/);
  });

  it("allows saving an incomplete draft but reports the issues, and blocks publishing it", () => {
    const h = as("ADMIN");
    const bad = CRIT({ evaluation_type: "SCORE", score_mapping: { low: 10, high: 10 } });
    withDraft(h, "DRAFT", [bad]);
    const g = ok(h.call("rubrics.get", { tenant: A, rubric_id: "r1", version: 2 })) as { etag: string; issues: Array<{ path: string }> };
    expect(g.issues.length).toBeGreaterThan(0);
    const r = h.call("rubrics.publish", { tenant: A, rubric_id: "r1", version: 2, etag: g.etag });
    expect(code(r)).toBe("INVALID_INPUT");
    expect(r.ok ? [] : r.error.details?.length).toBeGreaterThan(0);
    expect(h.bq.calls.some((c) => /status = 'PUBLISHED'/.test(c.sql))).toBe(false);
  });

  it("publishes a valid draft once, guarded by status, with the reviewed etag, and audits it", () => {
    const h = as("ADMIN");
    withDraft(h);
    const g = ok(h.call("rubrics.get", { tenant: A, rubric_id: "r1", version: 2 })) as { etag: string };
    expect(ok(h.call("rubrics.publish", { tenant: A, rubric_id: "r1", version: 2, etag: g.etag }))).toEqual({ version: 2, criteria: 1 });
    const upd = h.bq.calls.find((c) => /SET status = 'PUBLISHED'/.test(c.sql));
    expect(upd?.sql).toMatch(/AND status = 'DRAFT'/);
    expect(upd?.sql).toMatch(/SCI_CONFLICT/);
    const audit = h.bq.calls.filter((c) => /INSERT INTO `[^`]*audit_log`/.test(c.sql)).at(-1);
    expect(audit?.params.action).toEqual({ t: "STRING", v: "rubrics.publish" });
    expect(code(h.call("rubrics.publish", { tenant: A, rubric_id: "r1", version: 2, etag: "outdated" }))).toBe("CONFLICT");
  });

  it("validates shapes before building any statement", () => {
    const h = as("EDITOR");
    withDraft(h);
    const g = ok(h.call("rubrics.get", { tenant: A, rubric_id: "r1", version: 2 })) as { etag: string };
    const send = (draft: unknown) => code(h.call("rubrics.saveDraft", { tenant: A, rubric_id: "r1", version: 2, etag: g.etag, draft }));
    expect(send({ name: "", description: "", criteria: [], policy: POLICY })).toBe("INVALID_INPUT");
    expect(send({ name: "n", description: "", criteria: [CRIT({ weight: "10" })], policy: POLICY })).toBe("INVALID_INPUT");
    expect(send({ name: "n", description: "", criteria: [CRIT({ evaluation_type: "FREE" })], policy: POLICY })).toBe("INVALID_INPUT");
    expect(send({ name: "n", description: "", criteria: [CRIT({ score_mapping: { true: 500, false: 0 } })], policy: POLICY })).toBe("INVALID_INPUT");
    expect(send({ name: "n", description: "", criteria: [CRIT()], policy: { ...POLICY, max_input_tokens: 999_999 } })).toBe("INVALID_INPUT");
    expect(h.bq.calls.some((c) => /BEGIN TRANSACTION/.test(c.sql))).toBe(false);
  });

  it("creates drafts in a guarded transaction (one open draft per rubric)", () => {
    const h = as("EDITOR");
    h.bq.on(/SELECT MAX\(version\)/, [{ version: 3 }]);
    expect(ok(h.call("rubrics.createDraft", { tenant: A, rubric_id: "r1", name: "Nova" }))).toEqual({ version: 3 });
    const s = h.bq.calls.find((c) => /DECLARE next_ver/.test(c.sql));
    expect(s?.sql).toMatch(/status = 'DRAFT'\) THEN RAISE/);
    expect(s?.sql).toMatch(/'DRAFT', NULL, CURRENT_TIMESTAMP\(\)/);
  });
});

describe("users", () => {
  const rows = (admins: number) => [
    ...Array.from({ length: admins }, (_, i) => ({ email: `admin${i}@example.com`, role: "ADMIN", status: "ACTIVE" })),
    { email: "v@example.com", role: "VIEWER", status: "ACTIVE" },
  ];

  it("never leaves a workspace without an active administrator", () => {
    const h = harness({ "ana@example.com": [[A, "ADMIN"]] });
    h.bq.on(/SELECT email, role, status, changed_at/, rows(1));
    expect(code(h.call("users.upsert", { tenant: A, email: "admin0@example.com", role: "VIEWER" }))).toBe("CONFLICT");
    expect(code(h.call("users.upsert", { tenant: A, email: "admin0@example.com", role: "ADMIN", status: "DISABLED" }))).toBe("CONFLICT");
    h.bq.on(/SELECT email, role, status, changed_at/, rows(2));
    expect(code(h.call("users.upsert", { tenant: A, email: "admin0@example.com", role: "VIEWER" }))).toBe("OK");
  });

  it("only accepts accounts from the allowed domain and appends a row (no update)", () => {
    const h = harness({ "ana@example.com": [[A, "ADMIN"]] });
    h.bq.on(/SELECT email, role, status, changed_at/, rows(2));
    expect(code(h.call("users.upsert", { tenant: A, email: "x@gmail.com", role: "VIEWER" }))).toBe("INVALID_INPUT");
    expect(code(h.call("users.upsert", { tenant: A, email: "n@example.com", role: "SUPERUSER" }))).toBe("INVALID_INPUT");
    ok(h.call("users.upsert", { tenant: A, email: "N@Example.com", role: "VIEWER" }));
    const ins = h.bq.calls.find((c) => /INSERT INTO `[^`]*app_users`/.test(c.sql) && !/bootstrap/.test(c.sql));
    expect(ins?.params.email).toEqual({ t: "STRING", v: "n@example.com" });
    expect(ins?.params.by).toEqual({ t: "STRING", v: "ana@example.com" });
    expect(h.bq.calls.some((c) => /UPDATE|DELETE/.test(c.sql))).toBe(false);
  });

  it("a role change applies immediately for the target (cache invalidated)", () => {
    const h = harness({ "ana@example.com": [[A, "ADMIN"]], "n@example.com": [[A, "VIEWER"]] });
    h.bq.on(/SELECT email, role, status, changed_at/, rows(2));
    expect(code(h.call("rubrics.list", { tenant: A }, "n@example.com"))).toBe("OK");
    expect(h.cache.get("mem:n@example.com")).not.toBeNull();
    ok(h.call("users.upsert", { tenant: A, email: "n@example.com", role: "EDITOR" }));
    expect(h.cache.get("mem:n@example.com")).toBeNull();
  });
});

/** What the BigQuery column holds: one condition keeps the flat depends_on shape, several are all_of. */
function storedRule(rule: { conditions: unknown[] } | null): string | null {
  if (!rule) return null;
  return JSON.stringify(rule.conditions.length === 1 ? { type: "depends_on", ...(rule.conditions[0] as object) } : { type: "all_of", rules: rule.conditions });
}

describe("applicability rules are preserved by the console", () => {
  const RULE = { criterion_id: "gate", equals: ["true"] };
  const RULE_SET = { conditions: [RULE] };
  const gate = CRIT({ criterion_id: "gate", weight: 0, display_order: 2 });
  const dep = CRIT({ criterion_id: "dep", evaluation_type: "SCORE", score_mapping: { low: 0, high: 100 }, weight: 20, applicability_rule: RULE_SET, display_order: 3 });

  function draftWithRule(h: Harness): void {
    h.bq.on(/FROM `[^`]*evaluation_rubrics` WHERE/, [{ rubric_id: "r1", version: 2, name: "Qual", status: "DRAFT", description: "" }]);
    h.bq.on(/FROM `[^`]*evaluation_criteria`/, [CRIT(), gate, dep].map((c) => {
      const { level_descriptions: _l, applicability_rule, ...rest } = c as ReturnType<typeof CRIT> & { applicability_rule: unknown };
      return { ...rest, score_mapping: JSON.stringify(c.score_mapping), score_levels: null, applicability_rule: storedRule(applicability_rule as { conditions: unknown[] } | null) };
    }));
    h.bq.on(/FROM `[^`]*evaluation_policies`/, [{ ...POLICY }]);
  }

  it("reads the rule from the JSON column", () => {
    const h = as("EDITOR");
    draftWithRule(h);
    const g = ok(h.call("rubrics.get", { tenant: A, rubric_id: "r1", version: 2 })) as { draft: { criteria: Array<{ criterion_id: string; applicability_rule: unknown }> }; issues: unknown[] };
    expect(g.draft.criteria.find((c) => c.criterion_id === "dep")?.applicability_rule).toEqual(RULE_SET);
    expect(g.draft.criteria.find((c) => c.criterion_id === "greeting")?.applicability_rule).toBeNull();
    expect(g.issues).toEqual([]);
  });

  it("saving writes the rule back (it is never silently dropped) and the etag covers it", () => {
    const h = as("EDITOR");
    draftWithRule(h);
    const g = ok(h.call("rubrics.get", { tenant: A, rubric_id: "r1", version: 2 })) as { etag: string; draft: unknown };
    const saved = ok(h.call("rubrics.saveDraft", { tenant: A, rubric_id: "r1", version: 2, etag: g.etag, draft: g.draft })) as { etag: string };
    expect(saved.etag).toBe(g.etag); // an unchanged draft keeps its hash
    const script = h.bq.calls.find((c) => /BEGIN TRANSACTION/.test(c.sql) && /UPDATE/.test(c.sql));
    expect(script?.sql).toContain("IF(c.rule IS NULL, NULL, PARSE_JSON(c.rule))");
    const rows = (script?.params.criteria as unknown as { v: Array<{ criterion_id: string; rule: string | null }> }).v;
    expect(JSON.parse(rows.find((r) => r.criterion_id === "dep")!.rule!)).toEqual({ type: "depends_on", ...RULE });
    expect(rows.find((r) => r.criterion_id === "greeting")!.rule).toBeNull();
    // dropping the rule changes the content hash, so a stale reviewer cannot publish over it
    const without = { ...(g.draft as { criteria: Array<Record<string, unknown>> }) };
    without.criteria = without.criteria.map((c) => (c.criterion_id === "dep" ? { ...c, applicability_rule: null } : c));
    const res = ok(h.call("rubrics.saveDraft", { tenant: A, rubric_id: "r1", version: 2, etag: g.etag, draft: without })) as { etag: string };
    expect(res.etag).not.toBe(g.etag);
  });

  it("cloning copies the rule column too", () => {
    const h = as("EDITOR");
    draftWithRule(h);
    h.bq.on(/SELECT MAX\(version\)/, [{ version: 3 }]);
    ok(h.call("rubrics.createDraft", { tenant: A, rubric_id: "r1", name: "Nova", cloneFromVersion: 2 }));
    const s = h.bq.calls.find((c) => /DECLARE next_ver/.test(c.sql));
    expect(s?.sql).toMatch(/INSERT INTO `[^`]*evaluation_criteria` \([^)]*applicability_rule[^)]*\) SELECT [^;]*applicability_rule[^;]*FROM/);
  });

  it("an invalid rule is reported as an issue and blocks publishing", () => {
    const h = as("ADMIN");
    h.bq.on(/FROM `[^`]*evaluation_rubrics` WHERE/, [{ rubric_id: "r1", version: 2, name: "Qual", status: "DRAFT", description: "" }]);
    h.bq.on(/FROM `[^`]*evaluation_criteria`/, [CRIT(), { ...CRIT({ criterion_id: "dep" }), score_mapping: JSON.stringify({ true: 100, false: 0 }), score_levels: null,
      applicability_rule: JSON.stringify({ type: "depends_on", criterion_id: "ghost", equals: ["true"] }) }].map((c) => ({ ...c, score_mapping: typeof c.score_mapping === "string" ? c.score_mapping : JSON.stringify(c.score_mapping), score_levels: null })) as never);
    h.bq.on(/FROM `[^`]*evaluation_policies`/, [{ ...POLICY }]);
    const g = ok(h.call("rubrics.get", { tenant: A, rubric_id: "r1", version: 2 })) as { etag: string; issues: Array<{ path: string }> };
    expect(g.issues.some((i) => i.path.endsWith("applicability_rule"))).toBe(true);
    expect(code(h.call("rubrics.publish", { tenant: A, rubric_id: "r1", version: 2, etag: g.etag }))).toBe("INVALID_INPUT");
  });

  it("rejects a malformed rule before any statement", () => {
    const h = as("EDITOR");
    draftWithRule(h);
    const g = ok(h.call("rubrics.get", { tenant: A, rubric_id: "r1", version: 2 })) as { etag: string };
    const send = (rule: unknown) => code(h.call("rubrics.saveDraft", { tenant: A, rubric_id: "r1", version: 2, etag: g.etag, draft: { name: "n", description: "", criteria: [CRIT(), gate, { ...dep, applicability_rule: rule }], policy: POLICY } }));
    expect(send("gate")).toBe("INVALID_INPUT");
    expect(send({ criterion_id: "gate" })).toBe("INVALID_INPUT");
    expect(send({ criterion_id: "gate", equals: [1] })).toBe("INVALID_INPUT");
    expect(h.bq.calls.some((c) => /BEGIN TRANSACTION/.test(c.sql))).toBe(false);
  });
});


describe("all_of rules (several gates, e.g. 'is a sales conversation' AND 'has an objection')", () => {
  const SALES = { criterion_id: "is_sales", equals: ["true"] };
  const OBJ = { criterion_id: "has_objection", equals: ["true"] };
  const gate = (id: string, order: number) => CRIT({ criterion_id: id, weight: 0, display_order: order });
  const dep = CRIT({ criterion_id: "objections", evaluation_type: "SCORE", score_mapping: { poor: 0, good: 100 }, weight: 20, display_order: 5, applicability_rule: { conditions: [SALES, OBJ] } });
  const rows = () =>
    [gate("is_sales", 1), gate("has_objection", 2), dep].map((c) => {
      const { level_descriptions: _l, applicability_rule, ...rest } = c as ReturnType<typeof CRIT> & { applicability_rule: { conditions: unknown[] } | null };
      return { ...rest, score_mapping: JSON.stringify(c.score_mapping), score_levels: null, applicability_rule: storedRule(applicability_rule) };
    });
  function load(h: Harness): void {
    h.bq.on(/FROM `[^`]*evaluation_rubrics` WHERE/, [{ rubric_id: "r1", version: 2, name: "Qual", status: "DRAFT", description: "" }]);
    h.bq.on(/FROM `[^`]*evaluation_criteria`/, rows() as never);
    h.bq.on(/FROM `[^`]*evaluation_policies`/, [{ ...POLICY }]);
  }

  it("reads an all_of rule into conditions and finds no issues", () => {
    const h = as("EDITOR");
    load(h);
    const g = ok(h.call("rubrics.get", { tenant: A, rubric_id: "r1", version: 2 })) as { draft: { criteria: Array<{ criterion_id: string; applicability_rule: unknown }> }; issues: unknown[] };
    expect(g.draft.criteria.find((c) => c.criterion_id === "objections")?.applicability_rule).toEqual({ conditions: [SALES, OBJ] });
    expect(g.issues).toEqual([]);
  });

  it("saves several conditions as all_of and a single one in the original flat shape", () => {
    const h = as("EDITOR");
    load(h);
    const g = ok(h.call("rubrics.get", { tenant: A, rubric_id: "r1", version: 2 })) as { etag: string; draft: { criteria: Array<Record<string, unknown>> } };
    ok(h.call("rubrics.saveDraft", { tenant: A, rubric_id: "r1", version: 2, etag: g.etag, draft: g.draft }));
    const script = h.bq.calls.find((c) => /BEGIN TRANSACTION/.test(c.sql) && /UPDATE/.test(c.sql));
    const written = (script?.params.criteria as unknown as { v: Array<{ criterion_id: string; rule: string | null }> }).v;
    expect(JSON.parse(written.find((r) => r.criterion_id === "objections")!.rule!)).toEqual({ type: "all_of", rules: [SALES, OBJ] });
    const single = { ...g.draft, criteria: g.draft.criteria.map((c) => (c.criterion_id === "objections" ? { ...c, applicability_rule: { conditions: [SALES] } } : c)) };
    h.bq.calls.length = 0;
    const res = ok(h.call("rubrics.saveDraft", { tenant: A, rubric_id: "r1", version: 2, etag: g.etag, draft: single })) as { etag: string };
    expect(res.etag).not.toBe(g.etag);
    const again = h.bq.calls.find((c) => /BEGIN TRANSACTION/.test(c.sql) && /UPDATE/.test(c.sql));
    const flat = (again?.params.criteria as unknown as { v: Array<{ criterion_id: string; rule: string | null }> }).v;
    expect(JSON.parse(flat.find((r) => r.criterion_id === "objections")!.rule!)).toEqual({ type: "depends_on", ...SALES });
  });

  it("flags repeated gates and gates that carry their own rule, and refuses to publish them", () => {
    const h = as("ADMIN");
    h.bq.on(/FROM `[^`]*evaluation_rubrics` WHERE/, [{ rubric_id: "r1", version: 2, name: "Qual", status: "DRAFT", description: "" }]);
    const gated = { ...rows()[1], applicability_rule: storedRule({ conditions: [SALES] }) };
    h.bq.on(/FROM `[^`]*evaluation_criteria`/, [rows()[0], gated, { ...rows()[2], applicability_rule: storedRule({ conditions: [SALES, OBJ, SALES] }) }] as never);
    h.bq.on(/FROM `[^`]*evaluation_policies`/, [{ ...POLICY }]);
    const g = ok(h.call("rubrics.get", { tenant: A, rubric_id: "r1", version: 2 })) as { etag: string; issues: Array<{ message: string }> };
    const text = g.issues.map((i) => i.message).join(" | ");
    expect(text).toMatch(/só pode aparecer uma vez/);
    expect(text).toMatch(/não pode ter regra/);
    expect(code(h.call("rubrics.publish", { tenant: A, rubric_id: "r1", version: 2, etag: g.etag }))).toBe("INVALID_INPUT");
  });

  it("rejects a malformed conditions payload before any statement", () => {
    const h = as("EDITOR");
    load(h);
    const g = ok(h.call("rubrics.get", { tenant: A, rubric_id: "r1", version: 2 })) as { etag: string };
    const send = (rule: unknown) =>
      code(h.call("rubrics.saveDraft", { tenant: A, rubric_id: "r1", version: 2, etag: g.etag, draft: { name: "n", description: "", criteria: [CRIT(), { ...dep, applicability_rule: rule }], policy: POLICY } }));
    expect(send({ conditions: "x" })).toBe("INVALID_INPUT");
    expect(send({ conditions: [{ criterion_id: "is_sales" }] })).toBe("INVALID_INPUT");
    expect(send({ conditions: Array.from({ length: 6 }, () => SALES) })).toBe("INVALID_INPUT");
    expect(h.bq.calls.some((c) => /BEGIN TRANSACTION/.test(c.sql))).toBe(false);
  });
});
