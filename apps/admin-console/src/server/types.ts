export const ROLES = ["VIEWER", "EDITOR", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_RANK: Record<Role, number> = { VIEWER: 1, EDITOR: 2, ADMIN: 3 };

export interface Tenant {
  organization_id: string;
  workspace_id: string;
}

export interface Membership extends Tenant {
  role: Role;
}

/** The authenticated caller. `email` comes from Google, never from the request body. */
export interface Actor {
  email: string;
  memberships: Membership[];
}

export type Cell = string | number | boolean | null | string[];
export type Row = Record<string, Cell>;

export type EvaluationType = "PREDICATE" | "CHOICE" | "SCORE";

/** One test on a gate criterion: its answer must be one of `equals` (booleans as "true"/"false"). */
export interface RuleCondition {
  criterion_id: string;
  equals: string[];
}

/** Deterministic applicability: the criterion applies only if EVERY condition holds (one condition = depends_on, several = all_of). */
export interface ApplicabilityRule {
  conditions: RuleCondition[];
}

export interface CriterionInput {
  criterion_id: string;
  criterion_name: string;
  evaluation_instructions: string;
  evaluation_type: EvaluationType;
  weight: number;
  required: boolean;
  /** The lowest score (0..100) a REQUIRED criterion may get without rejecting the analysis; null: none (it only has to be evaluated). */
  minimum_score: number | null;
  enabled: boolean;
  /** answer key -> normalized score 0..100 */
  score_mapping: Record<string, number>;
  /** answer key -> text sent to the model so the level has a defined meaning */
  level_descriptions: Record<string, string>;
  applicability_rule: ApplicabilityRule | null;
  display_order: number;
}

export interface PolicyInput {
  minimum_approval_score: number;
  missing_evidence_policy: "NEEDS_REVIEW" | "EXCLUDE_OPTIONAL";
  max_analyses_per_session: number | null;
  max_input_tokens: number | null;
  monthly_budget_usd: number | null;
  min_messages: number;
  min_customer_messages: number;
  min_seller_messages: number;
}

/** The most characters the prompt of the general evaluation may have (the platform's `sci_core.rubric.MAX_SUMMARY_PROMPT_CHARS`; a test keeps both equal). */
export const MAX_SUMMARY_PROMPT = 4000;

export interface RubricDraftInput {
  name: string;
  description: string;
  /** The prompt of the general evaluation (positives, negatives, opportunities). Empty = this rubric asks for none. */
  summary_prompt: string;
  criteria: CriterionInput[];
  policy: PolicyInput;
}
