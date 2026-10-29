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

export interface CriterionInput {
  criterion_id: string;
  criterion_name: string;
  evaluation_instructions: string;
  evaluation_type: EvaluationType;
  weight: number;
  required: boolean;
  enabled: boolean;
  /** answer key -> normalized score 0..100 */
  score_mapping: Record<string, number>;
  /** answer key -> text sent to the model so the level has a defined meaning */
  level_descriptions: Record<string, string>;
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

export interface RubricDraftInput {
  name: string;
  description: string;
  criteria: CriterionInput[];
  policy: PolicyInput;
}
