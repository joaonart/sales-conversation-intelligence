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

  /**
   * The filters shared by the page query and the count. The period is `from`/`to` (at most 366 days, like Sessões); without them it is
   * the last `days` days, so older callers keep working. Every other filter is an exact match on a value of the run.
   */
  private filters(tenant: Tenant, payload: Record<string, unknown>): { where: string; params: Params } {
    let where = TENANT;
    let params: Record<string, Param> = { ...tenantParams(tenant) };
    if (payload.from !== undefined || payload.to !== undefined) {
      const from = v.date(payload.from, "from");
      const to = v.date(payload.to, "to");
      if (from > to) throw invalid("O período é inválido.");
      if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) throw invalid("O período máximo é de 366 dias.");
      params = { ...params, from: d(from), to: d(to) };
      where += " AND DATE(created_at) BETWEEN @from AND @to";
    } else {
      params = { ...params, days: i(v.int(payload.days ?? 30, "days", 1, 365)) };
      where += " AND DATE(created_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)";
    }
    const exact = (key: string, column: string, label: string): void => {
      if (payload[key] === undefined || payload[key] === "") return;
      params = { ...params, [key]: s(v.id(payload[key], label)) };
      where += ` AND ${column} = @${key}`;
    };
    exact("status", "run_status", "status");
    exact("mode", "processing_mode", "modo");
    exact("rubric", "rubric_id", "rubrica");
    exact("query", "run_id", "execução");
    return { where, params };
  }

  list(tenant: Tenant, payload: Record<string, unknown>): Page<TsCursor> {
    const limit = v.int(payload.limit ?? 50, "limit", 1, MAX_PAGE);
    const cursor = parseTsCursor(payload.cursor);
    const { where, params } = this.filters(tenant, payload);
    const rows = this.bq.run(
      `SELECT run_id, rubric_id, rubric_version, processing_mode, run_status, sessions_total, sessions_processed, sessions_failed, sessions_skipped, ` +
        `estimated_cost_usd, actual_cost_usd, created_at, finished_at, ${cursorTsSelect("created_at")} FROM ${this.t.runs} ` +
        `WHERE ${where}${cursor ? ` AND ${afterTs("created_at", "run_id")}` : ""} ` +
        "ORDER BY created_at DESC, run_id ASC LIMIT @limit",
      { ...params, ...tsCursorParams(cursor), limit: i(limit + 1) },
      { maxRows: limit + 1 },
    );
    return tsPage(rows, limit, "run_id");
  }

  count(tenant: Tenant, payload: Record<string, unknown>): { total: number } {
    const { where, params } = this.filters(tenant, payload);
    const row = this.bq.run(`SELECT COUNT(*) AS total FROM ${this.t.runs} WHERE ${where}`, params, { maxRows: 1 })[0];
    return { total: Number(row?.total ?? 0) };
  }

  /**
   * One run and, when it has any, why its sessions failed (counts by cause). The failure rows are optional: a run that finished before they were
   * recorded, or an environment without the table yet, shows `failures.available = false` instead of an error.
   */
  get(tenant: Tenant, payload: Record<string, unknown>): { run: Row; failures: { available: boolean; total: number; by_code: Row[] } } {
    const runId = v.id(payload.run_id, "run_id");
    const run = this.bq.run(
      "SELECT run_id, rubric_id, rubric_version, processing_mode, run_status, sessions_total, sessions_processed, sessions_failed, sessions_skipped, " +
        `estimated_cost_usd, actual_cost_usd, created_at, finished_at FROM ${this.t.runs} WHERE ${TENANT} AND run_id = @run_id ` +
        "AND DATE(created_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 365 DAY) LIMIT 1",
      { ...tenantParams(tenant), run_id: s(runId) },
      { maxRows: 1 },
    )[0];
    if (!run) throw notFound("Execução não encontrada neste workspace.");
    let byCode: Row[] = [];
    let available = true;
    try {
      byCode = this.bq.run(
        `SELECT error_code, COUNT(*) AS n FROM ${this.t.failures} WHERE ${TENANT} AND run_id = @run_id ` +
          "AND DATE(occurred_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 365 DAY) GROUP BY error_code ORDER BY n DESC, error_code ASC LIMIT 50",
        { ...tenantParams(tenant), run_id: s(runId) },
        { maxRows: 50 },
      );
    } catch {
      available = false; // the table does not exist yet in this environment
    }
    return { run, failures: { available, total: byCode.reduce((n, r) => n + Number(r.n ?? 0), 0), by_code: byCode } };
  }

  /** The failed sessions of one run, newest first, one page at a time. */
  failures(tenant: Tenant, payload: Record<string, unknown>): Page<TsCursor> {
    const runId = v.id(payload.run_id, "run_id");
    const limit = v.int(payload.limit ?? 25, "limit", 1, MAX_PAGE);
    const cursor = parseTsCursor(payload.cursor);
    const rows = this.bq.run(
      `SELECT failure_id, session_id, stage, error_code, error_type, http_status, provider_code, occurred_at, ${cursorTsSelect("occurred_at")} ` +
        `FROM ${this.t.failures} WHERE ${TENANT} AND run_id = @run_id AND DATE(occurred_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 365 DAY)` +
        `${cursor ? ` AND ${afterTs("occurred_at", "failure_id")}` : ""} ORDER BY occurred_at DESC, failure_id ASC LIMIT @limit`,
      { ...tenantParams(tenant), run_id: s(runId), ...tsCursorParams(cursor), limit: i(limit + 1) },
      { maxRows: limit + 1 },
    );
    return tsPage(rows, limit, "failure_id");
  }

  /** Values present in the period, to fill the status, mode and rubric filters. Three small columns of the same bounded range. */
  facets(tenant: Tenant, payload: Record<string, unknown>): { statuses: string[]; modes: string[]; rubrics: string[] } {
    const { where, params } = this.filters(tenant, { from: payload.from, to: payload.to, days: payload.days });
    const rows = this.bq.run(
      `SELECT DISTINCT run_status, processing_mode, rubric_id FROM ${this.t.runs} WHERE ${where} LIMIT 500`,
      params,
      { maxRows: 500 },
    );
    const uniq = (key: string): string[] => [...new Set(rows.map((r) => r[key]).filter((x): x is string => typeof x === "string" && x !== ""))].sort();
    return { statuses: uniq("run_status"), modes: uniq("processing_mode"), rubrics: uniq("rubric_id") };
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
    // The Painel counts analyses by the DAY OF THE ANALYSIS: this filter lists exactly those sessions (it needs both ends, and an analysis).
    const hasFrom = payload.analysed_from !== undefined && payload.analysed_from !== "";
    const hasTo = payload.analysed_to !== undefined && payload.analysed_to !== "";
    if (hasFrom || hasTo) {
      if (!(hasFrom && hasTo)) throw invalid("Informe o início e o fim do período da análise.");
      const af = v.date(payload.analysed_from, "analisada de");
      const at = v.date(payload.analysed_to, "analisada até");
      if (af > at) throw invalid("O período da análise é inválido.");
      if ((Date.parse(at) - Date.parse(af)) / 86_400_000 > 366) throw invalid("O período máximo é de 366 dias.");
      params.af = d(af);
      params.at = d(at);
      where += " AND r.analysis_id IS NOT NULL AND DATE(r.completed_at) BETWEEN @af AND @at";
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
    // Criterion names live in the (immutable) rubric version that produced each analysis; the result rows only carry the id.
    const rubricIds = [...new Set(analyses.map((a) => String(a.rubric_id)))];
    const names = new Map<string, string>();
    if (criteria.length && rubricIds.length) {
      this.bq
        .run(
          `SELECT rubric_id, rubric_version, criterion_id, criterion_name FROM ${this.t.criteria} ` +
            `WHERE ${TENANT} AND rubric_id IN UNNEST(@rids)`,
          { ...tenantParams(tenant), rids: { t: "ARRAY", of: "STRING", v: rubricIds } },
          { maxRows: 2000 },
        )
        .forEach((r) => names.set(`${r.rubric_id}|${r.rubric_version}|${r.criterion_id}`, String(r.criterion_name ?? "")));
      const rubricOf = new Map(analyses.map((a) => [String(a.analysis_id), `${a.rubric_id}|${a.rubric_version}`]));
      criteria.forEach((c) => {
        const name = names.get(`${rubricOf.get(String(c.analysis_id))}|${c.criterion_id}`);
        if (name) c.criterion_name = name;
      });
    }
    const decisions = this.bq.run(
      `SELECT decision_id, analysis_id, decision, comment, reviewer_email, decided_at FROM ${this.t.decisions} ` +
        `WHERE ${TENANT} AND session_id = @sid ORDER BY decided_at DESC LIMIT 50`,
      base,
      { maxRows: 50 },
    );
    return { session, messages, analyses, criteria, decisions, truncated: messages.length === MAX_MESSAGES, maskedNote: "CPF, CNPJ, e-mail e telefone são mascarados; nomes não." };
  }
}


/** Live numbers for the "Como funciona" page: where the workspace's data currently sits along the pipeline. Read-only, tenant-scoped. */
export class PipelineService {
  constructor(private readonly bq: Bq, private readonly t: Tables) {}

  overview(tenant: Tenant): Record<string, Row[]> {
    const p: Params = tenantParams(tenant);
    return {
      // A year of partitions bounds the scan; the source tables are partitioned by session start.
      source: this.bq.run(
        `SELECT COUNT(*) AS sessions FROM ${this.t.sessions} WHERE ${TENANT} AND started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 365 DAY)`,
        p,
        { maxRows: 1 },
      ),
      results: this.bq.run(
        `SELECT analysis_status, approval_status, COUNT(*) AS analyses FROM ${this.t.results} WHERE ${TENANT} GROUP BY analysis_status, approval_status`,
        p,
        { maxRows: 50 },
      ),
      decided: this.bq.run(`SELECT COUNT(DISTINCT analysis_id) AS decided FROM ${this.t.decisions} WHERE ${TENANT}`, p, { maxRows: 1 }),
      cost: this.bq.run(`SELECT SUM(analyses) AS analyses, SUM(cost_usd) AS cost_usd FROM ${this.t.dailyCost} WHERE ${TENANT}`, p, { maxRows: 1 }),
      models: this.bq.run(
        `SELECT model, analysis_mode, SUM(analyses) AS analyses, SUM(cost_usd) AS cost_usd FROM ${this.t.dailyCost} WHERE ${TENANT} GROUP BY model, analysis_mode ORDER BY cost_usd DESC, analyses DESC`,
        p,
        { maxRows: 10 },
      ),
      lastRun: this.bq.run(
        `SELECT processing_mode, run_status, sessions_processed, created_at FROM ${this.t.runs} WHERE ${TENANT} ORDER BY created_at DESC LIMIT 1`,
        p,
        { maxRows: 1 },
      ),
    };
  }
}
