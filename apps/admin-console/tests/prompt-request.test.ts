import { describe, expect, it } from "vitest";
import { MODEL_CATALOG } from "../src/server/services/executions";
import { MAX_ACTIVE_REQUESTS, MIN_SAMPLE, PROMPT_MAX_CHARS, PROMPT_MIN_CHARS } from "../src/server/services/promptImprovement";
import { A, B, code, harness, ok, type Call, type Harness } from "./helpers";

const as = (role: string): Harness => harness({ "ana@example.com": [[A, role]], "bia@example.com": [[A, "VIEWER"]], "edu@example.com": [[A, "EDITOR"]], "carla@example.com": [[B, "ADMIN"]] });
const PROMPT = "Você é um agente de vendas de uma loja de calçados. Cumprimente o cliente pelo nome, descubra a necessidade antes de oferecer um produto e trate objeções com calma.";
const scope = { tenant: A, rubric_id: "sales_quality", version: 5, from: "2026-10-15", to: "2026-11-14" };
const body = (extra: Record<string, unknown> = {}) => ({ ...scope, prompt: PROMPT, max_cost_usd: 0.5, ...extra });
const estimate = (h: Harness, extra: Record<string, unknown> = {}, who = "ana@example.com") => h.call("promptImprovement.estimate", body(extra), who);
const request = (h: Harness, extra: Record<string, unknown> = {}, who = "ana@example.com") => h.call("promptImprovement.request", body({ confirm: true, ...extra }), who);

/** The numbers the preview reads (a rubric of three criteria and `analyses` analyses), as in the stage 1 tests. */
function withData(h: Harness, o: { analyses?: number } = {}): void {
  const analyses = o.analyses ?? 40;
  h.bq.on(/SELECT name FROM `[^`]*evaluation_rubrics`/, [{ name: "Qualidade comercial" }]);
  h.bq.on(/FROM `[^`]*evaluation_criteria`/, [
    { criterion_id: "is_sales", criterion_name: "É uma conversa de venda?", weight: 0, required: false },
    { criterion_id: "needs", criterion_name: "Necessidade", weight: 25, required: true },
    { criterion_id: "greeting", criterion_name: "Saudação", weight: 10, required: false },
  ]);
  h.bq.on(/SELECT criterion_id, minimum_score FROM `[^`]*evaluation_criteria`/, [{ criterion_id: "needs", minimum_score: 60 }]);
  h.bq.on(/AVG\(overall_score\) AS avg_score/, [{ analyses, sessions: analyses - 2, avg_score: 61.2, approved: 20, rejected: 12, needs_review: 8 }]);
  h.bq.on(/AS below_minimum_n/, [
    { criterion_id: "needs", evaluations: analyses, applicable: 36, avg_score: 44.4, weak_n: 24, weighted_n: 36, insufficient_n: 2, not_applicable_n: 2, below_minimum_n: 24, lost_sum: 600 },
    { criterion_id: "greeting", evaluations: analyses, applicable: 20, avg_score: 85, weak_n: 1, weighted_n: 20, insufficient_n: 0, not_applicable_n: 20, below_minimum_n: 0, lost_sum: 80 },
  ]);
  h.bq.on(/SELECT criterion_id, answer, COUNT/, [{ criterion_id: "needs", answer: "none", n: 14 }]);
}

const inserts = (h: Harness, table: string): Call[] => h.bq.calls.filter((c) => new RegExp(`INSERT INTO \`[^\`]*${table}\``).test(c.sql));
const p = (c: Call, name: string): unknown => (c.params[name] as { v: unknown } | undefined)?.v;
const deletes = (h: Harness): Call[] => h.bq.calls.filter((c) => /DELETE FROM `[^`]*agent_prompts`/.test(c.sql));

describe("who may do what", () => {
  const editorCalls: Array<[string, Record<string, unknown>]> = [
    ["promptImprovement.models", {}],
    ["promptImprovement.estimate", body()],
    ["promptImprovement.prompts", {}],
    ["promptImprovement.prompt", { prompt_id: "pr-1" }],
  ];
  const adminCalls: Array<[string, Record<string, unknown>]> = [
    ["promptImprovement.requests", {}],
    ["promptImprovement.request", body({ confirm: true })],
    ["promptImprovement.cancel", { request_id: "req-1" }],
  ];

  it("a VIEWER is refused on every one and nothing is queried", () => {
    for (const [method, payload] of [...editorCalls, ...adminCalls]) {
      const h = as("EDITOR");
      expect(code(h.call(method, { tenant: A, ...payload }, "bia@example.com")), method).toBe("FORBIDDEN");
      expect(h.bq.dataCalls(), method).toHaveLength(0);
    }
  });

  it("an EDITOR may paste a prompt, read the models and see the estimate, but only an ADMIN may authorise the spend (as with an execution)", () => {
    for (const [method, payload] of editorCalls) {
      const h = as("EDITOR");
      withData(h);
      h.bq.on(/SELECT prompt_id, name, version, content/, [{ prompt_id: "pr-1", name: "Loja", version: 1, content: PROMPT, content_hash: "h" }]);
      expect(code(h.call(method, { tenant: A, ...payload }, "edu@example.com")), method).toBe("OK");
    }
    for (const [method, payload] of adminCalls) {
      const h = as("EDITOR");
      expect(code(h.call(method, { tenant: A, ...payload }, "edu@example.com")), method).toBe("FORBIDDEN");
      expect(h.bq.dataCalls(), method).toHaveLength(0);
    }
  });

  it("a person of another workspace is refused", () => {
    for (const [method, payload] of [...editorCalls, ...adminCalls]) expect(code(as("ADMIN").call(method, { tenant: A, ...payload }, "carla@example.com")), method).toBe("FORBIDDEN");
  });
});

describe("the estimate", () => {
  it("sizes ONE call over the rules, the prompt and the aggregate; the worst case adds one block per criterion; it writes and spends nothing", () => {
    const h = as("EDITOR");
    withData(h);
    const e = ok(estimate(h, { model: "gpt-4o" }, "edu@example.com")) as Record<string, number | boolean | string | string[]>;
    expect(e.provider).toBe("responses");
    expect(e.model).toBe("gpt-4o");
    expect(e.prompt_chars).toBe(PROMPT.length);
    expect(e.prompt_tokens).toBe(Math.ceil(PROMPT.length / 4));
    expect(e.approx_input_tokens).toBe(Number(e.system_tokens) + Number(e.prompt_tokens) + Number(e.aggregate_tokens));
    expect(e.approx_output_tokens).toBe(3 * 450 + 400); // three criteria
    expect(e.estimate_low_usd).toBeCloseTo((Number(e.approx_input_tokens) * 2.5) / 1e6, 5);
    expect(Number(e.estimate_high_usd) - Number(e.estimate_low_usd)).toBeCloseTo((Number(e.approx_output_tokens) * 10) / 1e6, 5);
    expect(e.within_ceiling).toBe(true);
    expect(e.enough).toBe(true);
    expect(h.bq.calls.some((c) => /INSERT|DELETE|UPDATE/.test(c.sql) && !/audit_log/.test(c.sql))).toBe(false);
  });

  it("never reads a conversation: no statement touches the messages", () => {
    const h = as("EDITOR");
    withData(h);
    ok(estimate(h));
    expect(h.bq.calls.some((c) => /`[^`]*\.messages`/.test(c.sql))).toBe(false);
  });

  it("says whether the ceiling covers the worst case, and a sample that is too thin", () => {
    const h = as("EDITOR");
    withData(h, { analyses: MIN_SAMPLE - 1 });
    const e = ok(estimate(h, { max_cost_usd: 0.0001 })) as { within_ceiling: boolean; enough: boolean };
    expect(e.within_ceiling).toBe(false);
    expect(e.enough).toBe(false);
  });

  it("a longer prompt costs more; a model that is not validated says so", () => {
    const h = as("EDITOR");
    withData(h);
    const short = ok(estimate(h)) as { estimate_high_usd: number };
    const long = ok(estimate(h, { prompt: PROMPT.repeat(20) })) as { estimate_high_usd: number };
    expect(long.estimate_high_usd).toBeGreaterThan(short.estimate_high_usd);
    const mini = ok(estimate(h, { model: "gpt-4o-mini" })) as { validated: boolean; notes: string[] };
    expect(mini.validated).toBe(false);
    expect(mini.notes.join(" ")).toContain("ainda não foi validado");
  });

  it("offers only the models that write free text (the Responses API ones of the closed catalog), the validated one first", () => {
    const h = as("EDITOR");
    const m = ok(h.call("promptImprovement.models", { tenant: A }, "edu@example.com")) as { models: Array<{ provider: string; model: string }>; default: string; min_chars: number; max_chars: number; min_sample: number; ceiling_usd: number };
    expect(m.models.length).toBeGreaterThan(0);
    expect(new Set(m.models.map((x) => x.provider))).toEqual(new Set(["responses"]));
    expect(m.default).toBe("gpt-4o");
    expect([m.min_chars, m.max_chars, m.min_sample, m.ceiling_usd]).toEqual([PROMPT_MIN_CHARS, PROMPT_MAX_CHARS, MIN_SAMPLE, 1]);
  });

  it("refuses what is not valid: a short or long prompt, no prompt, a model of another API or unknown, a ceiling out of range", () => {
    const cases: Array<Record<string, unknown>> = [
      { prompt: "curto" }, { prompt: "x".repeat(PROMPT_MAX_CHARS + 1) }, { prompt: undefined }, { prompt: 42 }, { model: "gpt-6-luna" }, { model: "nope" },
      { max_cost_usd: 0 }, { max_cost_usd: 1.01 }, { max_cost_usd: "0,08" }, { max_cost_usd: undefined }, { rubric_id: "../x" }, { from: "2026-11-14", to: "2026-10-15" },
    ];
    for (const extra of cases) {
      const h = as("EDITOR");
      withData(h);
      expect(code(estimate(h, extra)), JSON.stringify(extra).slice(0, 60)).toBe("INVALID_INPUT");
    }
  });
});

describe("the request", () => {
  it("needs the confirmation, a sample of enough analyses and a ceiling above the worst case; none of them writes anything", () => {
    for (const [extra, setup] of [
      [{ confirm: false }, 40],
      [{}, MIN_SAMPLE - 1],
      [{ max_cost_usd: 0.0001 }, 40],
      [{ retain: true }, 40], // a kept prompt needs a name
    ] as Array<[Record<string, unknown>, number]>) {
      const h = as("ADMIN");
      withData(h, { analyses: setup });
      expect(code(request(h, extra)), JSON.stringify(extra)).toBe("INVALID_INPUT");
      expect(inserts(h, "agent_prompts").concat(inserts(h, "prompt_improvement_requests"))).toHaveLength(0);
    }
  });

  it("records the prompt for this request only (not kept) and the request with the sample, the estimate, the ceiling, the model and who asked", () => {
    const h = as("ADMIN");
    withData(h);
    const r = ok(request(h, { model: "gpt-4o", max_cost_usd: 0.4 })) as { request_id: string; status: string; prompt_id: string; prompt_version: number; prompt_hash: string; retained: boolean };
    expect(r.status).toBe("REQUESTED");
    expect(r.retained).toBe(false);
    expect(r.prompt_version).toBe(1);
    const [pr] = inserts(h, "agent_prompts");
    expect(p(pr!, "content")).toBe(PROMPT);
    expect(p(pr!, "retained")).toBe(false);
    expect(p(pr!, "name")).toBe("(sem nome)");
    expect(p(pr!, "hash")).toBe(r.prompt_hash);
    expect(p(pr!, "by")).toBe("ana@example.com");
    const [rq] = inserts(h, "prompt_improvement_requests");
    expect(rq!.sql).toContain("'REQUESTED'");
    expect([p(rq!, "rubric"), p(rq!, "ver"), p(rq!, "from"), p(rq!, "to"), p(rq!, "seller"), p(rq!, "pid"), p(rq!, "hash"), p(rq!, "analyses"), p(rq!, "sessions")]).toEqual([
      "sales_quality", 5, "2026-10-15", "2026-11-14", null, r.prompt_id, r.prompt_hash, 40, 38,
    ]);
    expect([p(rq!, "cap"), p(rq!, "provider"), p(rq!, "model"), p(rq!, "by")]).toEqual([0.4, "responses", "gpt-4o", "ana@example.com"]);
    expect(Number(p(rq!, "high"))).toBeGreaterThan(Number(p(rq!, "low")));
  });

  it("the text of the prompt reaches ONE statement (the one that stores it): not the request, not the audit trail", () => {
    const h = as("ADMIN");
    withData(h);
    ok(request(h, { retain: true, name: "Loja de calçados" }));
    const withText = h.bq.calls.filter((c) => JSON.stringify(c.params).includes("Cumprimente o cliente"));
    expect(withText).toHaveLength(1);
    expect(withText[0]!.sql).toContain("agent_prompts");
    const audit = h.bq.calls.find((c) => /INSERT INTO `[^`]*audit_log`/.test(c.sql) && p(c, "action") === "promptImprovement.request");
    expect(audit).toBeDefined();
    const details = String(p(audit!, "details"));
    expect(details).toContain("prompt_hash");
    expect(details).not.toContain("Cumprimente");
    expect(JSON.parse(details)).toMatchObject({ rubric_id: "sales_quality", rubric_version: 5, has_seller: false, retained: true });
    expect(p(audit!, "details")).not.toMatch(/prompt"?:/);
  });

  it("a kept prompt is found by its name: the same text is reused, a changed text is the next version of the same prompt, a new name is a new prompt", () => {
    const h = as("ADMIN");
    withData(h);
    // nothing kept under that name yet: a new prompt, version 1
    const first = ok(request(h, { retain: true, name: "Loja" })) as { prompt_id: string; prompt_version: number };
    expect(first.prompt_version).toBe(1);
    expect(inserts(h, "agent_prompts")).toHaveLength(1);
    // now the name exists with this text
    const sha = (h.bq.calls.find((c) => /INSERT INTO `[^`]*agent_prompts`/.test(c.sql)) as Call).params.hash as { v: string };
    const h2 = as("ADMIN");
    withData(h2);
    h2.bq.on(/FROM `[^`]*agent_prompts` WHERE .*LOWER\(name\)/, [{ prompt_id: "pr-kept", version: 3, content_hash: sha.v }]);
    const same = ok(request(h2, { retain: true, name: "loja" })) as { prompt_id: string; prompt_version: number };
    expect([same.prompt_id, same.prompt_version]).toEqual(["pr-kept", 3]);
    expect(inserts(h2, "agent_prompts")).toHaveLength(0); // nothing new to store
    const changed = ok(request(h2, { retain: true, name: "Loja", prompt: `${PROMPT} Nunca prometa prazo.` })) as { prompt_id: string; prompt_version: number };
    expect([changed.prompt_id, changed.prompt_version]).toEqual(["pr-kept", 4]);
    expect(p(inserts(h2, "agent_prompts")[0]!, "ver")).toBe(4);
  });

  it("holds at most 3 waiting requests per workspace and refuses an identical one; neither stores anything", () => {
    const waiting = (n: number) => Array.from({ length: n }, (_, k) => ({ request_id: `old-${k}`, rubric_id: "sales_quality", rubric_version: 5, period_from: "2026-01-01", period_to: "2026-01-31", seller_id: null, prompt_hash: `h${k}`, model: "gpt-4o" }));
    const full = as("ADMIN");
    withData(full);
    full.bq.on(/FROM `[^`]*prompt_improvement_requests` WHERE .*status IN \('REQUESTED'/, waiting(MAX_ACTIVE_REQUESTS));
    expect(code(request(full))).toBe("CONFLICT");
    expect(inserts(full, "agent_prompts")).toHaveLength(0);
    const h = as("ADMIN");
    withData(h);
    const hash = (ok(request(h)) as { prompt_hash: string }).prompt_hash;
    const dup = as("ADMIN");
    withData(dup);
    dup.bq.on(/FROM `[^`]*prompt_improvement_requests` WHERE .*status IN \('REQUESTED'/, [{ ...waiting(1)[0], period_from: "2026-10-15", period_to: "2026-11-14", prompt_hash: hash }]);
    expect(code(request(dup))).toBe("CONFLICT");
    expect(inserts(dup, "agent_prompts")).toHaveLength(0);
  });

  it("when the request cannot be recorded, the text of a prompt that was not kept is not left behind (a kept one stays)", () => {
    const h = as("ADMIN");
    withData(h);
    h.bq.on(/INSERT INTO `[^`]*prompt_improvement_requests`/, new Error("bq down"));
    expect(code(request(h))).not.toBe("OK");
    expect(deletes(h)).toHaveLength(1);
    expect(deletes(h)[0]!.sql).toContain("NOT retained");
    const kept = as("ADMIN");
    withData(kept);
    kept.bq.on(/INSERT INTO `[^`]*prompt_improvement_requests`/, new Error("bq down"));
    expect(code(request(kept, { retain: true, name: "Loja" }))).not.toBe("OK");
    expect(deletes(kept)).toHaveLength(0);
  });

  it("every statement is tenant scoped with bound parameters", () => {
    const h = as("ADMIN");
    withData(h);
    ok(request(h, { retain: true, name: "Loja" }));
    ok(h.call("promptImprovement.requests", { tenant: A }));
    ok(h.call("promptImprovement.prompts", { tenant: A }));
    for (const c of h.bq.dataCalls().filter((x) => /agent_prompts|prompt_improvement_requests/.test(x.sql))) {
      expect(c.params.org, c.sql).toEqual({ t: "STRING", v: "org-a" });
      expect(c.params.ws, c.sql).toEqual({ t: "STRING", v: "ws-a" });
      if (!/^INSERT INTO `[^`]*agent_prompts` \(/.test(c.sql) && !/VALUES/.test(c.sql)) expect(c.sql, c.sql).toContain("organization_id = @org AND workspace_id = @ws");
    }
  });
});

describe("cancelling a request", () => {
  const waiting = (h: Harness, status = "REQUESTED") => h.bq.on(/SELECT status, prompt_id FROM `[^`]*prompt_improvement_requests`/, [{ status, prompt_id: "pr-9" }]);

  it("writes a CANCELLED row only while the request is REQUESTED and deletes the text of a prompt that was not kept", () => {
    const h = as("ADMIN");
    waiting(h);
    const r = ok(h.call("promptImprovement.cancel", { tenant: A, request_id: "req-1" })) as { status: string; prompt_deleted: boolean };
    expect([r.status, r.prompt_deleted]).toEqual(["CANCELLED", true]);
    const [ins] = inserts(h, "prompt_improvement_requests");
    expect(ins!.sql).toContain("'CANCELLED'");
    expect(ins!.sql).toContain("WHERE status = 'REQUESTED'"); // the guard is in the statement itself
    expect(deletes(h)).toHaveLength(1);
    expect(deletes(h)[0]!.sql).toContain("NOT retained");
    expect(p(deletes(h)[0]!, "pid")).toBe("pr-9");
  });

  it("refuses a request that is already running or finished, and one that does not exist", () => {
    for (const status of ["RUNNING", "COMPLETED", "CANCELLED", "FAILED"]) {
      const h = as("ADMIN");
      waiting(h, status);
      expect(code(h.call("promptImprovement.cancel", { tenant: A, request_id: "req-1" })), status).toBe("CONFLICT");
      expect(inserts(h, "prompt_improvement_requests")).toHaveLength(0);
      expect(deletes(h)).toHaveLength(0);
    }
    expect(code(as("ADMIN").call("promptImprovement.cancel", { tenant: A, request_id: "nope" }))).toBe("NOT_FOUND");
  });

  it("is cancelled even if the text could not be deleted, and says so", () => {
    const h = as("ADMIN");
    waiting(h);
    h.bq.on(/DELETE FROM `[^`]*agent_prompts`/, new Error("bq down"));
    const r = ok(h.call("promptImprovement.cancel", { tenant: A, request_id: "req-1" })) as { status: string; prompt_deleted: boolean };
    expect([r.status, r.prompt_deleted]).toEqual(["CANCELLED", false]);
  });
});

describe("listing and reading", () => {
  it("lists the requests with the name of their prompt, and the kept prompts without their text", () => {
    const h = as("ADMIN");
    h.bq.on(/WITH latest AS/, [
      { request_id: "req-1", status: "REQUESTED", rubric_id: "sales_quality", rubric_version: 5, period_from: "2026-10-15", period_to: "2026-11-14", seller_id: null, prompt_id: "pr-1", prompt_name: "Loja", retained: true,
        max_cost_usd: 0.4, estimate_low_usd: 0.01, estimate_high_usd: 0.03, actual_cost_usd: null, provider: "responses", model: "gpt-4o", requested_by: "ana@example.com",
        requested_at: "2026-11-16 12:00:00", changed_at: "2026-11-16 12:00:00", error: null },
    ]);
    h.bq.on(/COUNT\(\*\) OVER \(PARTITION BY prompt_id\) AS versions/, [{ prompt_id: "pr-1", name: "Loja", version: 2, versions: 2, created_by: "ana@example.com", created_at: "2026-11-16 12:00:00" }]);
    const list = ok(h.call("promptImprovement.requests", { tenant: A })) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ request_id: "req-1", status: "REQUESTED", prompt_name: "Loja", retained: true, max_cost_usd: 0.4, model: "gpt-4o", actual_cost_usd: null });
    const kept = ok(h.call("promptImprovement.prompts", { tenant: A })) as Array<Record<string, unknown>>;
    expect(kept).toEqual([{ prompt_id: "pr-1", name: "Loja", version: 2, versions: 2, created_by: "ana@example.com", created_at: "2026-11-16 12:00:00" }]);
    expect(JSON.stringify(kept)).not.toContain("content");
    expect(h.bq.calls.find((c) => /COUNT\(\*\) OVER/.test(c.sql))!.sql).not.toContain("content");
  });

  it("opening a kept prompt is audited (ids, version, hash, size; never the text) and fails closed", () => {
    const row = [{ prompt_id: "pr-1", name: "Loja", version: 2, content: PROMPT, content_hash: "abc123" }];
    const h = as("EDITOR");
    h.bq.on(/SELECT prompt_id, name, version, content, content_hash/, row);
    const r = ok(h.call("promptImprovement.prompt", { tenant: A, prompt_id: "pr-1" }, "edu@example.com")) as { content: string; version: number };
    expect([r.content, r.version]).toEqual([PROMPT, 2]);
    const audit = h.bq.calls.find((c) => /INSERT INTO `[^`]*audit_log`/.test(c.sql) && p(c, "action") === "promptImprovement.openPrompt")!;
    expect(p(audit, "eid")).toBe("pr-1");
    expect(JSON.parse(String(p(audit, "details")))).toEqual({ version: 2, prompt_hash: "abc123", chars: PROMPT.length });
    expect(String(p(audit, "details"))).not.toContain("Cumprimente");
    const broken = as("EDITOR");
    broken.bq.on(/SELECT prompt_id, name, version, content, content_hash/, row);
    broken.bq.on(/INSERT INTO `[^`]*audit_log`/, new Error("audit down"));
    const denied = broken.call("promptImprovement.prompt", { tenant: A, prompt_id: "pr-1" }, "edu@example.com");
    expect(denied.ok).toBe(false);
    expect(JSON.stringify(denied)).not.toContain("Cumprimente");
  });

  it("a prompt that is not kept, or does not exist, cannot be opened", () => {
    const h = as("EDITOR");
    expect(code(h.call("promptImprovement.prompt", { tenant: A, prompt_id: "pr-gone" }, "edu@example.com"))).toBe("NOT_FOUND");
    expect(h.bq.calls.find((c) => /FROM `[^`]*agent_prompts`/.test(c.sql))!.sql).toContain("AND retained");
  });
});

describe("the numbers the request carries", () => {
  it("are stored with the request: the preview without its examples, no conversation text, the seller only as a flag", () => {
    const h = as("ADMIN");
    withData(h);
    ok(request(h, { seller: "vendedor-secreto" }));
    const [rq] = inserts(h, "prompt_improvement_requests");
    expect(rq!.sql).toContain("PARSE_JSON(@aggregate)");
    const text = String(p(rq!, "aggregate"));
    const agg = JSON.parse(text) as { rubric: unknown; sample: { analyses: number }; seller_filter: boolean; criteria: Array<{ criterion_id: string; points_lost: number; answers: unknown[] }> };
    expect(agg.rubric).toEqual({ name: "Qualidade comercial", version: 5 });
    expect(agg.sample.analyses).toBe(40);
    expect(agg.criteria.map((c) => c.criterion_id)).toEqual(["needs", "greeting", "is_sales"]); // most points lost first, the gate last
    expect(agg.criteria[0]!.answers).toEqual([{ answer: "none", n: 14 }]); // the answers are the rubric's own option labels
    expect(agg.seller_filter).toBe(true);
    expect(text).not.toContain("vendedor-secreto"); // the seller is not sent, only that a filter was applied
    expect(text).not.toContain("Cumprimente"); // nor the prompt
    expect(h.bq.calls.some((c) => /`[^`]*\.messages`/.test(c.sql))).toBe(false); // nor any conversation: no statement reads one
  });

  it("go on being carried when the request is cancelled (every row of a request has them)", () => {
    const h = as("ADMIN");
    h.bq.on(/SELECT status, prompt_id FROM `[^`]*prompt_improvement_requests`/, [{ status: "REQUESTED", prompt_id: "pr-9" }]);
    ok(h.call("promptImprovement.cancel", { tenant: A, request_id: "req-1" }));
    const [ins] = inserts(h, "prompt_improvement_requests");
    expect(ins!.sql).toMatch(/, error, aggregate\) /);
    expect(ins!.sql).toMatch(/@by, NULL, aggregate FROM/);
  });

  it("the estimate is sized with the catalog's numbers, the ones the executor's gate uses", () => {
    const h = as("EDITOR");
    withData(h);
    const e = ok(estimate(h, {}, "edu@example.com")) as { approx_output_tokens: number; system_tokens: number };
    const { system_tokens, out_tokens_per_criterion, out_tokens_overall } = MODEL_CATALOG.suggestion;
    expect(e.system_tokens).toBe(system_tokens);
    expect(e.approx_output_tokens).toBe(3 * out_tokens_per_criterion + out_tokens_overall);
  });
});

describe("opening the suggestions of a request", () => {
  const RESULT = {
    status: "COMPLETED", requested_by: "ana@example.com", requested_at: "2026-11-16 12:00:00", model: "gpt-4o", system_prompt_version: "responses-suggestion-v1", input_tokens: 1700, output_tokens: 900,
    cost_usd: 0.01325, created_at: "2026-11-16 12:11:00",
    suggestions: JSON.stringify({ overall: "Foque na necessidade.", priorities: ["needs"], criteria: [{ criterion_id: "needs", diagnosis: "66,7% fracas.", changes: [{ kind: "ADD", text: "Pergunte o uso." }] }] }),
    aggregate: JSON.stringify({ criteria: [{ criterion_id: "needs", name: "Necessidade" }, { criterion_id: "greeting", name: "Saudação" }] }),
  };
  const open = (h: Harness, who = "ana@example.com") => h.call("promptImprovement.result", { tenant: A, request_id: "pir-1" }, who);

  it("is for an ADMIN, like the list of requests", () => {
    for (const who of ["bia@example.com", "edu@example.com"]) {
      const h = as("EDITOR");
      expect(code(open(h, who))).toBe("FORBIDDEN");
      expect(h.bq.dataCalls()).toHaveLength(0);
    }
  });

  it("returns the suggestions with the names of the criteria, the model, the tokens and what it cost", () => {
    const h = as("ADMIN");
    h.bq.on(/WITH latest AS \(SELECT request_id, status, model/, [RESULT]);
    const r = ok(open(h)) as { suggestions: { overall: string; criteria: Array<{ criterion_id: string }> }; names: Record<string, string>; model: string; version: string; cost_usd: number; input_tokens: number; status: string };
    expect(r.suggestions.overall).toBe("Foque na necessidade.");
    expect(r.suggestions.criteria[0]!.criterion_id).toBe("needs");
    expect(r.names).toEqual({ needs: "Necessidade", greeting: "Saudação" });
    expect([r.model, r.version, r.cost_usd, r.input_tokens, r.status]).toEqual(["gpt-4o", "responses-suggestion-v1", 0.01325, 1700, "COMPLETED"]);
    const q = h.bq.calls.find((c) => /WITH latest AS \(SELECT request_id, status, model/.test(c.sql))!;
    expect(q.sql).toContain("organization_id = @org AND workspace_id = @ws");
    expect(q.sql).toContain("r.organization_id = @org AND r.workspace_id = @ws"); // the join of the results is scoped too
    expect(q.params.org).toEqual({ t: "STRING", v: "org-a" });
  });

  it("is audited with the request and a count, never the text, and fails closed", () => {
    const h = as("ADMIN");
    h.bq.on(/WITH latest AS \(SELECT request_id, status, model/, [RESULT]);
    ok(open(h));
    const audit = h.bq.calls.find((c) => /INSERT INTO `[^`]*audit_log`/.test(c.sql) && p(c, "action") === "promptImprovement.openResult")!;
    expect([p(audit, "etype"), p(audit, "eid")]).toEqual(["prompt_request", "pir-1"]);
    expect(JSON.parse(String(p(audit, "details")))).toEqual({ criteria: 1 });
    expect(String(p(audit, "details"))).not.toContain("necessidade");
    const broken = as("ADMIN");
    broken.bq.on(/WITH latest AS \(SELECT request_id, status, model/, [RESULT]);
    broken.bq.on(/INSERT INTO `[^`]*audit_log`/, new Error("audit down"));
    const denied = open(broken);
    expect(denied.ok).toBe(false);
    expect(JSON.stringify(denied)).not.toContain("Foque na necessidade");
  });

  it("says so when the request does not exist or has no suggestions (yet, or ever)", () => {
    const none = as("ADMIN");
    expect(code(open(none))).toBe("NOT_FOUND");
    const waiting = as("ADMIN");
    waiting.bq.on(/WITH latest AS \(SELECT request_id, status, model/, [{ ...RESULT, status: "REQUESTED", suggestions: null }]);
    const r = open(waiting);
    expect(code(r)).toBe("NOT_FOUND");
    expect(JSON.stringify(r)).toContain("ainda não tem sugestões");
  });

  it("a result that cannot be read is reported, not half shown", () => {
    const h = as("ADMIN");
    h.bq.on(/WITH latest AS \(SELECT request_id, status, model/, [{ ...RESULT, suggestions: "not json" }]);
    expect(code(open(h))).toBe("INVALID_INPUT");
    expect(h.bq.calls.some((c) => /audit_log/.test(c.sql))).toBe(false); // nothing was released, so nothing is audited as read
  });
});
