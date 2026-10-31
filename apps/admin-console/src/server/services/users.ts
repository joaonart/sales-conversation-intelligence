import type { AccessControl } from "../auth";
import { d, i, s, type Bq, type Param } from "../bq";
import type { Config } from "../config";
import { conflict, invalid, notFound } from "../errors";
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

  /**
   * Filters for the people list. Role and status are properties of the LATEST row of each person, so they are applied after the latest row is
   * chosen; the e-mail search is a case-insensitive "contains" on a short, e-mail-shaped text (bound as a parameter, never part of the SQL text).
   */
  private filters(payload: Record<string, unknown>): { where: string; params: Record<string, Param> } {
    const conds: string[] = [];
    const params: Record<string, Param> = {};
    const given = (key: string): boolean => payload[key] !== undefined && payload[key] !== "";
    if (given("role")) {
      params.role = s(v.oneOf(payload.role, ROLES, "papel"));
      conds.push("role = @role");
    }
    if (given("status")) {
      params.status = s(v.oneOf(payload.status, STATUSES, "status"));
      conds.push("status = @status");
    }
    if (given("query")) {
      const q = v.text(payload.query, "busca", 64).toLowerCase();
      if (!/^[a-z0-9._%+@-]+$/.test(q)) throw invalid("A busca aceita só letras, números e . _ % + - @.");
      params.q = s(q);
      conds.push("STRPOS(LOWER(email), @q) > 0");
    }
    return { where: conds.join(" AND "), params };
  }

  /** One page of people, ordered by e-mail (the key of the keyset). */
  list(tenant: Tenant, payload: Record<string, unknown>): Page<KeyCursor> {
    const limit = v.int(payload.limit ?? 50, "limit", 1, MAX_PAGE);
    const cursor = parseKeyCursor(payload.cursor, (x, f) => v.email(x, f));
    const f = this.filters(payload);
    const conds = [f.where, cursor ? "email > @cur_key" : ""].filter(Boolean);
    const rows = this.bq.run(
      `SELECT email, role, status, changed_at, changed_by FROM (SELECT email, role, status, changed_at, changed_by FROM ${this.t.users} WHERE ${TENANT} ${LATEST}) ` +
        `${conds.length ? `WHERE ${conds.join(" AND ")} ` : ""}ORDER BY email LIMIT @limit`,
      { org: s(tenant.organization_id), ws: s(tenant.workspace_id), ...f.params, ...(cursor ? { cur_key: s(cursor.key) } : {}), limit: i(limit + 1) },
      { maxRows: limit + 1 },
    );
    return keyPage(rows, limit, (r) => String(r.email));
  }

  count(tenant: Tenant, payload: Record<string, unknown> = {}): { total: number } {
    const f = this.filters(payload);
    const row = this.bq.run(
      `SELECT COUNT(*) AS total FROM (SELECT email, role, status FROM ${this.t.users} WHERE ${TENANT} ${LATEST})${f.where ? ` WHERE ${f.where}` : ""}`,
      { org: s(tenant.organization_id), ws: s(tenant.workspace_id), ...f.params },
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

  /**
   * Filters shared by the page, the total and the options. Period: `from`/`to` (at most 366 days) or, without them, the last `days`. Everything else is an
   * exact match on a recorded value; the values travel as parameters.
   */
  private filters(tenant: Tenant, payload: Record<string, unknown>): { where: string; params: Record<string, Param> } {
    let params: Record<string, Param> = { org: s(tenant.organization_id), ws: s(tenant.workspace_id) };
    let where = TENANT;
    if (payload.from !== undefined || payload.to !== undefined) {
      const from = v.date(payload.from, "from");
      const to = v.date(payload.to, "to");
      if (from > to) throw invalid("O período é inválido.");
      if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) throw invalid("O período máximo é de 366 dias.");
      params = { ...params, from: d(from), to: d(to) };
      where += " AND DATE(occurred_at) BETWEEN @from AND @to";
    } else {
      params = { ...params, days: i(v.int(payload.days ?? 30, "days", 1, 365)) };
      where += " AND DATE(occurred_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)";
    }
    const exact = (key: string, column: string, check: (x: unknown) => string): void => {
      if (payload[key] === undefined || payload[key] === "") return;
      params = { ...params, [key]: s(check(payload[key])) };
      where += ` AND ${column} = @${key}`;
    };
    exact("actor", "actor_email", (x) => v.email(x, "quem"));
    exact("action", "action", (x) => v.id(x, "ação"));
    exact("outcome", "outcome", (x) => v.id(x, "resultado"));
    exact("entity", "entity_id", (x) => v.text(x, "alvo", 128, { min: 1 }));
    return { where, params };
  }

  list(tenant: Tenant, payload: Record<string, unknown>): Page<TsCursor> {
    const limit = v.int(payload.limit ?? 50, "limit", 1, MAX_PAGE);
    const cursor = parseTsCursor(payload.cursor);
    const { where, params } = this.filters(tenant, payload);
    const rows = this.bq.run(
      `SELECT event_id, occurred_at, actor_email, action, entity_type, entity_id, outcome, TO_JSON_STRING(details) AS details, request_id, ${cursorTsSelect("occurred_at")} ` +
        `FROM ${this.t.audit} WHERE ${where}${cursor ? ` AND ${afterTs("occurred_at", "event_id")}` : ""} ` +
        "ORDER BY occurred_at DESC, event_id ASC LIMIT @limit",
      { ...params, ...tsCursorParams(cursor), limit: i(limit + 1) },
      { maxRows: limit + 1 },
    );
    return tsPage(rows, limit, "event_id");
  }

  /** Values present in the period, to fill the who, action and result filters. Three small columns of the same bounded range. */
  facets(tenant: Tenant, payload: Record<string, unknown>): { actors: string[]; actions: string[]; outcomes: string[] } {
    const { where, params } = this.filters(tenant, { from: payload.from, to: payload.to, days: payload.days });
    const rows = this.bq.run(`SELECT DISTINCT actor_email, action, outcome FROM ${this.t.audit} WHERE ${where} LIMIT 1000`, params, { maxRows: 1000 });
    const uniq = (key: string): string[] => [...new Set(rows.map((r) => r[key]).filter((x): x is string => typeof x === "string" && x !== ""))].sort();
    return { actors: uniq("actor_email"), actions: uniq("action"), outcomes: uniq("outcome") };
  }

  /** One event, for its own page. Same columns as the list; tenant-scoped; the window keeps the scan bounded (the audit table is partitioned by day). */
  get(tenant: Tenant, payload: Record<string, unknown>): Row {
    const eventId = v.id(payload.event_id, "event_id");
    const row = this.bq.run(
      "SELECT event_id, occurred_at, actor_email, action, entity_type, entity_id, outcome, TO_JSON_STRING(details) AS details, request_id " +
        `FROM ${this.t.audit} WHERE ${TENANT} AND event_id = @eid AND DATE(occurred_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 365 DAY) LIMIT 1`,
      { org: s(tenant.organization_id), ws: s(tenant.workspace_id), eid: s(eventId) },
      { maxRows: 1 },
    )[0];
    if (!row) throw notFound("Evento não encontrado neste workspace.");
    return row;
  }

  count(tenant: Tenant, payload: Record<string, unknown>): { total: number } {
    const { where, params } = this.filters(tenant, payload);
    const row = this.bq.run(`SELECT COUNT(*) AS total FROM ${this.t.audit} WHERE ${where}`, params, { maxRows: 1 })[0];
    return { total: Number(row?.total ?? 0) };
  }
}
