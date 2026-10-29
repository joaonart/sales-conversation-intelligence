import { i, s, type Bq, type Params } from "../bq";
import { conflict, notFound } from "../errors";
import { maskPii } from "../mask";
import { TENANT, type Tables } from "../sql";
import type { Row, Tenant } from "../types";
import * as v from "../validate";

/** What the reviewer concluded about an analysis the engine sent to NEEDS_REVIEW. It never changes the analysis, its score or its status. */
export const DECISIONS = ["CONFIRMED", "DISAGREED", "REANALYSIS"] as const;
export type Decision = (typeof DECISIONS)[number];
const FILTERS = ["pending", "decided", "all"] as const;
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

  /** The queue with the reason each analysis is there. `pending` (default) hides analyses that already have a decision. */
  list(tenant: Tenant, payload: Record<string, unknown>): Row[] {
    const limit = v.int(payload.limit ?? 100, "limit", 1, 500);
    const days = v.int(payload.days ?? 90, "days", 1, 365);
    const filter = v.oneOf(payload.filter ?? "pending", FILTERS, "filtro");
    const where = filter === "pending" ? "WHERE dec.analysis_id IS NULL" : filter === "decided" ? "WHERE dec.analysis_id IS NOT NULL" : "";
    return this.bq.run(
      `WITH q AS (SELECT session_id, rubric_id, rubric_version, analysis_id, completed_at FROM ${this.t.reviewQueue} ` +
        "WHERE organization_id = @org AND workspace_id = @ws AND DATE(completed_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)), " +
        "cr AS (SELECT analysis_id, COUNT(*) AS criteria, COUNTIF(applicability_status = 'INSUFFICIENT_EVIDENCE') AS insufficient FROM (" +
        `SELECT analysis_id, criterion_id, applicability_status FROM ${this.t.criterionResultsRaw} ` +
        "WHERE organization_id = @org AND workspace_id = @ws AND evaluated_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY) " +
        "QUALIFY ROW_NUMBER() OVER (PARTITION BY analysis_id, criterion_id ORDER BY evaluated_at DESC) = 1) GROUP BY analysis_id), " +
        `dec AS (SELECT analysis_id, decision, decided_at, reviewer_email FROM ${this.t.decisions} WHERE ${TENANT} ` +
        "QUALIFY ROW_NUMBER() OVER (PARTITION BY analysis_id ORDER BY decided_at DESC) = 1) " +
        "SELECT q.session_id, q.rubric_id, q.rubric_version, q.analysis_id, q.completed_at, cr.criteria, cr.insufficient, " +
        "dec.decision, dec.decided_at, dec.reviewer_email FROM q LEFT JOIN cr USING (analysis_id) LEFT JOIN dec USING (analysis_id) " +
        `${where} ORDER BY q.completed_at DESC LIMIT @limit`,
      { ...tenantParams(tenant), days: i(days), limit: i(limit) },
      { maxRows: limit },
    );
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
