import { b, f, i, s, type Bq, type Params } from "../bq";
import { conflict, invalid, notFound } from "../errors";
import { TENANT, type Tables } from "../sql";
import type { Row, Tenant } from "../types";
import * as v from "../validate";
import type { ExecLimits, ExecPorts, ExecutionService } from "./executions";

/**
 * Recurring executions. A schedule is a standing instruction ("every day at 02:00 UTC analyse the new sessions of this rubric, spending at most X per
 * run"); it never runs or spends anything by itself. On each poll the executor (apps/console-executor, schedules.py) turns a DUE schedule into an ordinary
 * request, attributed to whoever created the schedule, which then passes every gate again (active ADMIN, the request's ceiling, the executor's monthly
 * budget, the AI gate). So pausing, archiving or losing the ADMIN role stops it. ADMIN-only, tenant-scoped, append-only (a change is a new row).
 */
export const FREQUENCIES = ["DAILY", "WEEKLY"] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export const SCHEDULE_STATUSES = ["ACTIVE", "PAUSED", "ARCHIVED"] as const;
export const ACTIONS = ["pause", "resume", "archive"] as const;
type Action = (typeof ACTIONS)[number];
export const MAX_SCHEDULES_PER_TENANT = 10;
const MAX_WINDOW_DAYS = 366;
const TRANSITIONS: Record<Action, { from: readonly string[]; to: string }> = {
  pause: { from: ["ACTIVE"], to: "PAUSED" },
  resume: { from: ["PAUSED"], to: "ACTIVE" },
  archive: { from: ["ACTIVE", "PAUSED"], to: "ARCHIVED" },
};

const tenantParams = (t: Tenant): Params => ({ org: s(t.organization_id), ws: s(t.workspace_id) });
const LATEST = "QUALIFY ROW_NUMBER() OVER (PARTITION BY schedule_id ORDER BY changed_at DESC) = 1";

/** The first moment strictly after `from` at which the schedule is meant to run (UTC; weekday 0 = Monday). */
export function nextRun(frequency: Frequency, hour: number, minute: number, weekday: number | null, from: Date): Date {
  const at = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hour, minute, 0, 0));
  if (frequency === "DAILY") return at.getTime() > from.getTime() ? at : new Date(at.getTime() + 864e5);
  const dow = (from.getUTCDay() + 6) % 7;
  const ahead = ((weekday ?? 0) - dow + 7) % 7;
  const slot = new Date(at.getTime() + ahead * 864e5);
  return slot.getTime() > from.getTime() ? slot : new Date(slot.getTime() + 7 * 864e5);
}

export class ScheduleService {
  constructor(
    private readonly bq: Bq,
    private readonly t: Tables,
    private readonly executions: ExecutionService,
    private readonly ports: ExecPorts,
    private readonly limits: ExecLimits,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Every schedule of the workspace (latest version of each), with the next run and the last request it made. Archived ones only on request. */
  list(tenant: Tenant, payload: Record<string, unknown>): { rows: Row[] } {
    const statuses = payload.include_archived === true ? [...SCHEDULE_STATUSES] : ["ACTIVE", "PAUSED"];
    const rows = this.bq.run(
      `WITH sch AS (SELECT schedule_id, name, status, frequency, hour_utc, minute_utc, weekday, rubric_id, rubric_version, window_days, max_sessions, only_routed, ` +
        `provider, model, max_cost_usd, created_by, created_at, changed_at, changed_by FROM ${this.t.runSchedules} WHERE ${TENANT} ${LATEST} AND status IN UNNEST(@statuses)), ` +
        `req AS (SELECT JSON_VALUE(params, '$.schedule_id') AS schedule_id, request_id, status, requested_at FROM ${this.t.runRequests} WHERE ${TENANT} ` +
        "AND DATE(requested_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 40 DAY) AND JSON_VALUE(params, '$.schedule_id') IS NOT NULL " +
        "QUALIFY ROW_NUMBER() OVER (PARTITION BY request_id ORDER BY changed_at DESC) = 1), " +
        "last_req AS (SELECT * FROM req QUALIFY ROW_NUMBER() OVER (PARTITION BY schedule_id ORDER BY requested_at DESC) = 1) " +
        "SELECT sch.*, last_req.request_id AS last_request_id, last_req.status AS last_status, last_req.requested_at AS last_requested_at " +
        "FROM sch LEFT JOIN last_req USING (schedule_id) ORDER BY sch.name, sch.schedule_id LIMIT 100",
      { ...tenantParams(tenant), statuses: { t: "ARRAY", of: "STRING", v: statuses } },
      { maxRows: 100 },
    );
    const from = this.now();
    return {
      rows: rows.map((r) => ({
        ...r,
        next_run: r.status === "ACTIVE" ? nextRun(r.frequency as Frequency, Number(r.hour_utc), Number(r.minute_utc), r.weekday === null || r.weekday === undefined ? null : Number(r.weekday), from).toISOString() : null,
      })),
    };
  }

  /**
   * Creates an ACTIVE schedule. It is a standing authorization to spend up to the ceiling on EVERY run, so it needs an explicit confirmation, a
   * published rubric, a model from the closed list and a ceiling above the estimate of a run over the window as it stands today.
   */
  create(actor: string, tenant: Tenant, payload: Record<string, unknown>): { schedule_id: string; status: "ACTIVE"; next_run: string } {
    if (payload.confirm !== true) throw invalid("Confirme a agenda e o teto de custo de cada execução.");
    const name = v.text(payload.name, "nome", 80, { min: 1 }).trim();
    if (!name) throw invalid("Informe um nome para a agenda.");
    const frequency = v.oneOf(payload.frequency, FREQUENCIES, "frequência");
    const hour = v.int(payload.hour_utc, "hora", 0, 23);
    const minute = v.int(payload.minute_utc, "minuto", 0, 59);
    const weekday = frequency === "WEEKLY" ? v.int(payload.weekday, "dia da semana", 0, 6) : null;
    const windowDays = v.int(payload.window_days, "janela em dias", 1, MAX_WINDOW_DAYS);
    const maxSessions = v.int(payload.max_sessions, "limite de sessões", 1, this.limits.maxSessions);
    const onlyRouted = payload.only_routed === undefined ? false : v.bool(payload.only_routed, "somente roteadas");
    const rubricId = v.id(payload.rubric_id, "rubrica");
    const rubricVersion = v.int(payload.rubric_version, "versão da rubrica", 1, 100000);
    const cap = v.num(payload.max_cost_usd, "teto de custo", 0.000001, this.limits.maxCostUsd);
    // The same validation and estimate as a request made by hand, over the window as it would run today.
    const end = this.now().toISOString().slice(0, 10);
    const start = new Date(Date.parse(`${end}T00:00:00Z`) - windowDays * 864e5).toISOString().slice(0, 10);
    const est = this.executions.preview(tenant, {
      kind: "ANALYSIS", start, end, max_sessions: maxSessions, rubric_id: rubricId, rubric_version: rubricVersion, only_routed: onlyRouted,
      provider: payload.provider, model: payload.model, max_cost_usd: cap,
    });
    if (est.to_process > 0 && !est.within_ceiling) {
      throw invalid(`O teto de US$ ${cap} por execução é menor que a estimativa máxima de US$ ${est.estimate_high_usd} para a janela de hoje. Aumente o teto ou reduza a janela.`);
    }
    return this.ports.withLock(() => {
      const current = this.bq.run(
        `SELECT name FROM ${this.t.runSchedules} WHERE ${TENANT} ${LATEST.replace("= 1", "= 1 AND status != 'ARCHIVED'")}`,
        tenantParams(tenant),
        { maxRows: MAX_SCHEDULES_PER_TENANT + 1 },
      );
      if (current.length >= MAX_SCHEDULES_PER_TENANT) throw conflict(`Este workspace já tem ${MAX_SCHEDULES_PER_TENANT} agendas. Arquive uma para criar outra.`);
      if (current.some((r) => String(r.name).toLowerCase() === name.toLowerCase())) throw conflict("Já existe uma agenda com este nome.");
      const id = this.ports.newId();
      this.bq.run(
        `INSERT INTO ${this.t.runSchedules} (schedule_id, changed_at, organization_id, workspace_id, name, status, frequency, hour_utc, minute_utc, weekday, rubric_id, ` +
          "rubric_version, window_days, max_sessions, only_routed, provider, model, max_cost_usd, created_by, created_at, changed_by) " +
          "VALUES (@id, CURRENT_TIMESTAMP(), @org, @ws, @name, 'ACTIVE', @frequency, @hour, @minute, @weekday, @rid, @ver, @win, @max, @routed, @provider, @model, @cap, @by, CURRENT_TIMESTAMP(), @by)",
        {
          ...tenantParams(tenant), id: s(id), name: s(name), frequency: s(frequency), hour: i(hour), minute: i(minute), weekday: i(weekday), rid: s(rubricId), ver: i(rubricVersion),
          win: i(windowDays), max: i(maxSessions), routed: b(onlyRouted), provider: s(est.provider), model: s(est.model), cap: f(cap), by: s(actor),
        },
      );
      return { schedule_id: id, status: "ACTIVE" as const, next_run: nextRun(frequency, hour, minute, weekday, this.now()).toISOString() };
    });
  }

  /** Pause, resume or archive. A new row copied from the latest one: the history stays, and the change counts from the next slot. */
  setStatus(actor: string, tenant: Tenant, payload: Record<string, unknown>): { schedule_id: string; status: string } {
    const id = v.id(payload.schedule_id, "agenda");
    const action = v.oneOf(payload.action, ACTIONS, "ação");
    const rule = TRANSITIONS[action];
    return this.ports.withLock(() => {
      const row = this.bq.run(
        `SELECT status FROM ${this.t.runSchedules} WHERE ${TENANT} AND schedule_id = @id ${LATEST}`,
        { ...tenantParams(tenant), id: s(id) },
        { maxRows: 1 },
      )[0];
      if (!row) throw notFound("Agenda não encontrada neste workspace.");
      if (!rule.from.includes(String(row.status))) throw conflict(`Não é possível ${action === "pause" ? "pausar" : action === "resume" ? "retomar" : "arquivar"} uma agenda ${String(row.status).toLowerCase()}.`);
      this.bq.run(
        `INSERT INTO ${this.t.runSchedules} (schedule_id, changed_at, organization_id, workspace_id, name, status, frequency, hour_utc, minute_utc, weekday, rubric_id, ` +
          "rubric_version, window_days, max_sessions, only_routed, provider, model, max_cost_usd, created_by, created_at, changed_by) " +
          "SELECT schedule_id, CURRENT_TIMESTAMP(), organization_id, workspace_id, name, @to, frequency, hour_utc, minute_utc, weekday, rubric_id, rubric_version, window_days, " +
          `max_sessions, only_routed, provider, model, max_cost_usd, created_by, created_at, @by FROM (SELECT * FROM ${this.t.runSchedules} WHERE ${TENANT} AND schedule_id = @id ${LATEST}) ` +
          "WHERE status IN UNNEST(@from)",
        { ...tenantParams(tenant), id: s(id), to: s(rule.to), by: s(actor), from: { t: "ARRAY", of: "STRING", v: [...rule.from] } },
      );
      return { schedule_id: id, status: rule.to };
    });
  }
}
