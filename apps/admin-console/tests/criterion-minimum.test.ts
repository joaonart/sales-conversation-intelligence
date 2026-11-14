import { describe, expect, it } from "vitest";
import { AppError } from "../src/server/errors";
import { sanitizeReason } from "../src/server/reason";
import { A, code, harness, ok, type Harness } from "./helpers";

const as = (role: string): Harness => harness({ "ana@example.com": [[A, role]] });
const CRIT = {
  criterion_id: "needs", criterion_name: "Necessidade", evaluation_instructions: "Identificou?", evaluation_type: "SCORE",
  weight: 25, required: true, enabled: true, score_mapping: { none: 0, partial: 50, complete: 100 }, level_descriptions: {}, applicability_rule: null, display_order: 1,
};
const POLICY = {
  minimum_approval_score: 70, missing_evidence_policy: "NEEDS_REVIEW", max_analyses_per_session: null, max_input_tokens: null,
  monthly_budget_usd: null, min_messages: 3, min_customer_messages: 0, min_seller_messages: 0,
};
const draft = (minimum: number | null) => ({ name: "Qual", description: "", criteria: [{ ...CRIT, minimum_score: minimum }], policy: POLICY });

/** `minimum`: what the stored criterion has; `column: false` = the project whose table does not have the column yet (the read fails). */
function withRubric(h: Harness, opts: { minimum?: number | null; column?: boolean; status?: string } = {}): void {
  h.bq.on(/FROM `[^`]*evaluation_rubrics` WHERE/, [{ rubric_id: "r1", version: 2, name: "Qual", status: opts.status ?? "DRAFT", description: "" }]);
  h.bq.on(/SELECT summary_prompt FROM `[^`]*evaluation_rubrics`/, [{ summary_prompt: null }]);
  const { level_descriptions: _levels, ...row } = CRIT;
  h.bq.on(/FROM `[^`]*evaluation_criteria`/, [{ ...row, score_mapping: JSON.stringify(CRIT.score_mapping), score_levels: null }]);
  h.bq.on(
    /SELECT criterion_id, minimum_score FROM `[^`]*evaluation_criteria`/,
    opts.column === false
      ? new AppError("UNAVAILABLE", "Falha ao consultar o BigQuery. Tente novamente.")
      : opts.minimum === undefined || opts.minimum === null
        ? []
        : [{ criterion_id: "needs", minimum_score: opts.minimum }],
  );
  h.bq.on(/FROM `[^`]*evaluation_policies`/, [{ ...POLICY }]);
}

type Got = { draft: { criteria: Array<{ minimum_score: number | null }> }; etag: string; issues: unknown[] };
const get = (h: Harness) => ok(h.call("rubrics.get", { tenant: A, rubric_id: "r1", version: 2 })) as Got;
const save = (h: Harness, etag: string, d: unknown) => h.call("rubrics.saveDraft", { tenant: A, rubric_id: "r1", version: 2, etag, draft: d });
const script = (h: Harness) => h.bq.calls.find((c) => /BEGIN TRANSACTION/.test(c.sql) && /UPDATE/.test(c.sql));

describe("the minimum score of a required criterion", () => {
  it("is read with the rubric (null when none) and is part of the etag", () => {
    const h = as("EDITOR");
    withRubric(h, { minimum: 60 });
    const g = get(h);
    expect(g.draft.criteria[0]?.minimum_score).toBe(60);
    const none = as("EDITOR");
    withRubric(none, { minimum: null });
    const n = get(none);
    expect(n.draft.criteria[0]?.minimum_score).toBeNull();
    expect(n.etag).not.toBe(g.etag); // a change of the minimum is a change of the draft: a stale save is refused
  });

  it("a project whose table has no such column yet still opens every rubric (the minimum reads as none)", () => {
    const h = as("EDITOR");
    withRubric(h, { column: false });
    expect(get(h).draft.criteria[0]?.minimum_score).toBeNull();
  });

  it("only a failed query is taken for 'no column': any other error still surfaces", () => {
    const h = as("EDITOR");
    withRubric(h);
    h.bq.on(/SELECT criterion_id, minimum_score FROM `[^`]*evaluation_criteria`/, new AppError("FORBIDDEN", "sem permissão"));
    expect(code(h.call("rubrics.get", { tenant: A, rubric_id: "r1", version: 2 }))).toBe("FORBIDDEN");
  });

  it("a draft that never had a minimum keeps the etag it had before the field existed", () => {
    const h = as("EDITOR");
    withRubric(h, { minimum: null });
    const g = get(h);
    const { criteria } = g.draft as { criteria: Array<Record<string, unknown>> };
    // what the old console computed: the same draft without the field at all
    const legacy = { ...g.draft, criteria: criteria.map(({ minimum_score: _m, ...c }) => c) };
    const res = ok(save(h, g.etag, legacy)) as { etag: string };
    expect(res.etag).toBe(g.etag);
  });

  it("is saved with the draft, and the column is named only when some criterion has a minimum", () => {
    const h = as("EDITOR");
    withRubric(h, { minimum: null });
    const g = get(h);
    ok(save(h, g.etag, draft(null))); // none: the statement does not mention the column (it saves as before the column existed)
    const plain = script(h);
    expect(plain?.sql).not.toMatch(/minimum_score/);

    const h2 = as("EDITOR");
    withRubric(h2, { minimum: null });
    ok(save(h2, get(h2).etag, draft(60)));
    const written = script(h2);
    expect(written?.sql).toMatch(/INSERT INTO `[^`]*evaluation_criteria` \([^)]*, display_order, minimum_score\) SELECT [^;]*c\.display_order, c\.minimum_score FROM UNNEST/);
    const rows = (written?.params.criteria as unknown as { v: Array<{ criterion_id: string; minimum_score: number | null }>; fields: Record<string, string> });
    expect(rows.fields.minimum_score).toBe("FLOAT64");
    expect(rows.v[0]?.minimum_score).toBe(60);
  });

  it("zero is a real minimum, not 'none'", () => {
    const h = as("EDITOR");
    withRubric(h, { minimum: null });
    ok(save(h, get(h).etag, draft(0)));
    const rows = (script(h)?.params.criteria as unknown as { v: Array<{ minimum_score: number | null }> }).v;
    expect(rows[0]?.minimum_score).toBe(0);
    expect(script(h)?.sql).toMatch(/minimum_score/);
  });

  it("is refused out of range, on an optional criterion, or above the best answer (a draft may still be saved incomplete: the issue is reported)", () => {
    const h = as("EDITOR");
    withRubric(h, { minimum: null });
    const g = get(h);
    expect(code(save(h, g.etag, draft(101)))).toBe("INVALID_INPUT"); // out of range: the value itself is refused
    const optional = { ...draft(50), criteria: [{ ...CRIT, required: false, minimum_score: 50 }] };
    const r1 = ok(save(h, g.etag, optional)) as { issues: Array<{ message: string }> };
    expect(r1.issues.map((i) => i.message).join()).toMatch(/só vale para critério obrigatório/);
    const unreachable = { ...draft(80), criteria: [{ ...CRIT, score_mapping: { none: 0, partial: 50 }, minimum_score: 80 }] };
    const r2 = ok(save(h, g.etag, unreachable)) as { issues: Array<{ message: string }> };
    expect(r2.issues.map((i) => i.message).join()).toMatch(/nunca passaria/);
  });

  it("a new revision cloned from a version copies the minimum of each criterion (one small statement per criterion that has one)", () => {
    const h = as("EDITOR");
    withRubric(h, { minimum: 60 });
    h.bq.on(/SELECT MAX\(version\)/, [{ version: 3 }]);
    ok(h.call("rubrics.createDraft", { tenant: A, rubric_id: "r1", name: "Nova", cloneFromVersion: 2 }));
    const update = h.bq.calls.find((c) => /UPDATE `[^`]*evaluation_criteria` SET minimum_score = @m/.test(c.sql));
    expect(update?.params.m).toEqual({ t: "FLOAT64", v: 60 });
    expect(update?.params.cid).toEqual({ t: "STRING", v: "needs" });
    expect(update?.params.ver).toEqual({ t: "INT64", v: 3 });
    // the clone's main statement does not name the column, so it also works before the schema has it
    expect(h.bq.calls.find((c) => /DECLARE next_ver/.test(c.sql))?.sql).not.toMatch(/minimum_score/);
  });

  it("a clone of a version with no minimum issues no extra statement", () => {
    const h = as("EDITOR");
    withRubric(h, { minimum: null });
    h.bq.on(/SELECT MAX\(version\)/, [{ version: 3 }]);
    ok(h.call("rubrics.createDraft", { tenant: A, rubric_id: "r1", name: "Nova", cloneFromVersion: 2 }));
    expect(h.bq.calls.some((c) => /SET minimum_score/.test(c.sql))).toBe(false);
  });

  it("the stored reason keeps the minimum of the criterion that was below it (and still drops anything unknown)", () => {
    const r = sanitizeReason({ minimum: 70, overall: 87.5, reasons: [{ code: "REQUIRED_CRITERION_BELOW_MINIMUM", criterion_id: "needs", score: 50, minimum: 60, other: "x" }] });
    expect(r?.reasons[0]).toEqual({ code: "REQUIRED_CRITERION_BELOW_MINIMUM", criterion_id: "needs", score: 50, minimum: 60 });
    // an analysis scored before criteria had a minimum carries none
    expect(sanitizeReason({ minimum: 70, overall: 87.5, reasons: [{ code: "REQUIRED_CRITERION_BELOW_MINIMUM", criterion_id: "needs", score: 50 }] })?.reasons[0]).toEqual({
      code: "REQUIRED_CRITERION_BELOW_MINIMUM", criterion_id: "needs", score: 50,
    });
  });
});
