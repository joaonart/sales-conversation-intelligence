import { fmtNum } from "./format";
import type { CriterionResult, SessionAnalysis } from "./types";

export function parseJson(text: string | null | undefined): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** The answer of a criterion as it was stored (a true/false criterion stores a boolean; a score or a choice stores its level), or null. */
export function answerValue(r: Pick<CriterionResult, "evaluation_result">): unknown {
  const x = parseJson(r.evaluation_result) as { answer?: unknown } | null;
  return x && x.answer !== undefined && x.answer !== null ? x.answer : null;
}

/**
 * A true/false criterion with no weight only opens the door of other criteria (it is an applicability gate): its 100 or 0 weighs nothing in the grade,
 * so what is shown for it is the answer, not a score.
 */
export function weightless(r: Pick<CriterionResult, "criterion_weight" | "evaluation_result">): boolean {
  return !Number(r.criterion_weight) && typeof answerValue(r) === "boolean";
}

export function noteText(r: Pick<CriterionResult, "criterion_weight" | "evaluation_result" | "normalized_score">): string {
  return weightless(r) ? String(answerValue(r)) : fmtNum(r.normalized_score, 0);
}

export interface Breakdown {
  inside: CriterionResult[];
  totalW: number;
  num: number;
  /** Each counted criterion's share of the grade. */
  parts: Record<string, number | null>;
  sum: number;
  overall: number | null;
  /** False when the stored grade is not the plain weighted average (a held or not evaluable analysis): then no formula is claimed. */
  matches: boolean;
}

const has = (v: number | null | undefined): v is number => v !== null && v !== undefined;

/**
 * How the final grade was reached, from what was stored for each criterion: only APPLICABLE criteria with a score count; the grade is
 * sum(score x weight) / sum(weights that count) and each criterion's contribution is its share of that sum.
 */
export function scoreBreakdown(crit: CriterionResult[], a: Pick<SessionAnalysis, "overall_score">): Breakdown {
  const inside = crit.filter((c) => c.applicability_status === "APPLICABLE" && has(c.normalized_score));
  const totalW = inside.reduce((s, c) => s + Number(c.criterion_weight || 0), 0);
  const num = inside.reduce((s, c) => s + Number(c.criterion_weight || 0) * Number(c.normalized_score), 0);
  const parts: Record<string, number | null> = {};
  for (const c of inside) parts[c.criterion_id] = has(c.weighted_score) ? Number(c.weighted_score) : totalW ? (Number(c.criterion_weight || 0) * Number(c.normalized_score)) / totalW : null;
  const sum = Object.values(parts).reduce<number>((s, v) => s + (v ?? 0), 0);
  const overall = has(a.overall_score) ? Number(a.overall_score) : null;
  return { inside, totalW, num, parts, sum, overall, matches: overall !== null && totalW > 0 && Math.abs(sum - overall) < 0.05 };
}

export function formulaText(bd: Breakdown): string {
  return `Nota final = Σ (nota × peso) ÷ Σ pesos que entram = ${fmtNum(bd.num, 2)} ÷ ${fmtNum(bd.totalW, 2)} = ${fmtNum(bd.overall, 2)}`;
}
