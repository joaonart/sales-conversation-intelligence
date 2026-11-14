import { describe, expect, it } from "vitest";
import { WEIGHT_TOTAL, coreValid, validateCriteria, weightTotalIssue } from "../src/server/rubricRules";
import type { CriterionInput } from "../src/server/types";
import { A, code, harness, ok, type Harness } from "./helpers";

const as = (role: string): Harness => harness({ "ana@example.com": [[A, role]] });
const crit = (id: string, weight: number, over: Partial<CriterionInput> = {}): CriterionInput => ({
  criterion_id: id, criterion_name: id, evaluation_instructions: "pergunta?", evaluation_type: "PREDICATE", weight, required: false, minimum_score: null, enabled: true,
  score_mapping: { true: 100, false: 0 }, level_descriptions: {}, applicability_rule: null, display_order: 1, ...over,
});
const POLICY = {
  minimum_approval_score: 70, missing_evidence_policy: "NEEDS_REVIEW", max_analyses_per_session: null, max_input_tokens: null,
  monthly_budget_usd: null, min_messages: 3, min_customer_messages: 0, min_seller_messages: 0,
};
const messages = (criteria: CriterionInput[]): string => validateCriteria(criteria).map((x) => x.message).join(" | ");

describe("the weights of the enabled criteria add up to 100", () => {
  it("accepts exactly 100, however it is split (zero-weight gates included)", () => {
    expect(WEIGHT_TOTAL).toBe(100);
    expect(messages([crit("a", 100)])).toBe("");
    expect(messages([crit("a", 60), crit("b", 40)])).toBe("");
    expect(messages([crit("gate", 0), crit("a", 70), crit("b", 30)])).toBe("");
  });

  it("refuses a total under or over 100 and says which way and by how much", () => {
    expect(messages([crit("a", 60)])).toBe("A soma dos pesos dos critérios habilitados deve ser 100 (agora é 60: faltam 40).");
    expect(messages([crit("a", 60), crit("b", 60)])).toBe("A soma dos pesos dos critérios habilitados deve ser 100 (agora é 120: passam 20).");
    expect(messages([crit("a", 99.5), crit("b", 0.4)])).toBe("A soma dos pesos dos critérios habilitados deve ser 100 (agora é 99.9: faltam 0.1).");
    expect(messages([crit("a", 100.01)])).toContain("passam 0.01");
  });

  it("is not fooled by floating point: decimals that add up to 100 pass", () => {
    expect(messages([crit("a", 33.3), crit("b", 33.3), crit("c", 33.4)])).toBe("");
    expect(messages([crit("a", 0.1), crit("b", 0.2), crit("c", 99.7)])).toBe("");
  });

  it("counts only the enabled criteria: a disabled one never completes (or spoils) the total", () => {
    expect(messages([crit("a", 100), crit("off", 50, { enabled: false })])).toBe("");
    expect(messages([crit("a", 50), crit("off", 50, { enabled: false })])).toContain("agora é 50: faltam 50");
    expect(messages([crit("a", 100), crit("on", 50)])).toContain("agora é 150: passam 50");
  });

  it("leaves the message of an empty or zero total to the rules that already have one (no double report)", () => {
    expect(weightTotalIssue([])).toEqual([]);
    expect(weightTotalIssue([crit("a", 0)])).toEqual([]);
    expect(messages([crit("a", 0)])).toBe("A soma dos pesos habilitados deve ser positiva.");
    expect(messages([crit("a", 100, { enabled: false })])).toBe("A rubrica precisa de ao menos um critério habilitado.");
  });

  it("is a rule of the console only: the rules shared with the Python engine still accept any total (a published rubric is read as it is)", () => {
    expect(coreValid([crit("a", 10)])).toBe(true);
    expect(validateCriteria([crit("a", 10)]).length).toBe(1);
  });
});

/** The stored rubric the server reads; `weights` are the weights of its criteria (all enabled). */
function withRubric(h: Harness, weights: number[], status = "DRAFT"): void {
  h.bq.on(/FROM `[^`]*evaluation_rubrics` WHERE/, [{ rubric_id: "r1", version: 2, name: "Qual", status, description: "" }]);
  h.bq.on(/FROM `[^`]*evaluation_criteria`/, weights.map((w, i) => {
    const { level_descriptions: _l, minimum_score: _m, ...row } = crit(`c${i + 1}`, w, { display_order: i + 1 });
    return { ...row, score_mapping: JSON.stringify({ true: 100, false: 0 }), score_levels: null, applicability_rule: null };
  }));
  h.bq.on(/SELECT criterion_id, minimum_score FROM `[^`]*evaluation_criteria`/, []);
  h.bq.on(/FROM `[^`]*evaluation_policies`/, [{ ...POLICY }]);
}
type Got = { etag: string; issues: Array<{ path: string; message: string }>; draft: unknown };
const get = (h: Harness) => ok(h.call("rubrics.get", { tenant: A, rubric_id: "r1", version: 2 })) as Got;
const publish = (h: Harness, etag: string) => h.call("rubrics.publish", { tenant: A, rubric_id: "r1", version: 2, etag });

describe("the weight total in the server: a draft may be saved with it pending, but cannot be published", () => {
  it("reports the pending total when a draft is opened and when it is saved", () => {
    const h = as("EDITOR");
    withRubric(h, [60]);
    const g = get(h);
    expect(g.issues.map((i) => i.message)).toEqual(["A soma dos pesos dos critérios habilitados deve ser 100 (agora é 60: faltam 40)."]);
    const saved = ok(h.call("rubrics.saveDraft", { tenant: A, rubric_id: "r1", version: 2, etag: g.etag, draft: g.draft })) as { issues: Array<{ message: string }> };
    expect(saved.issues.length).toBe(1); // it is saved (work in progress), and the person is told what is missing
  });

  it("refuses to publish a draft that is under 100, and one that is over it", () => {
    for (const weights of [[60], [60, 60], [99.99]]) {
      const h = as("ADMIN");
      withRubric(h, weights);
      const g = get(h);
      expect(code(publish(h, g.etag))).toBe("INVALID_INPUT");
      expect(h.bq.calls.some((c) => /SET status = 'PUBLISHED'/.test(c.sql))).toBe(false); // nothing was written
    }
  });

  it("publishes a draft whose weights add up to 100", () => {
    const h = as("ADMIN");
    withRubric(h, [60, 40]);
    const g = get(h);
    expect(g.issues).toEqual([]);
    expect(ok(publish(h, g.etag))).toEqual({ version: 2, criteria: 2 });
    expect(h.bq.calls.some((c) => /SET status = 'PUBLISHED'/.test(c.sql))).toBe(true);
  });
});
