/** What the server answers, as the client uses it. The tenant and role types come from the server itself, so the two cannot drift. */
import type { CriterionInput, EvaluationType, Membership, PolicyInput, Role, RubricDraftInput, Tenant } from "../../server/types";
import type { Issue } from "../../server/rubricRules";

export type EvaluationTypeName = EvaluationType;
export type { CriterionInput, EvaluationType, Issue, Membership, PolicyInput, Role, RubricDraftInput, Tenant };
export const ROLE_RANK: Record<Role, number> = { VIEWER: 1, EDITOR: 2, ADMIN: 3 };
export const ROLE_LABEL: Record<Role, string> = { VIEWER: "Leitor", EDITOR: "Editor", ADMIN: "Administrador" };

export interface Profile {
  name: string | null;
  photo_url: string | null;
}

export interface Me {
  email: string;
  memberships: Membership[];
  profile: Profile;
  app_url: string | null;
}

/** A keyset page: the server hands back the cursor of the next one, never an offset. */
export interface Page<T> {
  rows: T[];
  nextCursor: unknown;
}

export interface AuditEvent {
  event_id: string;
  occurred_at: string;
  actor_email: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  outcome: string;
  details: string | null;
  request_id: string | null;
}

export interface AuditFilters {
  from: string;
  to: string;
  actor: string;
  action: string;
  outcome: string;
  entity: string;
}

export interface AuditFacets {
  actors: string[];
  actions: string[];
  outcomes: string[];
}

export type ListPayload<F> = F & { limit?: number; cursor?: unknown };

export interface RubricRow {
  rubric_id: string;
  version: number;
  name: string;
  status: "DRAFT" | "PUBLISHED";
  published_at: string | null;
  created_at: string | null;
  description: string | null;
}
export interface RubricFilters {
  query: string;
  status: string;
}
export interface RubricView {
  header: RubricRow;
  draft: RubricDraftInput;
  etag: string;
  issues: Issue[];
}

/** method -> [payload, response]. Grows with each screen that is ported; an unknown method does not compile. */
export interface RpcMap {
  me: [undefined, Me];
  "audit.list": [ListPayload<AuditFilters>, Page<AuditEvent>];
  "audit.count": [AuditFilters, { total: number }];
  "audit.facets": [{ from: string; to: string }, AuditFacets];
  "audit.get": [{ event_id: string }, AuditEvent];
  "rubrics.list": [ListPayload<RubricFilters>, Page<RubricRow>];
  "rubrics.count": [RubricFilters, { total: number }];
  "rubrics.get": [{ rubric_id: string; version: number }, RubricView];
  "rubrics.createDraft": [{ rubric_id: string; name: string; cloneFromVersion?: number }, { version: number }];
  "rubrics.saveDraft": [{ rubric_id: string; version: number; etag: string; draft: RubricDraftInput }, { etag: string; issues: Issue[] }];
  "rubrics.deleteDraft": [{ rubric_id: string; version: number }, { deleted: true }];
  "rubrics.publish": [{ rubric_id: string; version: number; etag: string }, { version: number; criteria: number }];
}
export type RpcMethod = keyof RpcMap;
