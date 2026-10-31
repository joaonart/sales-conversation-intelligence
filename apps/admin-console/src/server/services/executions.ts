import { f, i, s, type Bq, type Params } from "../bq";
import { conflict, invalid, notFound } from "../errors";
import { MAX_PAGE, afterTs, cursorTsSelect, parseTsCursor, tsCursorParams, tsPage, type Page, type TsCursor } from "../paging";
import { TENANT, type Tables } from "../sql";
import type { Row, Tenant } from "../types";
import * as v from "../validate";

/**
 * Execution requests. The console never runs a job and never holds the AI key: it validates, estimates (read-only) and records a request
 * with a cost ceiling and who asked. An executor (apps/console-executor) picks REQUESTED rows up and applies its own gates again.
 * Everything here is ADMIN-only (enforced in the RPC registry) and tenant-scoped.
 */
export const KINDS = ["ROUTING", "ANALYSIS", "SESSION_ANALYSIS"] as const;
export type Kind = (typeof KINDS)[number];
export const ACTIVE_STATUSES = ["REQUESTED", "RUNNING"] as const;
export const MAX_ACTIVE_PER_TENANT = 3;
const MAX_WINDOW_DAYS = 366;
const ROUTER_HEAD_TOKENS = 1200; // keep equal to the router default (sci_core.routing / routing_main)
const ROUTER_OVERHEAD_TOKENS = 170; // question and route descriptions sent with every classification (indicative)
const RUBRIC_OVERHEAD_TOKENS = 300; // questions of a rubric sent with every analysis (indicative)
const OUT_TOKENS: Record<Kind, number> = { ROUTING: 200, ANALYSIS: 1500, SESSION_ANALYSIS: 1500 }; // same worst case the jobs reserve

export interface ExecLimits {
  maxCostUsd: number;
  maxSessions: number;
  /** Indicative prices for the estimate shown in the console. The executor prices with its own configuration and enforces the ceiling. */
  priceInPerMillion: number;
  priceOutPerMillion: number;
}

export interface ExecPorts {
  newId(): string;
  /** Serialises writes across concurrent executions so two requests cannot both pass the "active requests" guard. */
  withLock<T>(fn: () => T): T;
}

type ParamValue = string | number | boolean;
interface Parsed {
  kind: Kind;
  params: Record<string, ParamValue>;
  maxCost: number;
}

export interface Preview {
  kind: Kind;
  sessions: number;
  with_messages: number;
  already: number;
  to_process: number;
  approx_input_tokens: number;
  estimate_low_usd: number;
  estimate_high_usd: number;
  max_cost_usd: number;
  within_ceiling: boolean;
  notes: string[];
}

const tenantParams = (t: Tenant): Params => ({ org: s(t.organization_id), ws: s(t.workspace_id) });
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
/** Same text for the same request whatever the key order: used to spot an identical request already waiting. */
const canonical = (o: Record<string, unknown>): string => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));

export class ExecutionService {
  constructor(
    private readonly bq: Bq,
    private readonly t: Tables,
    private readonly ports: ExecPorts,
    private readonly limits: ExecLimits,
    private readonly today: () => string = () => new Date().toISOString().slice(0, 10),
  ) {}

  /** Validates the whole request. Only a published rubric of this workspace can be run; windows are bounded; the cost ceiling is mandatory. */
  private parse(tenant: Tenant, payload: Record<string, unknown>): Parsed {
    const kind = v.oneOf(payload.kind, KINDS, "tipo de execução");
    const maxCost = v.num(payload.max_cost_usd, "teto de custo", 0.000001, this.limits.maxCostUsd);
    const params: Record<string, ParamValue> = {};
    if (kind === "SESSION_ANALYSIS") {
      params.session_id = v.id(payload.session_id, "sessão");
    } else {
      const start = v.date(payload.start, "início");
      const end = v.date(payload.end, "fim");
      if (end < start) throw invalid("O fim da janela não pode ser anterior ao início.");
      if ((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 864e5 > MAX_WINDOW_DAYS) throw invalid(`A janela não pode passar de ${MAX_WINDOW_DAYS} dias.`);
      if (end > this.today()) throw invalid("O fim da janela não pode estar no futuro.");
      params.start = start;
      params.end = end;
      params.max_sessions = v.int(payload.max_sessions, "limite de sessões", 1, this.limits.maxSessions);
    }
    if (kind !== "ROUTING") {
      params.rubric_id = v.id(payload.rubric_id, "rubrica");
      params.rubric_version = v.int(payload.rubric_version, "versão da rubrica", 1, 100000);
      this.assertPublished(tenant, params.rubric_id, params.rubric_version);
    }
    if (kind === "ANALYSIS") params.only_routed = payload.only_routed === undefined ? false : v.bool(payload.only_routed, "somente roteadas");
    return { kind, params, maxCost: maxCost };
  }

  private assertPublished(tenant: Tenant, rubricId: string, version: number): void {
    const row = this.bq.run(
      `SELECT status FROM ${this.t.rubrics} WHERE ${TENANT} AND rubric_id = @rid AND version = @ver LIMIT 1`,
      { ...tenantParams(tenant), rid: s(rubricId), ver: i(version) },
      { maxRows: 1 },
    )[0];
    if (!row) throw notFound("Rubrica não encontrada neste workspace.");
    if (row.status !== "PUBLISHED") throw invalid("Só uma versão publicada da rubrica pode ser executada.");
  }

  /** Read-only estimate from BigQuery. Indicative: the executor's own preflight is the authoritative gate. */
  preview(tenant: Tenant, payload: Record<string, unknown>): Preview {
    const p = this.parse(tenant, payload);
    return this.estimate(tenant, p);
  }

  private estimate(tenant: Tenant, p: Parsed): Preview {
    const base: Params = tenantParams(tenant);
    const notes: string[] = [];
    let row: Row | undefined;
    if (p.kind === "SESSION_ANALYSIS") {
      row = this.bq.run(
        `WITH s AS (SELECT session_id, started_at FROM ${this.t.sessions} WHERE ${TENANT} AND session_id = @sid ORDER BY updated_at DESC LIMIT 1), ` +
          `m AS (SELECT session_id, SUM(LENGTH(content)) AS chars FROM ${this.t.messages} WHERE ${TENANT} AND session_id = @sid GROUP BY session_id), ` +
          `a AS (SELECT DISTINCT session_id FROM ${this.t.analysesRaw} WHERE ${TENANT} AND session_id = @sid AND rubric_id = @rid AND rubric_version = @ver AND analysis_status != 'FAILED') ` +
          "SELECT (SELECT COUNT(*) FROM s) AS sessions, (SELECT COUNT(*) FROM s JOIN m USING (session_id)) AS with_messages, " +
          "(SELECT COUNT(*) FROM s JOIN a USING (session_id)) AS already, COALESCE((SELECT SUM(CAST(CEIL(chars / 4) AS INT64)) FROM m), 0) AS tokens",
        { ...base, sid: s(String(p.params.session_id)), rid: s(String(p.params.rubric_id)), ver: i(Number(p.params.rubric_version)) },
        { maxRows: 1 },
      )[0];
      if (!Number(row?.sessions ?? 0)) throw notFound("Sessão não encontrada neste workspace.");
      notes.push("O executor só analisa de novo se o conteúdo, a rubrica ou o modelo mudaram.");
    } else {
      const routed = p.kind === "ANALYSIS" && p.params.only_routed === true;
      const win: Params = { ...base, start: s(String(p.params.start)), end: s(String(p.params.end)) };
      const extra: Params = p.kind === "ROUTING" ? {} : { rid: s(String(p.params.rubric_id)), ver: i(Number(p.params.rubric_version)) };
      const routedJoin = routed
        ? `AND session_id IN (SELECT session_id FROM ${this.t.currentRoutes} WHERE ${TENANT} AND rubric_id = @rid AND (rubric_version IS NULL OR rubric_version = @ver)) `
        : "";
      const done =
        p.kind === "ROUTING"
          ? `SELECT DISTINCT session_id FROM ${this.t.currentRoutes} WHERE ${TENANT}`
          : `SELECT DISTINCT session_id FROM ${this.t.analysesRaw} WHERE ${TENANT} AND rubric_id = @rid AND rubric_version = @ver AND analysis_status != 'FAILED' AND DATE(started_at) >= @start`;
      const tokenExpr = p.kind === "ROUTING" ? `LEAST(CAST(CEIL(chars / 4) AS INT64), ${ROUTER_HEAD_TOKENS})` : "CAST(CEIL(chars / 4) AS INT64)";
      row = this.bq.run(
        `WITH s AS (SELECT session_id FROM ${this.t.sessions} WHERE ${TENANT} AND status = 'closed' AND DATE(started_at) BETWEEN @start AND @end ${routedJoin}), ` +
          `m AS (SELECT session_id, SUM(LENGTH(content)) AS chars FROM ${this.t.messages} WHERE ${TENANT} AND DATE(created_at) BETWEEN @start AND DATE_ADD(DATE(@end), INTERVAL 7 DAY) ` +
          "AND session_id IN (SELECT session_id FROM s) GROUP BY session_id), " +
          `d AS (${done}) ` +
          "SELECT (SELECT COUNT(*) FROM s) AS sessions, (SELECT COUNT(*) FROM s JOIN m USING (session_id)) AS with_messages, " +
          "(SELECT COUNT(*) FROM s JOIN m USING (session_id) JOIN d USING (session_id)) AS already, " +
          `COALESCE((SELECT SUM(${tokenExpr}) FROM m LEFT JOIN d USING (session_id) WHERE d.session_id IS NULL), 0) AS tokens`,
        { ...win, ...extra },
        { maxRows: 1 },
      )[0];
      if (routed) notes.push("Só entram sessões que a etapa de roteamento enviou para esta rubrica.");
    }
    const sessions = Number(row?.sessions ?? 0);
    const withMessages = Number(row?.with_messages ?? 0);
    const already = Number(row?.already ?? 0);
    const toProcess = Math.max(0, withMessages - already);
    const overhead = p.kind === "ROUTING" ? ROUTER_OVERHEAD_TOKENS : RUBRIC_OVERHEAD_TOKENS;
    const tokens = Number(row?.tokens ?? 0) + toProcess * overhead;
    const low = (tokens * this.limits.priceInPerMillion) / 1e6;
    const high = low + (toProcess * OUT_TOKENS[p.kind] * this.limits.priceOutPerMillion) / 1e6;
    if (p.kind === "ROUTING") notes.push("O roteamento usa só o início de cada conversa.");
    notes.push("Estimativa indicativa. O executor refaz o pré-voo com os preços do modelo configurado e recusa o que passar do teto.");
    return {
      kind: p.kind, sessions, with_messages: withMessages, already, to_process: toProcess, approx_input_tokens: tokens,
      estimate_low_usd: round6(low), estimate_high_usd: round6(high), max_cost_usd: p.maxCost, within_ceiling: high <= p.maxCost, notes,
    };
  }

  /** Records the request. Requires an explicit confirmation, a ceiling above the estimate and something to process; at most 3 requests wait per workspace. */
  request(actor: string, tenant: Tenant, payload: Record<string, unknown>): { request_id: string; kind: Kind; status: "REQUESTED"; estimate_high_usd: number } {
    if (payload.confirm !== true) throw invalid("Confirme a execução e o teto de custo.");
    const p = this.parse(tenant, payload);
    const est = this.estimate(tenant, p);
    if (est.to_process === 0) throw invalid("Não há nada a processar com estes parâmetros.");
    if (typeof p.params.max_sessions === "number" && est.to_process > p.params.max_sessions) {
      throw invalid(`A janela tem ${est.to_process} sessões a processar, acima do limite de ${p.params.max_sessions}. Aumente o limite ou reduza a janela.`);
    }
    if (!est.within_ceiling) {
      throw invalid(`O teto de US$ ${p.maxCost} é menor que a estimativa máxima de US$ ${est.estimate_high_usd}. Aumente o teto ou reduza a janela.`);
    }
    return this.ports.withLock(() => {
      const active = this.latest(tenant, ["REQUESTED", "RUNNING"]);
      if (active.length >= MAX_ACTIVE_PER_TENANT) throw conflict(`Já há ${MAX_ACTIVE_PER_TENANT} execuções aguardando ou em andamento neste workspace.`);
      const same = canonical(p.params) + p.kind;
      if (active.some((r) => r.kind === p.kind && canonical(JSON.parse(String(r.params)) as Record<string, unknown>) + String(r.kind) === same)) {
        throw conflict("Já existe uma execução igual aguardando ou em andamento.");
      }
      const id = this.ports.newId();
      this.bq.run(
        `INSERT INTO ${this.t.runRequests} (request_id, changed_at, organization_id, workspace_id, kind, status, params, max_cost_usd, estimate_low_usd, estimate_high_usd, ` +
          "requested_by, requested_at, changed_by, result, error) " +
          "VALUES (@id, CURRENT_TIMESTAMP(), @org, @ws, @kind, 'REQUESTED', PARSE_JSON(@params), @cap, @low, @high, @by, CURRENT_TIMESTAMP(), @by, NULL, NULL)",
        {
          ...tenantParams(tenant), id: s(id), kind: s(p.kind), params: s(JSON.stringify(p.params)), cap: f(p.maxCost),
          low: f(est.estimate_low_usd), high: f(est.estimate_high_usd), by: s(actor),
        },
      );
      return { request_id: id, kind: p.kind, status: "REQUESTED" as const, estimate_high_usd: est.estimate_high_usd };
    });
  }

  /** Latest row per request, optionally restricted to some statuses. Tenant-scoped; the window keeps the scan bounded. */
  private latest(tenant: Tenant, statuses: readonly string[]): Row[] {
    return this.bq.run(
      `SELECT request_id, kind, status, TO_JSON_STRING(params) AS params FROM ${this.t.runRequests} ` +
        `WHERE ${TENANT} AND DATE(requested_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY) ` +
        "QUALIFY ROW_NUMBER() OVER (PARTITION BY request_id ORDER BY changed_at DESC) = 1 AND status IN UNNEST(@statuses)",
      { ...tenantParams(tenant), statuses: { t: "ARRAY", of: "STRING", v: [...statuses] } },
      { maxRows: 100 },
    );
  }

  list(tenant: Tenant, payload: Record<string, unknown>): Page<TsCursor> {
    const days = v.int(payload.days ?? 30, "days", 1, 365);
    const limit = v.int(payload.limit ?? 50, "limit", 1, MAX_PAGE);
    const cursor = parseTsCursor(payload.cursor);
    const rows = this.bq.run(
      "SELECT request_id, kind, status, TO_JSON_STRING(params) AS params, max_cost_usd, estimate_low_usd, estimate_high_usd, requested_by, requested_at, " +
        `changed_at, changed_by, TO_JSON_STRING(result) AS result, error, ${cursorTsSelect("requested_at")} FROM ${this.t.runRequests} ` +
        `WHERE ${TENANT} AND DATE(requested_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)${cursor ? ` AND ${afterTs("requested_at", "request_id")}` : ""} ` +
        "QUALIFY ROW_NUMBER() OVER (PARTITION BY request_id ORDER BY changed_at DESC) = 1 " +
        "ORDER BY requested_at DESC, request_id ASC LIMIT @limit",
      { ...tenantParams(tenant), days: i(days), ...tsCursorParams(cursor), limit: i(limit + 1) },
      { maxRows: limit + 1 },
    );
    return tsPage(rows, limit, "request_id");
  }

  /** Cancels a request that no executor has picked up yet. The guard is inside the statement: a request already RUNNING is never overwritten. */
  cancel(actor: string, tenant: Tenant, payload: Record<string, unknown>): { request_id: string; status: "CANCELLED" } {
    const id = v.id(payload.request_id, "pedido");
    return this.ports.withLock(() => {
      const cur = this.bq.run(
        `SELECT status FROM ${this.t.runRequests} WHERE ${TENANT} AND request_id = @id AND DATE(requested_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 365 DAY) ` +
          "ORDER BY changed_at DESC LIMIT 1",
        { ...tenantParams(tenant), id: s(id) },
        { maxRows: 1 },
      )[0];
      if (!cur) throw notFound("Pedido não encontrado.");
      if (cur.status !== "REQUESTED") throw conflict("Só é possível cancelar um pedido que ainda não começou.");
      this.bq.run(
        `INSERT INTO ${this.t.runRequests} (request_id, changed_at, organization_id, workspace_id, kind, status, params, max_cost_usd, estimate_low_usd, estimate_high_usd, ` +
          "requested_by, requested_at, changed_by, result, error) " +
          "SELECT request_id, CURRENT_TIMESTAMP(), organization_id, workspace_id, kind, 'CANCELLED', params, max_cost_usd, estimate_low_usd, estimate_high_usd, " +
          `requested_by, requested_at, @by, NULL, NULL FROM (SELECT * FROM ${this.t.runRequests} WHERE ${TENANT} AND request_id = @id ` +
          "QUALIFY ROW_NUMBER() OVER (PARTITION BY request_id ORDER BY changed_at DESC) = 1) WHERE status = 'REQUESTED'",
        { ...tenantParams(tenant), id: s(id), by: s(actor) },
      );
      return { request_id: id, status: "CANCELLED" as const };
    });
  }
}
