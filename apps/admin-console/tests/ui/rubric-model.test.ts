import { describe, expect, it } from "vitest";
import { addOption, blankCriterion, fromDraft, gateCandidates, removeOption, renameOption, toDraft, weightSum, withType } from "../../src/ui/lib/rubricModel";
import type { RubricDraftInput } from "../../src/ui/lib/types";

const policy = { minimum_approval_score: 70, missing_evidence_policy: "NEEDS_REVIEW" as const, max_analyses_per_session: null, max_input_tokens: null, monthly_budget_usd: null, min_messages: 0, min_customer_messages: 0, min_seller_messages: 0 };
const draft = (): RubricDraftInput => ({
  name: "n", description: "d", summary_prompt: "", policy,
  criteria: [
    { ...blankCriterion(1).c, criterion_id: "gate", weight: 0 },
    { ...blankCriterion(2).c, criterion_id: "greet", weight: 10, applicability_rule: { conditions: [{ criterion_id: "gate", equals: ["true"] }] } },
    { ...blankCriterion(3).c, criterion_id: "off", weight: 5, enabled: false },
  ],
});

describe("rubric model", () => {
  it("round-trips a draft without sharing objects with the loaded one", () => {
    const d = draft();
    const m = fromDraft(d);
    expect(toDraft(m)).toEqual(d);
    m.crits[0]!.c.score_mapping.true = 1;
    expect(d.criteria[0]!.score_mapping.true).toBe(100);
  });
  it("an empty rule or missing prompt/descriptions are normalised", () => {
    const d = draft();
    d.criteria[0]!.applicability_rule = { conditions: [] };
    (d as { summary_prompt?: string }).summary_prompt = undefined;
    const m = fromDraft(d);
    expect(m.crits[0]!.c.applicability_rule).toBeNull();
    expect(m.summary_prompt).toBe("");
  });
  it("sums only the enabled weights", () => expect(weightSum(fromDraft(draft()).crits)).toBe(10));
  it("a gate cannot be gated and a criterion is not its own gate", () => {
    const m = fromDraft(draft());
    expect(gateCandidates(m.crits, m.crits[2]!).map((c) => c.criterion_id)).toEqual(["gate", "off"].filter((x) => x !== "off"));
    expect(gateCandidates(m.crits, m.crits[0]!).map((c) => c.criterion_id)).toEqual(["off"]);
  });
  it("changing the type resets or keeps the answers sensibly", () => {
    const yes = blankCriterion(1).c;
    const scale = withType(yes, "SCORE");
    expect(scale.score_mapping).toEqual({ baixo: 0, alto: 100 });
    const custom = { ...scale, score_mapping: { a: 0, b: 50, c: 100 } };
    expect(withType(custom, "CHOICE").score_mapping).toEqual({ a: 0, b: 50, c: 100 });
    expect(withType(custom, "PREDICATE").score_mapping).toEqual({ true: 100, false: 0 });
  });
  it("renames an option in place, with its description, and refuses duplicates and blanks", () => {
    const c = { ...blankCriterion(1).c, evaluation_type: "CHOICE" as const, score_mapping: { a: 0, b: 100 }, level_descriptions: { a: "ruim" } };
    const r = renameOption(c, "a", " z ")!;
    expect(Object.keys(r.score_mapping)).toEqual(["z", "b"]);
    expect(r.level_descriptions).toEqual({ z: "ruim" });
    expect(renameOption(c, "a", "b")).toBeNull();
    expect(renameOption(c, "a", "  ")).toBeNull();
  });
  it("adds options with a free name and removes them with their description", () => {
    let c = { ...blankCriterion(1).c, evaluation_type: "CHOICE" as const, score_mapping: { opcao_1: 0 }, level_descriptions: { opcao_1: "x" } };
    c = addOption(c);
    expect(Object.keys(c.score_mapping)).toEqual(["opcao_1", "opcao_2"]);
    c = removeOption(c, "opcao_1");
    expect(c.score_mapping).toEqual({ opcao_2: 0 });
    expect(c.level_descriptions).toEqual({});
  });
});
