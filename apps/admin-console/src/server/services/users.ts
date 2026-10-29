import type { AccessControl } from "../auth";
import { i, s, type Bq } from "../bq";
import type { Config } from "../config";
import { conflict, invalid } from "../errors";
import { TENANT, type Tables } from "../sql";
import { ROLES, type Row, type Tenant } from "../types";
import * as v from "../validate";

const STATUSES = ["ACTIVE", "DISABLED"] as const;
const LATEST = "QUALIFY ROW_NUMBER() OVER (PARTITION BY email ORDER BY changed_at DESC) = 1";

export class UsersService {
  constructor(
    private readonly bq: Bq,
    private readonly t: Tables,
    private readonly cfg: Pick<Config, "allowedDomain">,
    private readonly access: AccessControl,
  ) {}

  list(tenant: Tenant): Row[] {
    return this.bq.run(
      `SELECT email, role, status, changed_at, changed_by FROM ${this.t.users} WHERE ${TENANT} ${LATEST} ORDER BY email`,
      { org: s(tenant.organization_id), ws: s(tenant.workspace_id) },
      { maxRows: 500 },
    );
  }

  /** Append-only: a change is a new row. A tenant can never be left without an active administrator. */
  upsert(actorEmail: string, tenant: Tenant, payload: Record<string, unknown>): { email: string; role: string; status: string } {
    const email = v.email(payload.email);
    if (!email.endsWith(`@${this.cfg.allowedDomain}`)) throw invalid(`Use uma conta @${this.cfg.allowedDomain}.`);
    const role = v.oneOf(payload.role, ROLES, "papel");
    const status = v.oneOf(payload.status ?? "ACTIVE", STATUSES, "status");
    const current = this.list(tenant);
    const activeAdmins = current.filter((u) => u.role === "ADMIN" && u.status === "ACTIVE");
    const target = current.find((u) => u.email === email);
    const losesAdmin = target?.role === "ADMIN" && target.status === "ACTIVE" && (role !== "ADMIN" || status !== "ACTIVE");
    if (losesAdmin && activeAdmins.length <= 1) throw conflict("Mantenha ao menos um administrador ativo neste workspace.");
    this.bq.run(
      `INSERT INTO ${this.t.users} (organization_id, workspace_id, email, role, status, changed_at, changed_by) ` +
        "VALUES (@org, @ws, @email, @role, @status, CURRENT_TIMESTAMP(), @by)",
      { org: s(tenant.organization_id), ws: s(tenant.workspace_id), email: s(email), role: s(role), status: s(status), by: s(actorEmail) },
    );
    this.access.invalidate(email);
    return { email, role, status };
  }
}

export class AuditLogService {
  constructor(private readonly bq: Bq, private readonly t: Tables) {}

  list(tenant: Tenant, payload: Record<string, unknown>): Row[] {
    const days = v.int(payload.days ?? 30, "days", 1, 365);
    const limit = v.int(payload.limit ?? 200, "limit", 1, 1000);
    return this.bq.run(
      `SELECT event_id, occurred_at, actor_email, action, entity_type, entity_id, outcome, TO_JSON_STRING(details) AS details, request_id ` +
        `FROM ${this.t.audit} WHERE ${TENANT} AND DATE(occurred_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY) ORDER BY occurred_at DESC LIMIT @limit`,
      { org: s(tenant.organization_id), ws: s(tenant.workspace_id), days: i(days), limit: i(limit) },
      { maxRows: limit },
    );
  }
}
