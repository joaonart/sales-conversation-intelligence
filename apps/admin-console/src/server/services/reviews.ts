import { d, i, s, type Bq, type Param, type Params } from "../bq";
import { conflict, invalid, notFound } from "../errors";
import { maskPii } from "../mask";
import { MAX_PAGE, afterTs, cursorTsSelect, parseTsCursor, tsCursorParams, tsPage, type Page, type TsCursor } from "../paging";
import { TENANT, type Tables } from "../sql";
import type { Row, Tenant } from "../types";
import * as v from "../validate";

/** What the reviewer concluded about an analysis the engine sent to NEEDS_REVIEW. It never changes the analysis, its score or its status. */
export const DECISIONS = ["CONFIRMED", "DISAGREED", "REANALYSIS"] as const;
export type Decision = (typeof DECISIONS)[number];
const FILTERS = ["pending", "decided", "all"] as const;
/** Why an analysis is in the queue: evidence missing in some criteria, a conversation too short to evaluate, or an uncertain decision (the console words them). */
const REASONS = ["INSUFFICIENT", "SHORT", "UNCERTAIN"] as const;
const MAX_COMMENT = 1000;

const tenantParams = (t: Tenant): Params => ({ org: s(t.organization_id), ws: s(t.workspace_id) });

export interface ReviewPorts {
  newId(): string;
  /** Serialises writes across concurrent executions so two reviewers cannot both decide the same analysis. */
  withLock<T>(fn: () => T): T;
}

export class ReviewService {
  constructor(
    private readonly bq: Bq,
    private readonly t: Tables,
    private readonly ports: ReviewPorts,
  ) {}

  /**
   * The CTEs both the page and the count read from: the queue in the window, the criteria counts when something needs them, and the latest decision per
   * analysis. Period: `from`/`to` (at most 366 days) or, without them, the last `days`. The reason filter needs the criteria counts, so it turns them on.
   */
  private base(tenant: Tenant, payload: Record<string, unknown>, withCriteria: boolean): { cte: string; where: string; params: Params; joinCriteria: boolean } {
    const filter = v.oneOf(payload.filter ?? "pending", FILTERS, "filtro");
    const given = (key: string): boolean => payload[key] !== undefined && payload[key] !== "";
    let params: Record<string, Param> = { ...tenantParams(tenant) };
    let qWindow: string;
    let crWindow: string;
    if (payload.from !== undefined || payload.to !== undefined) {
      const from = v.date(payload.from, "from");
      const to = v.date(payload.to, "to");
      if (from > to) throw invalid("O período é inválido.");
      if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) throw invalid("O período máximo é de 366 dias.");
      params = { ...params, from: d(from), to: d(to) };
      qWindow = "DATE(completed_at) BETWEEN @from AND @to";
      crWindow = "DATE(evaluated_at) BETWEEN DATE_SUB(@from, INTERVAL 1 DAY) AND DATE_ADD(@to, INTERVAL 1 DAY)";
    } else {
      params = { ...params, days: i(v.int(payload.days ?? 90, "days", 1, 365)) };
      qWindow = "DATE(completed_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)";
      crWindow = "evaluated_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)";
    }
    const conds: string[] = filter === "pending" ? ["dec.analysis_id IS NULL"] : filter === "decided" ? ["dec.analysis_id IS NOT NULL"] : [];
    let needCriteria = withCriteria;
    if (given("rubric")) {
      params = { ...params, rubric: s(v.id(payload.rubric, "rubrica")) };
      conds.push("q.rubric_id = @rubric");
    }
    if (given("query")) {
      params = { ...params, sid: s(v.id(payload.query, "sessão")) };
      conds.push("q.session_id = @sid");
    }
    if (given("decision")) {
      params = { ...params, decision: s(v.oneOf(payload.decision, DECISIONS, "decisão")) };
      conds.push("dec.decision = @decision");
    }
    if (given("reviewer")) {
      params = { ...params, reviewer: s(v.email(payload.reviewer, "revisor")) };
      conds.push("dec.reviewer_email = @reviewer");
    }
    if (given("reason")) {
      const reason = v.oneOf(payload.reason, REASONS, "motivo");
      needCriteria = true;
      conds.push(reason === "INSUFFICIENT" ? "cr.insufficient > 0" : reason === "SHORT" ? "COALESCE(cr.criteria, 0) = 0" : "cr.criteria > 0 AND COALESCE(cr.insufficient, 0) = 0");
    }
    const cr = needCriteria
      ? ", cr AS (SELECT analysis_id, COUNT(*) AS criteria, COUNTIF(applicability_status = 'INSUFFICIENT_EVIDENCE') AS insufficient FROM (" +
        `SELECT analysis_id, criterion_id, applicability_status FROM ${this.t.criterionResultsRaw} ` +
        `WHERE organization_id = @org AND workspace_id = @ws AND ${crWindow} ` +
        "QUALIFY ROW_NUMBER() OVER (PARTITION BY analysis_id, criterion_id ORDER BY evaluated_at DESC) = 1) GROUP BY analysis_id)"
      : "";
    const cte =
      `WITH q AS (SELECT session_id, rubric_id, rubric_version, analysis_id, completed_at FROM ${this.t.reviewQueue} ` +
      `WHERE organization_id = @org AND workspace_id = @ws AND ${qWindow})` +
      cr +
      `, dec AS (SELECT analysis_id, decision, decided_at, reviewer_email FROM ${this.t.decisions} WHERE ${TENANT} ` +
      "QUALIFY ROW_NUMBER() OVER (PARTITION BY analysis_id ORDER BY decided_at DESC) = 1) ";
    return { cte, where: conds.join(" AND "), params, joinCriteria: needCriteria };
  }

  /** The queue with the reason each analysis is there, one page at a time. `pending` (default) hides analyses that already have a decision. */
  list(tenant: Tenant, payload: Record<string, unknown>): Page<TsCursor> {
    const limit = v.int(payload.limit ?? 50, "limit", 1, MAX_PAGE);
    const cursor = parseTsCursor(payload.cursor);
    const { cte, where, params } = this.base(tenant, payload, true);
    const conds = [where, cursor ? afterTs("q.completed_at", "q.analysis_id") : ""].filter(Boolean);
    const rows = this.bq.run(
      `${cte}SELECT q.session_id, q.rubric_id, q.rubric_version, q.analysis_id, q.completed_at, ${cursorTsSelect("q.completed_at")}, cr.criteria, cr.insufficient, ` +
        "dec.decision, dec.decided_at, dec.reviewer_email FROM q LEFT JOIN cr USING (analysis_id) LEFT JOIN dec USING (analysis_id) " +
        `${conds.length ? `WHERE ${conds.join(" AND ")} ` : ""}ORDER BY q.completed_at DESC, q.analysis_id ASC LIMIT @limit`,
      { ...params, ...tsCursorParams(cursor), limit: i(limit + 1) },
      { maxRows: limit + 1 },
    );
    return tsPage(rows, limit, "analysis_id");
  }

  /** Exact total for the same filters, asked for on demand. */
  count(tenant: Tenant, payload: Record<string, unknown>): { total: number } {
    const { cte, where, params, joinCriteria } = this.base(tenant, payload, false);
    const row = this.bq.run(
      `${cte}SELECT COUNT(*) AS total FROM q ${joinCriteria ? "LEFT JOIN cr USING (analysis_id) " : ""}LEFT JOIN dec USING (analysis_id)${where ? ` WHERE ${where}` : ""}`,
      params,
      { maxRows: 1 },
    )[0];
    return { total: Number(row?.total ?? 0) };
  }

  /** Values present in the period, to fill the rubric and reviewer filters (the other filters are not applied: they list what exists). */
  facets(tenant: Tenant, payload: Record<string, unknown>): { rubrics: string[]; reviewers: string[] } {
    const { cte, params } = this.base(tenant, { from: payload.from, to: payload.to, days: payload.days, filter: "all" }, false);
    const rows = this.bq.run(`${cte}SELECT DISTINCT q.rubric_id, dec.reviewer_email FROM q LEFT JOIN dec USING (analysis_id) LIMIT 1000`, params, { maxRows: 1000 });
    const uniq = (key: string): string[] => [...new Set(rows.map((r) => r[key]).filter((x): x is string => typeof x === "string" && x !== ""))].sort();
    return { rubrics: uniq("rubric_id"), reviewers: uniq("reviewer_email") };
  }

  /** Records one decision for an analysis that is still in the queue. The free-text comment is masked before it is stored and is never audited. */
  decide(reviewer: string, tenant: Tenant, payload: Record<string, unknown>): { decision_id: string; analysis_id: string; decision: Decision } {
    const sessionId = v.id(payload.sessionId, "sessionId");
    const analysisId = v.id(payload.analysisId, "analysisId");
    const decision = v.oneOf(payload.decision, DECISIONS, "decisão");
    // Confirming needs no justification; disagreeing or asking for a new analysis must say why.
    const comment = maskPii(v.text(payload.comment ?? "", "comentário", MAX_COMMENT, { min: decision === "CONFIRMED" ? 0 : 3 }));
    const base = { ...tenantParams(tenant), sid: s(sessionId), aid: s(analysisId) };
    return this.ports.withLock(() => {
      const queued = this.bq.run(
        `SELECT analysis_id FROM ${this.t.reviewQueue} WHERE ${TENANT} AND session_id = @sid AND analysis_id = @aid LIMIT 1`,
        base,
        { maxRows: 1 },
      )[0];
      if (!queued) throw notFound("Esta análise não está na fila de revisão. Ela pode ter sido substituída por uma análise mais recente.");
      const already = this.bq.run(`SELECT decision_id FROM ${this.t.decisions} WHERE ${TENANT} AND analysis_id = @aid LIMIT 1`, base, { maxRows: 1 })[0];
      if (already) throw conflict("Esta análise já tem uma decisão registrada.");
      const decisionId = this.ports.newId();
      // The guard is repeated inside the statement: even if the lock were bypassed, a second decision for the same analysis inserts nothing.
      this.bq.run(
        `INSERT INTO ${this.t.decisions} (decision_id, decided_at, organization_id, workspace_id, session_id, analysis_id, rubric_id, rubric_version, ` +
          "analysis_status, decision, comment, reviewer_email) " +
          "SELECT @id, CURRENT_TIMESTAMP(), organization_id, workspace_id, session_id, analysis_id, rubric_id, rubric_version, 'NEEDS_REVIEW', @decision, @comment, @by " +
          `FROM ${this.t.reviewQueue} WHERE ${TENANT} AND session_id = @sid AND analysis_id = @aid ` +
          `AND NOT EXISTS (SELECT 1 FROM ${this.t.decisions} d WHERE d.organization_id = @org AND d.workspace_id = @ws AND d.analysis_id = @aid)`,
        { ...base, id: s(decisionId), decision: s(decision), comment: s(comment || null), by: s(reviewer) },
      );
      return { decision_id: decisionId, analysis_id: analysisId, decision };
    });
  }
}
