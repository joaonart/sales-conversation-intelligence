import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sanitizeReason, withReason } from "../src/server/reason";

const good = { minimum: 70, overall: 87.5, reasons: [{ code: "REQUIRED_CRITERION_BELOW_MINIMUM", criterion_id: "needs", score: 50 }] };

describe("approval reason (engine output, never trusted)", () => {
  it("accepts the object and the JSON string BigQuery returns for a JSON column", () => {
    expect(sanitizeReason(good)).toEqual(good);
    expect(sanitizeReason(JSON.stringify(good))).toEqual(good);
  });

  it("returns null for legacy rows, garbage and wrong shapes", () => {
    for (const bad of [null, undefined, "", "not json", "[]", 7, [], {}, { reasons: "x" }, { reasons: [] }, { reasons: [{ code: "NOPE" }] }]) {
      expect(sanitizeReason(bad)).toBeNull();
    }
  });

  it("rebuilds from known fields only: unknown codes, extra keys and hostile ids are dropped", () => {
    const out = sanitizeReason({
      minimum: "70", overall: 50, extra: "<img onerror=x>",
      reasons: [
        { code: "OVERALL_BELOW_MINIMUM", note: "<script>" },
        { code: "INSUFFICIENT_EVIDENCE", criterion_id: "<b>x</b>", required: "yes" },
        { code: "REQUIRED_CRITERION_BELOW_MINIMUM", criterion_id: "needs", score: "50" },
        { code: "EVIL" },
      ],
    });
    expect(out).toEqual({ minimum: null, overall: 50, reasons: [{ code: "OVERALL_BELOW_MINIMUM" }, { code: "INSUFFICIENT_EVIDENCE" }, { code: "REQUIRED_CRITERION_BELOW_MINIMUM", criterion_id: "needs" }] });
    expect(JSON.stringify(out)).not.toMatch(/script|onerror|<b>/);
  });

  it("hands the client canonical JSON text rebuilt from the sanitised object", () => {
    const row = withReason({ analysis_id: "a1", approval_reason: JSON.stringify({ ...good, extra: "x" }) });
    expect(JSON.parse(String(row.approval_reason))).toEqual(good);
    expect(withReason({ analysis_id: "a1", approval_reason: null }).approval_reason).toBeNull();
  });

  it("caps the number of reasons", () => {
    const many = { minimum: 70, overall: 1, reasons: Array.from({ length: 500 }, () => ({ code: "OVERALL_BELOW_MINIMUM" })) };
    expect(sanitizeReason(many)!.reasons.length).toBe(50);
  });
});

describe("console shows the reason", () => {
  const app = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  it("renders every code the engine can persist, without innerHTML", () => {
    for (const code of ["REQUIRED_CRITERION_BELOW_MINIMUM", "OVERALL_BELOW_MINIMUM", "MEETS_MINIMUM", "INSUFFICIENT_EVIDENCE", "NO_APPLICABLE_CRITERIA"]) {
      expect(app).toContain(`case "${code}"`);
    }
    expect(app).toMatch(/reasonBlock\(a\)/);
    expect(app).toMatch(/reasonItems\(a\)\.concat/);
  });
});
