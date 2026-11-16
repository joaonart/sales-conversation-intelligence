import type { Audit } from "../audit";
import { b, d, f, i, s, type Bq, type Params } from "../bq";
import { conflict, invalid, notFound } from "../errors";
import { maskPii } from "../mask";
import { TENANT, TENANT_ALIASED, type Tables } from "../sql";
import type { Actor, Row, Tenant } from "../types";
import * as v from "../validate";
import { MODEL_CATALOG, type CatalogModel, type ExecLimits, type ExecPorts } from "./executions";

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

/** Stage 2, request side. The suggestions come from ONE call over numbers and answers only (never conversation text); these bound what a request may carry. */
export const PROMPT_MIN_CHARS = 20;
export const PROMPT_MAX_CHARS = 20_000;
const NAME_MAX = 80;
export const MAX_ACTIVE_REQUESTS = 3;
const SYSTEM_TOKENS = 900; // the fixed rules of the call (indicative; the executor's own pre-flight is the authoritative gate)
const OUT_TOKENS_PER_CRITERION = 450; // the worst case the call reserves for each criterion's suggestion
const OUT_TOKENS_OVERALL = 400;
const UNNAMED = "(sem nome)";
/** The API that writes free text: the same one the general evaluation uses. */
const SUGGESTION_PROVIDER = "responses" as const;

export interface PromptEstimate {
  provider: string;
  model: string;
  validated: boolean;
  sample: { analyses: number; sessions: number };
  /** At least MIN_SAMPLE analyses: below it a request is refused (the page says why). */
  enough: boolean;
  prompt_chars: number;
  prompt_tokens: number;
  aggregate_tokens: number;
  system_tokens: number;
  approx_input_tokens: number;
  approx_output_tokens: number;
  estimate_low_usd: number;
  estimate_high_usd: number;
  max_cost_usd: number;
  within_ceiling: boolean;
  notes: string[];
}

export interface SuggestionRequest {
  request_id: string;
  status: string;
  rubric_id: string;
  rubric_version: number;
  period_from: string;
  period_to: string;
  seller_id: string | null;
  prompt_id: string;
  prompt_name: string | null;
  retained: boolean | null;
  max_cost_usd: number;
  estimate_low_usd: number | null;
  estimate_high_usd: number | null;
  actual_cost_usd: number | null;
  provider: string | null;
  model: string | null;
  requested_by: string;
  requested_at: string;
  changed_at: string;
  error: string | null;
}

export interface SavedPrompt {
  prompt_id: string;
  name: string;
  version: number;
  versions: number;
  created_by: string;
  created_at: string;
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

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** What the call would be given about the sample: numbers and the answers of each criterion, never a message. Also what the cost estimate is sized on. */
export function aggregateOf(p: Preview): Record<string, unknown> {
  return {
    rubric: { name: p.rubric.name, version: p.rubric.version },
    period: p.period,
    seller_filter: p.seller !== null,
    sample: p.sample,
    criteria: p.criteria.map((c) => ({
      criterion_id: c.criterion_id, name: c.name, weight: c.weight, required: c.required, minimum_score: c.minimum_score, applicable: c.applicable, avg_score: c.avg_score,
      weak_pct: c.weak_pct, insufficient_pct: c.insufficient_pct, not_applicable_pct: c.not_applicable_pct, below_minimum_pct: c.below_minimum_pct, points_lost: c.points_lost, answers: c.answers,
    })),
  };
}

/** The models the suggestion call may use: the Responses API ones of the closed catalog (the same list the executor enforces). */
export function suggestionModels(): CatalogModel[] {
  return MODEL_CATALOG.models.filter((m) => m.provider === SUGGESTION_PROVIDER);
}

export class PromptImprovementService {
  constructor(
    private readonly bq: Bq,
    private readonly t: Tables,
    private readonly audit: Audit,
    private readonly ports: ExecPorts & { sha256(text: string): string },
    private readonly limits: ExecLimits,
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
  // ---- Stage 2, request side: the prompt, the estimate and the request. Nothing below calls the AI: the suggestions are produced by the executor (a later version). ----

  /** The models the page offers for the suggestion call, with the prices the estimate uses. */
  models(): { models: CatalogModel[]; default: string; min_chars: number; max_chars: number; min_sample: number; ceiling_usd: number } {
    const all = suggestionModels();
    return { models: all, default: (all.find((m) => m.validated) ?? all[0])?.model ?? "", min_chars: PROMPT_MIN_CHARS, max_chars: PROMPT_MAX_CHARS, min_sample: MIN_SAMPLE, ceiling_usd: this.limits.maxCostUsd };
  }

  /** The prompt, the model and the cost ceiling of a call; the same checks for the estimate and for the request. */
  private parseCall(payload: Record<string, unknown>): { prompt: string; model: CatalogModel; maxCost: number } {
    const prompt = v.text(payload.prompt, "prompt", PROMPT_MAX_CHARS);
    if (prompt.length < PROMPT_MIN_CHARS) throw invalid(`O prompt precisa ter ao menos ${PROMPT_MIN_CHARS} caracteres.`);
    const all = suggestionModels();
    const name = payload.model === undefined || payload.model === "" ? (all.find((m) => m.validated) ?? all[0])?.model : v.id(payload.model, "modelo");
    const model = all.find((m) => m.model === name);
    if (!model) throw invalid("Escolha um modelo da lista permitida.");
    return { prompt, model, maxCost: v.num(payload.max_cost_usd, "teto de custo", 0.000001, this.limits.maxCostUsd) };
  }

  /** Whether the prompt is kept for reuse (with a name) or lives only for this request. */
  private parseSave(payload: Record<string, unknown>): { retain: boolean; name: string } {
    const retain = payload.retain === undefined ? false : v.bool(payload.retain, "guardar o prompt");
    const given = payload.name !== undefined && payload.name !== "";
    if (retain && !given) throw invalid("Dê um nome ao prompt para guardá-lo.");
    return { retain, name: given ? v.text(payload.name, "nome do prompt", NAME_MAX, { min: 1 }) : UNNAMED };
  }

  /** Sizes the one call: what it is given (the rules, the prompt, the aggregate) and the worst case of what it writes (one block per criterion). Indicative. */
  private sizing(pv: Preview, prompt: string, model: CatalogModel, maxCost: number): PromptEstimate {
    const promptTokens = Math.ceil(prompt.length / 4);
    const aggregateTokens = Math.ceil(JSON.stringify(aggregateOf(pv)).length / 4);
    const input = SYSTEM_TOKENS + promptTokens + aggregateTokens;
    const output = pv.criteria.length * OUT_TOKENS_PER_CRITERION + OUT_TOKENS_OVERALL;
    const low = (input * model.input_per_million) / 1e6;
    const high = low + (output * model.output_per_million) / 1e6;
    const notes = [
      "É uma única chamada à IA. Ela recebe o seu prompt e os números da prévia (notas, percentuais e as respostas de cada critério); nenhum trecho de conversa é enviado.",
      `Preços de ${model.model} (a tarifa mais alta que pode ser cobrada, conferidos em ${model.verified_on}). O executor refaz o pré-voo com os mesmos preços e recusa o que passar do teto.`,
    ];
    if (!model.validated) notes.push(`${model.model} ainda não foi validado neste sistema: a primeira execução real é o teste, limitada pelo teto do pedido.`);
    return {
      provider: model.provider, model: model.model, validated: model.validated, sample: { analyses: pv.sample.analyses, sessions: pv.sample.sessions }, enough: pv.sample.analyses >= MIN_SAMPLE,
      prompt_chars: prompt.length, prompt_tokens: promptTokens, aggregate_tokens: aggregateTokens, system_tokens: SYSTEM_TOKENS, approx_input_tokens: input, approx_output_tokens: output,
      estimate_low_usd: round6(low), estimate_high_usd: round6(high), max_cost_usd: maxCost, within_ceiling: high <= maxCost, notes,
    };
  }

  /** Read-only estimate of the suggestion call for a prompt and a sample. Spends nothing. */
  estimate(tenant: Tenant, payload: Record<string, unknown>): PromptEstimate {
    const call = this.parseCall(payload);
    return this.sizing(this.preview(tenant, payload), call.prompt, call.model, call.maxCost);
  }

  /** Requests in the last 30 days that no one finished (they count against the limit of waiting requests). */
  private active(tenant: Tenant): Row[] {
    return this.bq.run(
      `SELECT request_id, rubric_id, rubric_version, CAST(period_from AS STRING) AS period_from, CAST(period_to AS STRING) AS period_to, seller_id, prompt_hash, model ` +
        `FROM ${this.t.promptRequests} WHERE ${TENANT} AND DATE(requested_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY) ` +
        "QUALIFY ROW_NUMBER() OVER (PARTITION BY request_id ORDER BY changed_at DESC) = 1 AND status IN ('REQUESTED', 'RUNNING')",
      this.tenantParams(tenant),
      { maxRows: 100 },
    );
  }

  /**
   * Stores the text of the prompt for the request. A kept prompt is found by its name: the same text is reused, a changed one is the next version of the same
   * prompt. A prompt that is not kept lives only for its request: it has its own id and is deleted when the request ends.
   */
  private savePrompt(actor: string, tenant: Tenant, text: string, hash: string, save: { retain: boolean; name: string }): { prompt_id: string; version: number } {
    let promptId = this.ports.newId();
    let version = 1;
    if (save.retain) {
      const same = this.bq.run(
        `SELECT prompt_id, version, content_hash FROM ${this.t.agentPrompts} WHERE ${TENANT} AND retained AND LOWER(name) = LOWER(@name) ` +
          "QUALIFY ROW_NUMBER() OVER (PARTITION BY prompt_id ORDER BY version DESC) = 1 ORDER BY version DESC LIMIT 1",
        { ...this.tenantParams(tenant), name: s(save.name) },
        { maxRows: 1 },
      )[0];
      if (same) {
        promptId = String(same.prompt_id);
        if (same.content_hash === hash) return { prompt_id: promptId, version: Number(same.version) };
        version = Number(same.version) + 1;
      }
    }
    this.bq.run(
      `INSERT INTO ${this.t.agentPrompts} (prompt_id, organization_id, workspace_id, version, name, content, content_hash, retained, created_by, created_at) ` +
        "VALUES (@pid, @org, @ws, @ver, @name, @content, @hash, @retained, @by, CURRENT_TIMESTAMP())",
      { ...this.tenantParams(tenant), pid: s(promptId), ver: i(version), name: s(save.name), content: s(text), hash: s(hash), retained: b(save.retain), by: s(actor) },
    );
    return { prompt_id: promptId, version };
  }

  /** Deletes the text of a prompt that was not kept. Never touches a kept one, whatever the id. */
  private dropPrompt(tenant: Tenant, promptId: string): void {
    this.bq.run(`DELETE FROM ${this.t.agentPrompts} WHERE ${TENANT} AND prompt_id = @pid AND NOT retained`, { ...this.tenantParams(tenant), pid: s(promptId) });
  }

  /**
   * Records the request: the sample, the estimate and the ceiling the person approved, and who asked. Needs an explicit confirmation, a sample of at least
   * MIN_SAMPLE analyses and a ceiling above the worst-case estimate; at most 3 requests wait per workspace. The text of the prompt is stored in agent_prompts
   * (never in the audit trail: only its hash).
   */
  request(actor: string, tenant: Tenant, payload: Record<string, unknown>): { request_id: string; status: "REQUESTED"; prompt_id: string; prompt_version: number; prompt_hash: string; retained: boolean; estimate_high_usd: number } {
    if (payload.confirm !== true) throw invalid("Confirme o pedido e o teto de custo.");
    const call = this.parseCall(payload);
    const save = this.parseSave(payload);
    const sc = scopeOf(payload);
    const est = this.sizing(this.preview(tenant, payload), call.prompt, call.model, call.maxCost);
    if (!est.enough) throw invalid(`Só ${est.sample.analyses} análises neste recorte: o mínimo para sugerir mudanças é ${MIN_SAMPLE}. Amplie o período ou escolha outra versão.`);
    if (!est.within_ceiling) throw invalid(`O teto de US$ ${call.maxCost} é menor que a estimativa máxima de US$ ${est.estimate_high_usd}. Aumente o teto.`);
    const hash = this.ports.sha256(call.prompt);
    return this.ports.withLock(() => {
      const active = this.active(tenant);
      if (active.length >= MAX_ACTIVE_REQUESTS) throw conflict(`Já há ${MAX_ACTIVE_REQUESTS} pedidos de sugestão aguardando neste workspace. Cancele um ou espere.`);
      if (active.some((r) => r.rubric_id === sc.rubric_id && Number(r.rubric_version) === sc.version && r.period_from === sc.from && r.period_to === sc.to && (r.seller_id ?? null) === sc.seller && r.prompt_hash === hash && r.model === call.model.model)) {
        throw conflict("Já existe um pedido igual aguardando.");
      }
      const id = this.ports.newId();
      const saved = this.savePrompt(actor, tenant, call.prompt, hash, save);
      try {
        this.bq.run(
          `INSERT INTO ${this.t.promptRequests} (request_id, changed_at, organization_id, workspace_id, status, rubric_id, rubric_version, period_from, period_to, seller_id, ` +
            "prompt_id, prompt_hash, sample_analyses, sample_sessions, max_cost_usd, estimate_low_usd, estimate_high_usd, actual_cost_usd, provider, model, system_prompt_version, " +
            "requested_by, requested_at, changed_by, error) " +
            "VALUES (@id, CURRENT_TIMESTAMP(), @org, @ws, 'REQUESTED', @rubric, @ver, @from, @to, @seller, @pid, @hash, @analyses, @sessions, @cap, @low, @high, NULL, @provider, @model, NULL, " +
            "@by, CURRENT_TIMESTAMP(), @by, NULL)",
          {
            ...this.tenantParams(tenant), id: s(id), rubric: s(sc.rubric_id), ver: i(sc.version), from: d(sc.from), to: d(sc.to), seller: s(sc.seller), pid: s(saved.prompt_id), hash: s(hash),
            analyses: i(est.sample.analyses), sessions: i(est.sample.sessions), cap: f(call.maxCost), low: f(est.estimate_low_usd), high: f(est.estimate_high_usd),
            provider: s(call.model.provider), model: s(call.model.model), by: s(actor),
          },
        );
      } catch (e) {
        if (!save.retain) this.dropPrompt(tenant, saved.prompt_id); // no request, so no reason to keep the text of a prompt that was not meant to be kept
        throw e;
      }
      return { request_id: id, status: "REQUESTED" as const, prompt_id: saved.prompt_id, prompt_version: saved.version, prompt_hash: hash, retained: save.retain, estimate_high_usd: est.estimate_high_usd };
    });
  }

  /** The requests of the last 90 days, newest first, with the name of the prompt (a prompt that was not kept has no text left, so no name either). */
  requests(tenant: Tenant): SuggestionRequest[] {
    return this.bq
      .run(
        `WITH latest AS (SELECT * FROM ${this.t.promptRequests} WHERE ${TENANT} AND DATE(requested_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY) ` +
          "QUALIFY ROW_NUMBER() OVER (PARTITION BY request_id ORDER BY changed_at DESC) = 1), " +
          `names AS (SELECT prompt_id, ANY_VALUE(name) AS name, LOGICAL_OR(retained) AS retained FROM ${this.t.agentPrompts} WHERE ${TENANT} GROUP BY prompt_id) ` +
          "SELECT l.request_id, l.status, l.rubric_id, l.rubric_version, CAST(l.period_from AS STRING) AS period_from, CAST(l.period_to AS STRING) AS period_to, l.seller_id, l.prompt_id, " +
          "n.name AS prompt_name, n.retained, l.max_cost_usd, l.estimate_low_usd, l.estimate_high_usd, l.actual_cost_usd, l.provider, l.model, l.requested_by, " +
          "CAST(l.requested_at AS STRING) AS requested_at, CAST(l.changed_at AS STRING) AS changed_at, l.error FROM latest l LEFT JOIN names n ON n.prompt_id = l.prompt_id " +
          "ORDER BY l.requested_at DESC, l.request_id LIMIT 50",
        this.tenantParams(tenant),
        { maxRows: 50 },
      )
      .map((r) => ({
        request_id: String(r.request_id), status: String(r.status), rubric_id: String(r.rubric_id), rubric_version: Number(r.rubric_version), period_from: String(r.period_from),
        period_to: String(r.period_to), seller_id: r.seller_id === null || r.seller_id === undefined ? null : String(r.seller_id), prompt_id: String(r.prompt_id),
        prompt_name: r.prompt_name === null || r.prompt_name === undefined ? null : String(r.prompt_name), retained: r.retained === null || r.retained === undefined ? null : Boolean(r.retained),
        max_cost_usd: Number(r.max_cost_usd), estimate_low_usd: r.estimate_low_usd === null || r.estimate_low_usd === undefined ? null : Number(r.estimate_low_usd),
        estimate_high_usd: r.estimate_high_usd === null || r.estimate_high_usd === undefined ? null : Number(r.estimate_high_usd),
        actual_cost_usd: r.actual_cost_usd === null || r.actual_cost_usd === undefined ? null : Number(r.actual_cost_usd),
        provider: r.provider === null || r.provider === undefined ? null : String(r.provider), model: r.model === null || r.model === undefined ? null : String(r.model),
        requested_by: String(r.requested_by), requested_at: String(r.requested_at), changed_at: String(r.changed_at), error: r.error === null || r.error === undefined ? null : String(r.error),
      }));
  }

  /** Cancels a request that no executor has taken yet and deletes the text of its prompt when it was not kept. The status guard is inside the statement. */
  cancel(actor: string, tenant: Tenant, payload: Record<string, unknown>): { request_id: string; status: "CANCELLED"; prompt_deleted: boolean } {
    const id = v.id(payload.request_id, "pedido");
    return this.ports.withLock(() => {
      const cur = this.bq.run(
        `SELECT status, prompt_id FROM ${this.t.promptRequests} WHERE ${TENANT} AND request_id = @id AND DATE(requested_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 365 DAY) ` +
          "ORDER BY changed_at DESC LIMIT 1",
        { ...this.tenantParams(tenant), id: s(id) },
        { maxRows: 1 },
      )[0];
      if (!cur) throw notFound("Pedido não encontrado.");
      if (cur.status !== "REQUESTED") throw conflict("Só é possível cancelar um pedido que ainda não começou.");
      this.bq.run(
        `INSERT INTO ${this.t.promptRequests} (request_id, changed_at, organization_id, workspace_id, status, rubric_id, rubric_version, period_from, period_to, seller_id, ` +
          "prompt_id, prompt_hash, sample_analyses, sample_sessions, max_cost_usd, estimate_low_usd, estimate_high_usd, actual_cost_usd, provider, model, system_prompt_version, " +
          "requested_by, requested_at, changed_by, error) " +
          "SELECT request_id, CURRENT_TIMESTAMP(), organization_id, workspace_id, 'CANCELLED', rubric_id, rubric_version, period_from, period_to, seller_id, prompt_id, prompt_hash, " +
          "sample_analyses, sample_sessions, max_cost_usd, estimate_low_usd, estimate_high_usd, actual_cost_usd, provider, model, system_prompt_version, requested_by, requested_at, @by, NULL " +
          `FROM (SELECT * FROM ${this.t.promptRequests} WHERE ${TENANT} AND request_id = @id QUALIFY ROW_NUMBER() OVER (PARTITION BY request_id ORDER BY changed_at DESC) = 1) WHERE status = 'REQUESTED'`,
        { ...this.tenantParams(tenant), id: s(id), by: s(actor) },
      );
      let deleted = true;
      try {
        this.dropPrompt(tenant, String(cur.prompt_id));
      } catch {
        deleted = false; // the request is cancelled either way; the text of a prompt that was not kept is removed by the workspace cleaner at the latest
        console.error(JSON.stringify({ event: "prompt_cleanup_failed", requestId: id }));
      }
      return { request_id: id, status: "CANCELLED" as const, prompt_deleted: deleted };
    });
  }

  /** The prompts kept for reuse: the latest version of each, by name. No text: opening one is a separate, audited call. */
  prompts(tenant: Tenant): SavedPrompt[] {
    return this.bq
      .run(
        `SELECT prompt_id, name, version, created_by, CAST(created_at AS STRING) AS created_at, COUNT(*) OVER (PARTITION BY prompt_id) AS versions FROM ${this.t.agentPrompts} ` +
          `WHERE ${TENANT} AND retained QUALIFY ROW_NUMBER() OVER (PARTITION BY prompt_id ORDER BY version DESC) = 1 ORDER BY created_at DESC LIMIT 100`,
        this.tenantParams(tenant),
        { maxRows: 100 },
      )
      .map((r) => ({ prompt_id: String(r.prompt_id), name: String(r.name), version: Number(r.version), versions: Number(r.versions), created_by: String(r.created_by), created_at: String(r.created_at) }));
  }

  /** The text of a kept prompt (its latest version). Audited with ids, the version and the size, never the text; fails closed: no audit, no text. */
  prompt(actor: Actor, tenant: Tenant, payload: Record<string, unknown>, requestId: string): { prompt_id: string; name: string; version: number; content: string } {
    const id = v.id(payload.prompt_id, "prompt");
    const row = this.bq.run(
      `SELECT prompt_id, name, version, content, content_hash FROM ${this.t.agentPrompts} WHERE ${TENANT} AND prompt_id = @pid AND retained ` +
        "QUALIFY ROW_NUMBER() OVER (PARTITION BY prompt_id ORDER BY version DESC) = 1",
      { ...this.tenantParams(tenant), pid: s(id) },
      { maxRows: 1 },
    )[0];
    if (!row) throw notFound("Prompt guardado não encontrado.");
    const content = String(row.content ?? "");
    this.audit.record(
      { actor: actor.email, tenant, action: "promptImprovement.openPrompt", entityType: "prompt", entityId: id, outcome: "SUCCESS", requestId, details: { version: Number(row.version), prompt_hash: String(row.content_hash), chars: content.length } },
      { failClosed: true },
    );
    return { prompt_id: id, name: String(row.name), version: Number(row.version), content };
  }

}
