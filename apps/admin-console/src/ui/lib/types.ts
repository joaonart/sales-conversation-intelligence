/** What the server answers, as the client uses it. The tenant and role types come from the server itself, so the two cannot drift. */
import type { Membership, Role, Tenant } from "../../server/types";

export type { Membership, Role, Tenant };
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

/** method -> [payload, response]. Grows with each screen that is ported; an unknown method does not compile. */
export interface RpcMap {
  me: [undefined, Me];
  "audit.list": [ListPayload<AuditFilters>, Page<AuditEvent>];
  "audit.count": [AuditFilters, { total: number }];
  "audit.facets": [{ from: string; to: string }, AuditFacets];
  "audit.get": [{ event_id: string }, AuditEvent];
}
export type RpcMethod = keyof RpcMap;
