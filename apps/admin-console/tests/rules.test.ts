import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { maskPii } from "../src/server/mask";
import { coreValid, validateCriteria, validatePolicy } from "../src/server/rubricRules";
import type { CriterionInput } from "../src/server/types";
import * as v from "../src/server/validate";

const fixtures = JSON.parse(readFileSync(new URL("../../../fixtures/admin_conformance.json", import.meta.url), "utf8")) as {
  mask: Array<{ input: string; expected: string }>;
  criteria: Array<{ name: string; valid: boolean; criteria: CriterionInput[] }>;
};

describe("conformance with the Python engine (shared fixtures)", () => {
  it.each(fixtures.mask.map((c) => [c.input, c.expected]))("mask_pii: %s", (input, expected) => {
    expect(maskPii(input as string)).toBe(expected);
  });

  it.each(fixtures.criteria.map((c) => [c.name, c] as const))("rubric validity: %s", (_name, c) => {
    expect(coreValid(c.criteria)).toBe(c.valid);
  });
});

const base: CriterionInput = {
  criterion_id: "needs", criterion_name: "Necessidade", evaluation_instructions: "q", evaluation_type: "SCORE", weight: 10, required: false, enabled: true,
  score_mapping: { none: 0, partial: 50, complete: 100 }, level_descriptions: {}, display_order: 1,
};

describe("console-only rules", () => {
  it("SCORE levels need distinct notes (the order comes from the note)", () => {
    expect(validateCriteria([{ ...base, score_mapping: { a: 10, b: 10 } }]).map((x) => x.message).join()).toMatch(/nota diferente/);
  });
  it("criterion ids become provider question names", () => {
    expect(validateCriteria([{ ...base, criterion_id: "Needs Now!" }]).length).toBeGreaterThan(0);
  });
  it("provider limits on options", () => {
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, k) => [`l${k}`, k * 5]));
    expect(validateCriteria([{ ...base, score_mapping: many }]).length).toBeGreaterThan(0);
  });
  it("policy fields", () => {
    const ok = { minimum_approval_score: 70, missing_evidence_policy: "NEEDS_REVIEW", max_analyses_per_session: null, max_input_tokens: null, monthly_budget_usd: null, min_messages: 3, min_customer_messages: 0, min_seller_messages: 0 } as const;
    expect(validatePolicy(ok)).toEqual([]);
    expect(validatePolicy({ ...ok, min_messages: -1 }).length).toBe(1);
    expect(validatePolicy({ ...ok, minimum_approval_score: 101 }).length).toBe(1);
  });
});

describe("validators", () => {
  it("accept only safe identifiers, emails and dates", () => {
    expect(() => v.id("ok_id-1.2:3", "x")).not.toThrow();
    for (const bad of ["", " a", "a b", "a'b", "a;b", "a`b", "../x", "x".repeat(200)]) expect(() => v.id(bad, "x")).toThrow();
    expect(v.email(" A@Example.com ")).toBe("a@example.com");
    expect(() => v.email("not-an-email")).toThrow();
    expect(() => v.date("2026-02-30", "d")).toThrow();
    expect(() => v.int(1.5, "n", 0, 10)).toThrow();
  });
});
