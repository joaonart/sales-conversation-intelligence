import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/server/errors";
import { MAX_SUMMARY_PROMPT } from "../src/server/types";
import { A, code, harness, ok, type Harness } from "./helpers";

const as = (role: string): Harness => harness({ "ana@example.com": [[A, role]] });
const CRIT = {
  criterion_id: "greeting", criterion_name: "Saudação", evaluation_instructions: "Cumprimentou?", evaluation_type: "PREDICATE",
  weight: 10, required: false, enabled: true, score_mapping: { true: 100, false: 0 }, level_descriptions: {}, applicability_rule: null, display_order: 1,
};
const POLICY = {
  minimum_approval_score: 70, missing_evidence_policy: "NEEDS_REVIEW", max_analyses_per_session: null, max_input_tokens: null,
  monthly_budget_usd: null, min_messages: 3, min_customer_messages: 0, min_seller_messages: 0,
};
const draft = (over: Record<string, unknown> = {}) => ({ name: "Qual", description: "", criteria: [CRIT], policy: POLICY, ...over });

/** `prompt`: what the stored rubric has; `column: false` = the project whose table does not have the column yet (the read fails). */
function withRubric(h: Harness, opts: { status?: string; prompt?: string | null; column?: boolean } = {}): void {
  h.bq.on(/FROM `[^`]*evaluation_rubrics` WHERE/, [{ rubric_id: "r1", version: 2, name: "Qual", status: opts.status ?? "DRAFT", description: "" }]);
  h.bq.on(/SELECT summary_prompt FROM `[^`]*evaluation_rubrics`/, opts.column === false
    ? new AppError("UNAVAILABLE", "Falha ao consultar o BigQuery. Tente novamente.")
    : [{ summary_prompt: opts.prompt ?? null }]);
  const { level_descriptions: _levels, ...criterionRow } = CRIT;
  h.bq.on(/FROM `[^`]*evaluation_criteria`/, [{ ...criterionRow, score_mapping: JSON.stringify(CRIT.score_mapping), score_levels: null }]);
  h.bq.on(/FROM `[^`]*evaluation_policies`/, [{ ...POLICY }]);
}

const get = (h: Harness) => ok(h.call("rubrics.get", { tenant: A, rubric_id: "r1", version: 2 })) as { draft: { summary_prompt: string }; etag: string };
const save = (h: Harness, etag: string, d: unknown) => h.call("rubrics.saveDraft", { tenant: A, rubric_id: "r1", version: 2, etag, draft: d });

describe("the prompt of the general evaluation, a field of the rubric", () => {
  it("is read with the rubric and is part of its etag", () => {
    const h = as("EDITOR");
    withRubric(h, { prompt: "Destaque oportunidades." });
    const g = get(h);
    expect(g.draft.summary_prompt).toBe("Destaque oportunidades.");
    const h2 = as("EDITOR");
    withRubric(h2, { prompt: null });
    expect(get(h2).draft.summary_prompt).toBe("");
    expect(get(h2).etag).not.toBe(g.etag); // a change of the prompt is a change of the draft: a stale save is refused
  });

  it("a project whose table has no such column yet still opens every rubric (the prompt reads as none)", () => {
    const h = as("EDITOR");
    withRubric(h, { column: false });
    expect(get(h).draft.summary_prompt).toBe("");
  });

  it("is saved with the draft, as NULL when empty, and only named in the statement when there is something to write or to clear", () => {
    const h = as("EDITOR");
    withRubric(h, { prompt: null });
    const g = get(h);
    ok(save(h, g.etag, draft())); // never had one and still has none: the statement does not mention the column
    const plain = h.bq.calls.find((c) => /BEGIN TRANSACTION/.test(c.sql) && /UPDATE/.test(c.sql));
    expect(plain?.sql).not.toMatch(/summary_prompt/);
    expect(plain?.params.sp).toBeUndefined();

    const h2 = as("EDITOR");
    withRubric(h2, { prompt: null });
    ok(save(h2, get(h2).etag, draft({ summary_prompt: "  Faça uma avaliação geral.  " })));
    const written = h2.bq.calls.find((c) => /BEGIN TRANSACTION/.test(c.sql) && /UPDATE/.test(c.sql));
    expect(written?.sql).toMatch(/summary_prompt = NULLIF\(@sp, ''\)/);
    expect(written?.params.sp).toEqual({ t: "STRING", v: "Faça uma avaliação geral." }); // trimmed

    const h3 = as("EDITOR");
    withRubric(h3, { prompt: "Antigo" });
    ok(save(h3, get(h3).etag, draft({ summary_prompt: "" }))); // clearing it is a write too
    const cleared = h3.bq.calls.find((c) => /BEGIN TRANSACTION/.test(c.sql) && /UPDATE/.test(c.sql));
    expect(cleared?.sql).toMatch(/summary_prompt = NULLIF/);
    expect(cleared?.params.sp).toEqual({ t: "STRING", v: "" });
  });

  it("has a limit equal to the platform's, and a published rubric's prompt cannot be changed", () => {
    const python = readFileSync(new URL("../../../packages/evaluation-core/src/sci_core/rubric.py", import.meta.url), "utf8");
    expect(Number(python.match(/MAX_SUMMARY_PROMPT_CHARS = (\d+)/)?.[1])).toBe(MAX_SUMMARY_PROMPT);
    const h = as("EDITOR");
    withRubric(h);
    const g = get(h);
    expect(code(save(h, g.etag, draft({ summary_prompt: "x".repeat(MAX_SUMMARY_PROMPT + 1) })))).toBe("INVALID_INPUT");
    expect(code(save(h, g.etag, draft({ summary_prompt: 42 })))).toBe("INVALID_INPUT");
    expect(code(save(h, g.etag, draft({ summary_prompt: "x".repeat(MAX_SUMMARY_PROMPT) })))).toBe("OK");
    const p = as("ADMIN");
    withRubric(p, { status: "PUBLISHED", prompt: "Publicado" });
    expect(code(save(p, get(p).etag, draft({ summary_prompt: "Outro" })))).toBe("CONFLICT");
    expect(p.bq.calls.some((c) => /BEGIN TRANSACTION/.test(c.sql))).toBe(false);
  });

  it("a revision cloned from a version starts with that version's prompt (copied in its own statement, tenant-scoped)", () => {
    const h = as("EDITOR");
    withRubric(h, { status: "PUBLISHED", prompt: "Prompt da v2" });
    h.bq.on(/SELECT MAX\(version\)/, [{ version: 3 }]);
    expect(ok(h.call("rubrics.createDraft", { tenant: A, rubric_id: "r1", name: "Nova", cloneFromVersion: 2 }))).toEqual({ version: 3 });
    const copy = h.bq.calls.find((c) => /^UPDATE `[^`]*evaluation_rubrics` SET summary_prompt = @sp/.test(c.sql));
    expect(copy?.sql).toMatch(/organization_id = @org AND workspace_id = @ws AND rubric_id = @rid AND version = @ver AND status = 'DRAFT'/);
    expect(copy?.params.sp).toEqual({ t: "STRING", v: "Prompt da v2" });
    expect(copy?.params.ver).toEqual({ t: "INT64", v: 3 });
    // a clone of a rubric that has none, and a draft from scratch, issue no such statement
    const h2 = as("EDITOR");
    withRubric(h2, { status: "PUBLISHED", prompt: null });
    h2.bq.on(/SELECT MAX\(version\)/, [{ version: 3 }]);
    ok(h2.call("rubrics.createDraft", { tenant: A, rubric_id: "r1", name: "Nova", cloneFromVersion: 2 }));
    expect(h2.bq.calls.some((c) => /^UPDATE `[^`]*evaluation_rubrics` SET summary_prompt/.test(c.sql))).toBe(false);
  });
});

describe("the general evaluation on the session", () => {
  const SESSION = [{ session_id: "s1", channel: "whatsapp", status: "closed", started_at: "2026-01-02T00:00:00.000Z" }];
  const SUMMARY = {
    analysis_id: "a1", summary_prompt_hash: "abcd", model: "gpt-4o-mini", summarizer_version: "responses-summary-v1", generated_at: "2026-01-02T01:00:00.000Z",
    overall_summary: "Contato com a.b@c.com foi cordial.", strengths: '[{"text":"Cordial","message_ids":["m2"]}]', weaknesses: "[]",
    opportunities: '[{"text":"Falar com 123.456.789-09","message_ids":[]}]',
  };
  function session(h: Harness): void {
    h.bq.on(/FROM `[^`]*sessions` WHERE/, SESSION);
    h.bq.on(/FROM `[^`]*current_session_results`/, [{ analysis_id: "a1", rubric_id: "r1", rubric_version: 2, analysis_status: "COMPLETED", overall_score: 70 }]);
  }

  it("is returned with the session, tenant-scoped, one per analysis, and masked again on the way out", () => {
    const h = as("VIEWER");
    session(h);
    h.bq.on(/FROM `[^`]*session_summaries`/, [SUMMARY]);
    const d = ok(h.call("sessions.get", { tenant: A, sessionId: "s1" })) as { summaries: Array<Record<string, string>> };
    expect(d.summaries).toHaveLength(1);
    expect(d.summaries[0]?.overall_summary).toBe("Contato com [EMAIL] foi cordial.");
    expect(d.summaries[0]?.opportunities).toContain("[CPF]");
    expect(JSON.stringify(d.summaries)).not.toMatch(/a\.b@c\.com|123\.456/);
    const q = h.bq.calls.find((c) => /FROM `[^`]*session_summaries`/.test(c.sql));
    expect(q?.sql).toMatch(/organization_id = @org AND workspace_id = @ws/);
    expect(q?.sql).toMatch(/generated_at >= TIMESTAMP_SUB\(@lo, INTERVAL 1 DAY\)/); // partition-bounded, like the criteria
    expect(q?.sql).toMatch(/QUALIFY ROW_NUMBER\(\) OVER \(PARTITION BY analysis_id ORDER BY generated_at DESC\) = 1/);
  });

  it("is absent, never an error, before the table exists or when its read fails", () => {
    const h = as("VIEWER");
    session(h);
    h.bq.on(/FROM `[^`]*session_summaries`/, new AppError("UNAVAILABLE", "Falha ao consultar o BigQuery. Tente novamente."));
    expect((ok(h.call("sessions.get", { tenant: A, sessionId: "s1" })) as { summaries: unknown[] }).summaries).toEqual([]);
  });

  it("is not even looked for when the session has no analysis", () => {
    const h = as("VIEWER");
    h.bq.on(/FROM `[^`]*sessions` WHERE/, SESSION);
    ok(h.call("sessions.get", { tenant: A, sessionId: "s1" }));
    expect(h.bq.calls.some((c) => /session_summaries/.test(c.sql))).toBe(false);
  });
});
