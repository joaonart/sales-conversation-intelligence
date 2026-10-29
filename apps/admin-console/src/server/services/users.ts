import type { AccessControl } from "../auth";
import { i, s, type Bq } from "../bq";
import type { Config } from "../config";
import { conflict, invalid } from "../errors";
import { MAX_PAGE, afterTs, cursorTsSelect, keyPage, parseKeyCursor, parseTsCursor, tsCursorParams, tsPage, type KeyCursor, type Page, type TsCursor } from "../paging";
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

  /** One page of people, ordered by e-mail (the key of the keyset). */
  list(tenant: Tenant, payload: Record<string, unknown>): Page<KeyCursor> {
    const limit = v.int(payload.limit ?? 50, "limit", 1, MAX_PAGE);
    const cursor = parseKeyCursor(payload.cursor, (x, f) => v.email(x, f));
    const rows = this.bq.run(
      `SELECT email, role, status, changed_at, changed_by FROM (SELECT email, role, status, changed_at, changed_by FROM ${this.t.users} WHERE ${TENANT} ${LATEST}) ` +
        `${cursor ? "WHERE email > @cur_key " : ""}ORDER BY email LIMIT @limit`,
      { org: s(tenant.organization_id), ws: s(tenant.workspace_id), ...(cursor ? { cur_key: s(cursor.key) } : {}), limit: i(limit + 1) },
      { maxRows: limit + 1 },
    );
    return keyPage(rows, limit, (r) => String(r.email));
  }

  count(tenant: Tenant): { total: number } {
    const row = this.bq.run(
      `SELECT COUNT(*) AS total FROM (SELECT email FROM ${this.t.users} WHERE ${TENANT} ${LATEST})`,
      { org: s(tenant.organization_id), ws: s(tenant.workspace_id) },
      { maxRows: 1 },
    )[0];
    return { total: Number(row?.total ?? 0) };
  }

  /** What the "never leave a tenant without an active administrator" rule needs: the active administrators and the person being changed, however many users exist. */
  private guardRows(tenant: Tenant, email: string): Row[] {
    return this.bq.run(
      `SELECT email, role, status FROM (SELECT email, role, status FROM ${this.t.users} WHERE ${TENANT} ${LATEST}) WHERE (role = 'ADMIN' AND status = 'ACTIVE') OR email = @email`,
      { org: s(tenant.organization_id), ws: s(tenant.workspace_id), email: s(email) },
      { maxRows: 1000 },
    );
  }

  /** Append-only: a change is a new row. A tenant can never be left without an active administrator. */
  upsert(actorEmail: string, tenant: Tenant, payload: Record<string, unknown>): { email: string; role: string; status: string } {
    const email = v.email(payload.email);
    if (!email.endsWith(`@${this.cfg.allowedDomain}`)) throw invalid(`Use uma conta @${this.cfg.allowedDomain}.`);
    const role = v.oneOf(payload.role, ROLES, "papel");
    const status = v.oneOf(payload.status ?? "ACTIVE", STATUSES, "status");
    const current = this.guardRows(tenant, email);
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

  list(tenant: Tenant, payload: Record<string, unknown>): Page<TsCursor> {
    const days = v.int(payload.days ?? 30, "days", 1, 365);
    const limit = v.int(payload.limit ?? 50, "limit", 1, MAX_PAGE);
    const cursor = parseTsCursor(payload.cursor);
    const rows = this.bq.run(
      `SELECT event_id, occurred_at, actor_email, action, entity_type, entity_id, outcome, TO_JSON_STRING(details) AS details, request_id, ${cursorTsSelect("occurred_at")} ` +
        `FROM ${this.t.audit} WHERE ${TENANT} AND DATE(occurred_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)${cursor ? ` AND ${afterTs("occurred_at", "event_id")}` : ""} ` +
        "ORDER BY occurred_at DESC, event_id ASC LIMIT @limit",
      { org: s(tenant.organization_id), ws: s(tenant.workspace_id), days: i(days), ...tsCursorParams(cursor), limit: i(limit + 1) },
      { maxRows: limit + 1 },
    );
    return tsPage(rows, limit, "event_id");
  }

  count(tenant: Tenant, payload: Record<string, unknown>): { total: number } {
    const days = v.int(payload.days ?? 30, "days", 1, 365);
    const row = this.bq.run(
      `SELECT COUNT(*) AS total FROM ${this.t.audit} WHERE ${TENANT} AND DATE(occurred_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)`,
      { org: s(tenant.organization_id), ws: s(tenant.workspace_id), days: i(days) },
      { maxRows: 1 },
    )[0];
    return { total: Number(row?.total ?? 0) };
  }
}
