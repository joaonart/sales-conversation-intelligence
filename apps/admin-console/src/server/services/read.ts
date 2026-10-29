import type { Audit } from "../audit";
import { d, i, s, ts, type Bq, type Param, type Params } from "../bq";
import { invalid, notFound } from "../errors";
import { maskPii } from "../mask";
import { withReason } from "../reason";
import { MAX_PAGE, afterTs, cursorTsSelect, parseTsCursor, tsCursorParams, tsPage, type Page, type TsCursor } from "../paging";
import { TENANT, TENANT_ALIASED, type Tables } from "../sql";
import type { Actor, Row, Tenant } from "../types";
import * as v from "../validate";

const tenantParams = (t: Tenant): Params => ({ org: s(t.organization_id), ws: s(t.workspace_id) });
const STATUSES = ["COMPLETED", "NEEDS_REVIEW", "NOT_EVALUABLE", "FAILED", "UNANALYSED"] as const;
/** What sci_core.scoring can produce: PENDING (needs review) and N_A (not evaluable) are distinct from a rejection. */
const RESULTS = ["APPROVED", "REJECTED", "PENDING", "N_A"] as const;
const MAX_MESSAGES = 2000;
const MAX_MESSAGE_CHARS = 4000;

export class DashboardService {
  constructor(private readonly bq: Bq, private readonly t: Tables) {}

  summary(tenant: Tenant, payload: Record<string, unknown>): Record<string, Row[]> {
    const days = v.int(payload.days ?? 30, "days", 1, 180);
    const p: Params = { ...tenantParams(tenant), days: i(days) };
    const since = "day >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)";
    return {
      quality: this.bq.run(
        `SELECT rubric_id, rubric_version, day, sessions, scored_sessions, avg_score, approved, rejected, needs_review, not_evaluable, approval_rate ` +
          `FROM ${this.t.dailyQuality} WHERE ${TENANT} AND ${since} ORDER BY day`,
        p,
        { maxRows: 2000 },
      ),
      cost: this.bq.run(
        `SELECT day, analysis_mode, model, analyses, cost_usd, avg_duration_ms FROM ${this.t.dailyCost} WHERE ${TENANT} AND ${since} ORDER BY day`,
        p,
        { maxRows: 2000 },
      ),
      runs: this.bq.run(
        `SELECT day, processing_mode, run_status, runs, sessions_processed, sessions_failed, sessions_skipped, actual_cost_usd ` +
          `FROM ${this.t.runHealth} WHERE ${TENANT} AND ${since} ORDER BY day`,
        p,
        { maxRows: 2000 },
      ),
    };
  }
}

export class RunsService {
  constructor(private readonly bq: Bq, private readonly t: Tables) {}

  list(tenant: Tenant, payload: Record<string, unknown>): Page<TsCursor> {
    const days = v.int(payload.days ?? 30, "days", 1, 365);
    const limit = v.int(payload.limit ?? 50, "limit", 1, MAX_PAGE);
    const cursor = parseTsCursor(payload.cursor);
    const rows = this.bq.run(
      `SELECT run_id, rubric_id, rubric_version, processing_mode, run_status, sessions_total, sessions_processed, sessions_failed, sessions_skipped, ` +
        `estimated_cost_usd, actual_cost_usd, created_at, finished_at, ${cursorTsSelect("created_at")} FROM ${this.t.runs} ` +
        `WHERE ${TENANT} AND DATE(created_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)${cursor ? ` AND ${afterTs("created_at", "run_id")}` : ""} ` +
        "ORDER BY created_at DESC, run_id ASC LIMIT @limit",
      { ...tenantParams(tenant), days: i(days), ...tsCursorParams(cursor), limit: i(limit + 1) },
      { maxRows: limit + 1 },
    );
    return tsPage(rows, limit, "run_id");
  }

  count(tenant: Tenant, payload: Record<string, unknown>): { total: number } {
    const days = v.int(payload.days ?? 30, "days", 1, 365);
    const row = this.bq.run(
      `SELECT COUNT(*) AS total FROM ${this.t.runs} WHERE ${TENANT} AND DATE(created_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)`,
      { ...tenantParams(tenant), days: i(days) },
      { maxRows: 1 },
    )[0];
    return { total: Number(row?.total ?? 0) };
  }
}

interface Cursor {
  started_at: string;
  session_id: string;
}

function parseCursor(raw: unknown): Cursor | null {
  if (raw === undefined || raw === null) return null;
  const o = v.asObject(raw, "cursor");
  const started = v.text(o.started_at, "cursor.started_at", 40, { min: 1 });
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(started)) throw invalid("cursor inválido.");
  return { started_at: started, session_id: v.id(o.session_id, "cursor.session_id") };
}

export class SessionsService {
  constructor(
    private readonly bq: Bq,
    private readonly t: Tables,
    private readonly audit: Audit,
  ) {}

  /** The filters shared by the page query and the count, so both always describe the same set of rows. */
  private filters(tenant: Tenant, payload: Record<string, unknown>): { where: string; params: Record<string, Param> } {
    const from = v.date(payload.from, "from");
    const to = v.date(payload.to, "to");
    if (from > to) throw invalid("O período é inválido.");
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) throw invalid("O período máximo é de 366 dias.");
    const params: Record<string, Param> = { ...tenantParams(tenant), from: d(from), to: d(to) };
    let where = `${TENANT_ALIASED("s")} AND DATE(s.started_at) BETWEEN @from AND @to`;
    if (payload.status !== undefined && payload.status !== "") {
      const status = v.oneOf(payload.status, STATUSES, "status");
      where += status === "UNANALYSED" ? " AND r.analysis_id IS NULL" : " AND r.analysis_status = @status";
      if (status !== "UNANALYSED") params.status = s(status);
    }
    if (payload.result !== undefined && payload.result !== "") {
      params.result = s(v.oneOf(payload.result, RESULTS, "resultado"));
      where += " AND r.approval_status = @result";
    }
    if (payload.channel !== undefined && payload.channel !== "") {
      params.channel = s(v.id(payload.channel, "canal"));
      where += " AND s.channel = @channel";
    }
    if (payload.rubric !== undefined && payload.rubric !== "") {
      params.rubric = s(v.id(payload.rubric, "rubrica"));
      where += " AND r.rubric_id = @rubric";
    }
    if (payload.query !== undefined && payload.query !== "") {
      params.q = s(v.id(payload.query, "query"));
      where += " AND s.session_id = @q";
    }
    return { where, params };
  }

  private readonly from = (): string => `${this.t.sessions} s LEFT JOIN ${this.t.results} r ON ${TENANT_ALIASED("r")} AND r.session_id = s.session_id`;

  /**
   * One page, by keyset (never OFFSET: BigQuery would read every skipped row again on each page). The order is total: (started_at DESC, session_id ASC).
   * The cursor carries the timestamp as a string with microseconds: going through a JS Date would cut it to milliseconds and skip rows between pages.
   */
  list(tenant: Tenant, payload: Record<string, unknown>): { rows: Row[]; nextCursor: Cursor | null } {
    const limit = v.int(payload.limit ?? 50, "limit", 1, 100);
    const cursor = parseCursor(payload.cursor);
    const { where, params } = this.filters(tenant, payload);
    let paged = where;
    const all: Record<string, Param> = { ...params, limit: i(limit + 1) };
    if (cursor) {
      all.cur_ts = ts(cursor.started_at);
      all.cur_sid = s(cursor.session_id);
      paged += " AND (s.started_at < @cur_ts OR (s.started_at = @cur_ts AND s.session_id > @cur_sid))";
    }
    const rows = this.bq.run(
      `SELECT s.session_id, s.channel, s.status AS session_status, s.started_at, FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', s.started_at) AS cursor_ts, ` +
        "r.analysis_status, r.overall_score, r.approval_status, r.rubric_id, r.rubric_version, r.model " +
        `FROM ${this.from()} WHERE ${paged} ORDER BY s.started_at DESC, s.session_id ASC LIMIT @limit`,
      all,
      { maxRows: limit + 1 },
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      rows: page.map(({ cursor_ts: _cursor, ...row }) => row),
      nextCursor: rows.length > limit && last ? { started_at: String(last.cursor_ts), session_id: String(last.session_id) } : null,
    };
  }

  /** Channels present in the period, to fill the channel filter. One column of the partition-pruned range. */
  channels(tenant: Tenant, payload: Record<string, unknown>): string[] {
    const from = v.date(payload.from, "from");
    const to = v.date(payload.to, "to");
    if (from > to) throw invalid("O período é inválido.");
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) throw invalid("O período máximo é de 366 dias.");
    return this.bq
      .run(
        `SELECT DISTINCT channel FROM ${this.t.sessions} WHERE ${TENANT} AND DATE(started_at) BETWEEN @from AND @to AND channel IS NOT NULL ORDER BY channel LIMIT 100`,
        { ...tenantParams(tenant), from: d(from), to: d(to) },
        { maxRows: 100 },
      )
      .map((r) => String(r.channel));
  }

  /** Exact number of rows for the same filters. Asked for on demand by the screen: counting is a full scan of the period, paging is not. */
  count(tenant: Tenant, payload: Record<string, unknown>): { total: number } {
    const { where, params } = this.filters(tenant, payload);
    const row = this.bq.run(`SELECT COUNT(*) AS total FROM ${this.from()} WHERE ${where}`, params, { maxRows: 1 })[0];
    return { total: Number(row?.total ?? 0) };
  }

  /** Releases masked conversation content. The access is recorded first and the call fails closed if the audit write fails. */
  get(actor: Actor, tenant: Tenant, payload: Record<string, unknown>, requestId: string): Record<string, unknown> {
    const sessionId = v.id(payload.sessionId, "sessionId");
    const base = { ...tenantParams(tenant), sid: s(sessionId) };
    const session = this.bq.run(
      `SELECT session_id, channel, status, started_at, updated_at, closed_at FROM ${this.t.sessions} ` +
        `WHERE ${TENANT} AND session_id = @sid LIMIT 1`,
      base,
      { maxRows: 1 },
    )[0];
    if (!session) throw notFound("Sessão não encontrada.");
    this.audit.record(
      { actor: actor.email, tenant, action: "session.view", entityType: "session", entityId: sessionId, outcome: "SUCCESS", requestId },
      { failClosed: true },
    );
    const window = { ...base, lo: ts(String(session.started_at)), span: i(120) };
    const messages = this.bq
      .run(
        `SELECT message_id, sender_type, content, created_at, sequence_number FROM ${this.t.messages} ` +
          `WHERE ${TENANT} AND session_id = @sid AND created_at >= TIMESTAMP_SUB(@lo, INTERVAL 1 DAY) ` +
          "AND created_at <= TIMESTAMP_ADD(@lo, INTERVAL @span DAY) ORDER BY sequence_number, message_id LIMIT 2001",
        window,
        { maxRows: MAX_MESSAGES + 1 },
      )
      .slice(0, MAX_MESSAGES)
      .map((m) => ({ ...m, content: maskPii(String(m.content ?? "")).slice(0, MAX_MESSAGE_CHARS) }));
    const analyses = this.bq.run(
      `SELECT analysis_id, rubric_id, rubric_version, analysis_status, overall_score, approval_status, approval_reason, model, prompt_version, ` +
        `analysis_mode, estimated_cost_usd, completed_at FROM ${this.t.results} WHERE ${TENANT} AND session_id = @sid ORDER BY completed_at DESC`,
      base,
      { maxRows: 50 },
    ).map(withReason);
    const ids = analyses.map((a) => String(a.analysis_id));
    const criteria = ids.length
      ? this.bq.run(
          `SELECT analysis_id, criterion_id, criterion_weight, evaluation_result, normalized_score, weighted_score, applicability_status, ` +
            `confidence, evidence_message_ids FROM ${this.t.criterionResultsRaw} ` +
            `WHERE ${TENANT} AND session_id = @sid AND analysis_id IN UNNEST(@ids) AND evaluated_at >= TIMESTAMP_SUB(@lo, INTERVAL 1 DAY) ` +
            "QUALIFY ROW_NUMBER() OVER (PARTITION BY analysis_id, criterion_id ORDER BY evaluated_at DESC) = 1 ORDER BY analysis_id, criterion_id",
          { ...window, ids: { t: "ARRAY", of: "STRING", v: ids } },
          { maxRows: 2000 },
        )
      : [];
    const decisions = this.bq.run(
      `SELECT decision_id, analysis_id, decision, comment, reviewer_email, decided_at FROM ${this.t.decisions} ` +
        `WHERE ${TENANT} AND session_id = @sid ORDER BY decided_at DESC LIMIT 50`,
      base,
      { maxRows: 50 },
    );
    return { session, messages, analyses, criteria, decisions, truncated: messages.length === MAX_MESSAGES, maskedNote: "CPF, CNPJ, e-mail e telefone são mascarados; nomes não." };
  }
}

