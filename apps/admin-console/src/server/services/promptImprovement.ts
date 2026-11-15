import type { Audit } from "../audit";
import { d, i, s, type Bq, type Params } from "../bq";
import { invalid, notFound } from "../errors";
import { maskPii } from "../mask";
import { TENANT, TENANT_ALIASED, type Tables } from "../sql";
import type { Actor, Row, Tenant } from "../types";
import * as v from "../validate";

/** Fewer applicable evaluations than this and a criterion's numbers are too thin to change a prompt on: the page says so. */
export const MIN_SAMPLE = 30;
/** A criterion score below this is "weak" (the same limit as sql/analysis/02_criterion_overview.sql, so the two agree). */
export const WEAK_BELOW = 60;
/** At or above this a score is a good example. */
export const GOOD_FROM = 80;
const MAX_PERIOD_DAYS = 366;
const MAX_EXAMPLES = 5;
const EXCERPT_CHARS = 280;
/** Sessions may have started long before they were analysed (a historical run): the sessions table is read this far back from the period. */
const SESSION_LOOKBACK_DAYS = 365;

export interface PreviewCriterion {
  criterion_id: string;
  name: string;
  weight: number;
  required: boolean;
  minimum_score: number | null;
  /** Evaluations of the criterion in the sample (applicable or not). */
  evaluations: number;
  applicable: number;
  avg_score: number | null;
  weak_pct: number | null;
  insufficient_pct: number | null;
  not_applicable_pct: number | null;
  below_minimum_pct: number | null;
  /** Points of the overall score (0-100) this criterion cost on average, over every analysis of the sample. */
  points_lost: number;
  answers: Array<{ answer: string; n: number }>;
  /** At least MIN_SAMPLE applicable evaluations. */
  enough: boolean;
}

export interface Preview {
  rubric: { rubric_id: string; version: number; name: string };
  period: { from: string; to: string };
  seller: string | null;
  weak_below: number;
  min_sample: number;
  sample: { analyses: number; sessions: number; avg_score: number | null; approved: number; rejected: number; needs_review: number };
  enough: boolean;
  criteria: PreviewCriterion[];
}

export interface Example {
  session_id: string;
  analysis_id: string;
  score: number | null;
  answer: string | null;
  evidence: Array<{ message_id: string; sender_type: string; excerpt: string }>;
}

const round = (n: number, digits = 1): number => Math.round(n * 10 ** digits) / 10 ** digits;
const num = (x: unknown): number => (x === null || x === undefined ? 0 : Number(x));
const pct = (part: number, whole: number): number | null => (whole > 0 ? round((100 * part) / whole) : null);

/** The filters every query of this page shares: a published rubric version, a period of analyses and, optionally, one seller. */
interface Scope {
  rubric_id: string;
  version: number;
  from: string;
  to: string;
  seller: string | null;
}

function scopeOf(payload: Record<string, unknown>): Scope {
  const from = v.date(payload.from, "from");
  const to = v.date(payload.to, "to");
  if (from > to) throw invalid("O período é inválido.");
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_PERIOD_DAYS) throw invalid(`O período máximo é de ${MAX_PERIOD_DAYS} dias.`);
  return {
    rubric_id: v.id(payload.rubric_id, "rubrica"),
    version: v.int(payload.version, "versão", 1, 100_000),
    from,
    to,
    seller: payload.seller === undefined || payload.seller === null || payload.seller === "" ? null : v.id(payload.seller, "vendedor"),
  };
}

export class PromptImprovementService {
  constructor(
    private readonly bq: Bq,
    private readonly t: Tables,
    private readonly audit: Audit,
  ) {}

  private tenantParams(t: Tenant): Params {
    return { org: s(t.organization_id), ws: s(t.workspace_id) };
  }

  private params(t: Tenant, sc: Scope): Params {
    return {
      ...this.tenantParams(t),
      rubric: s(sc.rubric_id),
      ver: i(sc.version),
      from: d(sc.from),
      to: d(sc.to),
      weak: i(WEAK_BELOW),
      ...(sc.seller ? { seller: s(sc.seller) } : {}),
    };
  }

  /**
   * The analyses the numbers are about: the latest COMPLETED analysis of each session for the rubric version, started in the period (the same rule as
   * sql/analysis, so the page and those queries agree). With a seller, only the sessions whose latest row has that seller.
   */
  private base(sc: Scope): string {
    const sellerJoin = sc.seller
      ? `JOIN (SELECT session_id FROM ${this.t.currentSessions(`DATE(started_at) BETWEEN DATE_SUB(@from, INTERVAL ${SESSION_LOOKBACK_DAYS} DAY) AND @to`)} WHERE seller_id = @seller) sel ON sel.session_id = a.session_id `
      : "";
    return (
      "analyses AS (SELECT a.analysis_id, a.session_id, a.overall_score, a.approval_status FROM (" +
      `SELECT analysis_id, session_id, overall_score, approval_status FROM ${this.t.analysesRaw} ` +
      `WHERE ${TENANT} AND rubric_id = @rubric AND rubric_version = @ver AND DATE(started_at) BETWEEN @from AND @to AND analysis_status = 'COMPLETED' ` +
      "QUALIFY ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY completed_at DESC, analysis_id DESC) = 1) a " +
      `${sellerJoin})`
    );
  }

  /** The latest result of each criterion of those analyses, with the weight of everything that applied in the same analysis (to split the lost points). */
  private criteriaCte(): string {
    return (
      "results AS (SELECT c.analysis_id, c.criterion_id, c.applicability_status, c.normalized_score, c.criterion_weight, " +
      "JSON_VALUE(c.evaluation_result, '$.answer') AS answer, c.evidence_message_ids, " +
      "SUM(IF(c.applicability_status = 'APPLICABLE', c.criterion_weight, 0)) OVER (PARTITION BY c.analysis_id) AS applicable_weight " +
      `FROM ${this.t.criterionResultsRaw} c JOIN analyses a ON a.analysis_id = c.analysis_id ` +
      `WHERE ${TENANT_ALIASED("c")} AND DATE(c.evaluated_at) BETWEEN @from AND DATE_ADD(@to, INTERVAL 1 DAY) ` +
      "QUALIFY ROW_NUMBER() OVER (PARTITION BY c.analysis_id, c.criterion_id ORDER BY c.evaluated_at DESC) = 1)"
    );
  }

  /** The published rubric versions of the workspace: what the page can be asked about. */
  rubrics(tenant: Tenant): Array<{ rubric_id: string; version: number; name: string }> {
    return this.bq
      .run(
        `SELECT rubric_id, version, name FROM ${this.t.rubrics} WHERE ${TENANT} AND status = 'PUBLISHED' ORDER BY rubric_id, version DESC LIMIT 500`,
        this.tenantParams(tenant),
        { maxRows: 500 },
      )
      .map((r) => ({ rubric_id: String(r.rubric_id), version: Number(r.version), name: String(r.name ?? r.rubric_id) }));
  }

  /** The sellers of the sessions analysed in the period, busiest first. */
  sellers(tenant: Tenant, payload: Record<string, unknown>): Array<{ seller_id: string; sessions: number }> {
    const from = v.date(payload.from, "from");
    const to = v.date(payload.to, "to");
    if (from > to) throw invalid("O período é inválido.");
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_PERIOD_DAYS) throw invalid(`O período máximo é de ${MAX_PERIOD_DAYS} dias.`);
    const window = `DATE(started_at) BETWEEN DATE_SUB(@from, INTERVAL ${SESSION_LOOKBACK_DAYS} DAY) AND @to`;
    return this.bq
      .run(
        `SELECT seller_id, COUNT(DISTINCT session_id) AS sessions FROM ${this.t.currentSessions(window)} ` +
          `WHERE seller_id IS NOT NULL AND session_id IN (SELECT session_id FROM ${this.t.analysesRaw} WHERE ${TENANT} AND DATE(started_at) BETWEEN @from AND @to AND analysis_status = 'COMPLETED') ` +
          "GROUP BY seller_id ORDER BY sessions DESC, seller_id LIMIT 200",
        { ...this.tenantParams(tenant), from: d(from), to: d(to) },
        { maxRows: 200 },
      )
      .map((r) => ({ seller_id: String(r.seller_id), sessions: Number(r.sessions) }));
  }

  /**
   * The free preview: per criterion of a published rubric version, how the analyses of the period went. Every number is counted in BigQuery and
   * computed here, never by the AI; nothing in this method calls the AI or spends anything.
   */
  preview(tenant: Tenant, payload: Record<string, unknown>): Preview {
    const sc = scopeOf(payload);
    const p = this.params(tenant, sc);
    const rubric = this.bq.run(
      `SELECT name FROM ${this.t.rubrics} WHERE ${TENANT} AND rubric_id = @rubric AND version = @ver AND status = 'PUBLISHED' LIMIT 1`,
      p,
      { maxRows: 1 },
    )[0];
    if (!rubric) throw notFound("Rubrica publicada não encontrada neste workspace.");
    const defs = this.bq.run(
      `SELECT criterion_id, criterion_name, weight, required FROM ${this.t.criteria} WHERE ${TENANT} AND rubric_id = @rubric AND rubric_version = @ver AND enabled ORDER BY display_order, criterion_id`,
      p,
      { maxRows: 200 },
    );
    const minimums = this.minimums(p);
    const withBase = `WITH ${this.base(sc)}, ${this.criteriaCte()} `;
    const sample = this.bq.run(
      `WITH ${this.base(sc)} ` +
        "SELECT COUNT(*) AS analyses, COUNT(DISTINCT session_id) AS sessions, AVG(overall_score) AS avg_score, COUNTIF(approval_status = 'APPROVED') AS approved, " +
        "COUNTIF(approval_status = 'REJECTED') AS rejected, COUNTIF(approval_status = 'PENDING') AS needs_review FROM analyses",
      p,
      { maxRows: 1 },
    )[0] ?? ({} as Row);
    const analyses = num(sample.analyses);
    const stats = new Map<string, Row>(
      this.bq
        .run(
          withBase +
            "SELECT r.criterion_id, COUNT(*) AS evaluations, COUNTIF(r.applicability_status = 'APPLICABLE') AS applicable, " +
            "AVG(IF(r.applicability_status = 'APPLICABLE', r.normalized_score, NULL)) AS avg_score, " +
            "COUNTIF(r.applicability_status = 'APPLICABLE' AND r.criterion_weight > 0 AND r.normalized_score < @weak) AS weak_n, " +
            "COUNTIF(r.applicability_status = 'APPLICABLE' AND r.criterion_weight > 0) AS weighted_n, " +
            "COUNTIF(r.applicability_status = 'INSUFFICIENT_EVIDENCE') AS insufficient_n, COUNTIF(r.applicability_status = 'NOT_APPLICABLE') AS not_applicable_n, " +
            "COUNTIF(r.applicability_status = 'APPLICABLE' AND r.normalized_score < m.minimum) AS below_minimum_n, " +
            "SUM(IF(r.applicability_status = 'APPLICABLE', r.criterion_weight * (100 - r.normalized_score) / NULLIF(r.applicable_weight, 0), 0)) AS lost_sum " +
            // at most one minimum per criterion, so the join never multiplies a row
            "FROM results r LEFT JOIN UNNEST(@mins) m ON m.criterion_id = r.criterion_id GROUP BY r.criterion_id",
          { ...p, mins: { t: "STRUCTS", fields: { criterion_id: "STRING", minimum: "FLOAT64" }, v: [...minimums].map(([criterion_id, minimum]) => ({ criterion_id, minimum })) } },
          { maxRows: 200 },
        )
        .map((r) => [String(r.criterion_id), r]),
    );
    const answers = new Map<string, Array<{ answer: string; n: number }>>();
    for (const r of this.bq.run(
      withBase + "SELECT criterion_id, answer, COUNT(*) AS n FROM results WHERE applicability_status = 'APPLICABLE' AND answer IS NOT NULL GROUP BY criterion_id, answer ORDER BY criterion_id, n DESC, answer",
      p,
      { maxRows: 1000 },
    )) {
      const list = answers.get(String(r.criterion_id)) ?? [];
      list.push({ answer: String(r.answer), n: num(r.n) });
      answers.set(String(r.criterion_id), list);
    }
    const criteria: PreviewCriterion[] = defs.map((def) => {
      const id = String(def.criterion_id);
      const st = stats.get(id);
      const applicable = num(st?.applicable);
      const evaluations = num(st?.evaluations);
      const min = minimums.get(id) ?? null;
      return {
        criterion_id: id,
        name: String(def.criterion_name ?? id),
        weight: num(def.weight),
        required: Boolean(def.required),
        minimum_score: min,
        evaluations,
        applicable,
        avg_score: st?.avg_score === null || st?.avg_score === undefined ? null : round(Number(st.avg_score)),
        weak_pct: pct(num(st?.weak_n), num(st?.weighted_n)),
        insufficient_pct: pct(num(st?.insufficient_n), evaluations),
        not_applicable_pct: pct(num(st?.not_applicable_n), evaluations),
        below_minimum_pct: min === null ? null : pct(num(st?.below_minimum_n), applicable),
        points_lost: analyses > 0 ? round(num(st?.lost_sum) / analyses) : 0,
        answers: answers.get(id) ?? [],
        enough: applicable >= MIN_SAMPLE,
      };
    });
    // The criteria that cost the most points first; gates (weight 0) measure nothing and go last, in the rubric's order.
    criteria.sort((a, b) => b.points_lost - a.points_lost || b.weight - a.weight);
    return {
      rubric: { rubric_id: sc.rubric_id, version: sc.version, name: String(rubric.name ?? sc.rubric_id) },
      period: { from: sc.from, to: sc.to },
      seller: sc.seller,
      weak_below: WEAK_BELOW,
      min_sample: MIN_SAMPLE,
      sample: {
        analyses,
        sessions: num(sample.sessions),
        avg_score: sample.avg_score === null || sample.avg_score === undefined ? null : round(Number(sample.avg_score)),
        approved: num(sample.approved),
        rejected: num(sample.rejected),
        needs_review: num(sample.needs_review),
      },
      enough: analyses >= MIN_SAMPLE,
      criteria,
    };
  }

  /** The minimum of the criteria that have one. A project whose table lacks the column has none (the read fails and reads as none). */
  private minimums(p: Params): Map<string, number> {
    try {
      return new Map(
        this.bq
          .run(
            `SELECT criterion_id, minimum_score FROM ${this.t.criteria} WHERE ${TENANT} AND rubric_id = @rubric AND rubric_version = @ver AND enabled AND minimum_score IS NOT NULL`,
            p,
            { maxRows: 200 },
          )
          .map((r) => [String(r.criterion_id), Number(r.minimum_score)] as [string, number]),
      );
    } catch {
      return new Map();
    }
  }

  /**
   * A few real cases of one criterion, with the messages that were cited as evidence (masked and cut short). `weak` = the worst scores, `good` = the best.
   * Reading conversation text is audited like opening a session (with ids and counts only, never text), and it fails closed: no audit, no text.
   */
  examples(actor: Actor, tenant: Tenant, payload: Record<string, unknown>, requestId: string): { kind: string; examples: Example[]; maskedNote: string } {
    const sc = scopeOf(payload);
    const criterion = v.id(payload.criterion_id, "critério");
    const kind = v.oneOf(payload.kind ?? "weak", ["weak", "good"] as const, "tipo");
    const limit = payload.limit === undefined ? 3 : v.int(payload.limit, "limite", 1, MAX_EXAMPLES);
    const p: Params = { ...this.params(tenant, sc), cid: s(criterion), good: i(GOOD_FROM) };
    const order = kind === "weak" ? "ASC" : "DESC";
    const condition = kind === "weak" ? "r.normalized_score < @weak" : "r.normalized_score >= @good";
    const rows = this.bq.run(
      `WITH ${this.base(sc)}, ${this.criteriaCte()}, picked AS (` +
        "SELECT r.analysis_id, a.session_id, r.normalized_score AS score, r.answer, r.evidence_message_ids FROM results r JOIN analyses a ON a.analysis_id = r.analysis_id " +
        `WHERE r.criterion_id = @cid AND r.applicability_status = 'APPLICABLE' AND r.criterion_weight > 0 AND ${condition} ` +
        `ORDER BY r.normalized_score ${order}, a.session_id LIMIT ${limit}), ` +
        "text AS (SELECT message_id, session_id, sender_type, content, sequence_number FROM " +
        `${this.t.messages} WHERE ${TENANT} AND session_id IN (SELECT session_id FROM picked) ` +
        `AND created_at >= TIMESTAMP(DATE_SUB(@from, INTERVAL ${SESSION_LOOKBACK_DAYS} DAY)) AND created_at < TIMESTAMP(DATE_ADD(@to, INTERVAL 2 DAY)) ` +
        "QUALIFY ROW_NUMBER() OVER (PARTITION BY message_id ORDER BY created_at) = 1) " +
        "SELECT p.session_id, p.analysis_id, p.score, p.answer, m.message_id, m.sender_type, m.content, m.sequence_number " +
        `FROM picked p LEFT JOIN UNNEST(p.evidence_message_ids) mid LEFT JOIN text m ON m.session_id = p.session_id AND m.message_id = mid ` +
        `ORDER BY p.score ${order}, p.session_id, m.sequence_number`,
      p,
      { maxRows: 400 },
    );
    this.audit.record(
      {
        actor: actor.email,
        tenant,
        action: "promptImprovement.examples",
        entityType: "criterion",
        entityId: criterion,
        outcome: "SUCCESS",
        requestId,
        details: { rubric_id: sc.rubric_id, version: sc.version, kind, sessions: new Set(rows.map((r) => String(r.session_id))).size },
      },
      { failClosed: true },
    );
    const byAnalysis = new Map<string, Example>();
    for (const r of rows) {
      const key = String(r.analysis_id);
      let ex = byAnalysis.get(key);
      if (!ex) {
        ex = {
          session_id: String(r.session_id),
          analysis_id: key,
          score: r.score === null || r.score === undefined ? null : round(Number(r.score)),
          answer: r.answer === null || r.answer === undefined ? null : String(r.answer),
          evidence: [],
        };
        byAnalysis.set(key, ex);
      }
      if (r.message_id !== null && r.message_id !== undefined && ex.evidence.length < 6) {
        const text = maskPii(String(r.content ?? ""));
        ex.evidence.push({ message_id: String(r.message_id), sender_type: String(r.sender_type ?? ""), excerpt: text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text });
      }
    }
    return { kind, examples: [...byAnalysis.values()], maskedNote: "CPF, CNPJ, e-mail e telefone são mascarados antes de aparecer aqui. Nomes e texto livre não são." };
  }
}
