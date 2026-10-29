import type { Bq } from "./bq";
import { s } from "./bq";
import type { Tables } from "./sql";
import type { Tenant } from "./types";

export interface AuditEvent {
  actor: string;
  tenant?: Tenant;
  action: string;
  entityType?: string;
  entityId?: string;
  outcome: "SUCCESS" | "DENIED" | "ERROR";
  /** Metadata only: ids, versions, counts. Never message text or free-form user content. */
  details?: Record<string, string | number | boolean | null>;
  requestId: string;
}

export class Audit {
  constructor(
    private readonly bq: Bq,
    private readonly t: Tables,
    private readonly newId: () => string,
  ) {}

  /** failClosed=true propagates failures: used before releasing conversation content. */
  record(e: AuditEvent, opts: { failClosed?: boolean } = {}): void {
    try {
      this.bq.run(
        `INSERT INTO ${this.t.audit} (event_id, occurred_at, actor_email, organization_id, workspace_id, action, entity_type, entity_id, outcome, details, request_id) ` +
          "VALUES (@event_id, CURRENT_TIMESTAMP(), @actor, @org, @ws, @action, @etype, @eid, @outcome, PARSE_JSON(@details), @rid)",
        {
          event_id: s(this.newId()),
          actor: s(e.actor),
          org: s(e.tenant?.organization_id ?? null),
          ws: s(e.tenant?.workspace_id ?? null),
          action: s(e.action),
          etype: s(e.entityType ?? null),
          eid: s(e.entityId ?? null),
          outcome: s(e.outcome),
          details: s(JSON.stringify(e.details ?? {})),
          rid: s(e.requestId),
        },
      );
    } catch (err) {
      console.error(JSON.stringify({ event: "audit_write_failed", action: e.action, requestId: e.requestId }));
      if (opts.failClosed) throw err;
    }
  }
}
