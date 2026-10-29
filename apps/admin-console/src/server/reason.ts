import type { Row } from "./types";

/** Codes sci_core.scoring can persist in session_analyses.approval_reason. Anything else is dropped. */
export const REASON_CODES = [
  "MEETS_MINIMUM",
  "OVERALL_BELOW_MINIMUM",
  "REQUIRED_CRITERION_BELOW_MINIMUM",
  "INSUFFICIENT_EVIDENCE",
  "NO_APPLICABLE_CRITERIA",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
export interface Reason {
  code: ReasonCode;
  criterion_id?: string;
  score?: number;
  required?: boolean;
}
export interface ApprovalReason {
  minimum: number | null;
  overall: number | null;
  reasons: Reason[];
}

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_REASONS = 50;
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/**
 * The column is JSON written by the engine, but the console never trusts stored text: BigQuery hands JSON back as a string,
 * so parse defensively and rebuild the object from known fields only. Unparseable or unknown shapes become null (no reason shown).
 */
export function sanitizeReason(raw: unknown): ApprovalReason | null {
  let x: unknown = raw;
  if (typeof raw === "string") {
    try {
      x = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (!Array.isArray(o.reasons)) return null;
  const reasons: Reason[] = [];
  for (const r of o.reasons.slice(0, MAX_REASONS)) {
    if (!r || typeof r !== "object") continue;
    const e = r as Record<string, unknown>;
    if (!REASON_CODES.includes(e.code as ReasonCode)) continue;
    const out: Reason = { code: e.code as ReasonCode };
    if (typeof e.criterion_id === "string" && ID.test(e.criterion_id)) out.criterion_id = e.criterion_id;
    const sc = num(e.score);
    if (sc !== null) out.score = sc;
    if (typeof e.required === "boolean") out.required = e.required;
    reasons.push(out);
  }
  if (!reasons.length) return null;
  return { minimum: num(o.minimum), overall: num(o.overall), reasons };
}

/** Rows only carry scalars, so the sanitised reason travels as canonical JSON text (re-serialised here, never the stored text). */
export const withReason = (row: Row): Row => {
  const r = sanitizeReason(row.approval_reason);
  return { ...row, approval_reason: r ? JSON.stringify(r) : null };
};
