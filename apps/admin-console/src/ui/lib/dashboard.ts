import type { DashboardSummary } from "./types";

export const SCORE_GRAN: Array<[id: string, label: string]> = [["day", "Dia"], ["week", "Semana"], ["month", "Mês"], ["quarter", "Trimestre"], ["year", "Ano"]];
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const MONTHS_LONG = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
/** The window each grain looks back (the server uses the same numbers; "day" follows the period chosen for the panel). */
export const SCORE_WINDOW: Record<string, string> = { week: "últimas 26 semanas", month: "últimos 24 meses", quarter: "últimos 12 trimestres", year: "últimos 5 anos" };
/** Below this many analyses a model's average says little. */
export const MIN_COMPARABLE = 20;

export interface ChartPoint {
  label: string;
  tip: string;
  value: number;
  /** The bucket is still open today. */
  partial: boolean;
}

/** One chart point from a bucket start date ("YYYY-MM-DD"): a short axis label, a long tooltip, and whether the bucket is still open. */
export function scorePoint(gran: string, bucket: string, value: number, now: number = Date.now()): ChartPoint {
  const y = Number(bucket.slice(0, 4));
  const m = Number(bucket.slice(5, 7)) - 1;
  const dd = Number(bucket.slice(8, 10));
  const day = `${bucket.slice(8, 10)}/${bucket.slice(5, 7)}`;
  const start = Date.UTC(y, m, dd);
  const end = gran === "day" ? start + 864e5 : gran === "week" ? start + 7 * 864e5 : gran === "month" ? Date.UTC(y, m + 1, 1) : gran === "quarter" ? Date.UTC(y, m + 3, 1) : Date.UTC(y + 1, 0, 1);
  let label = day;
  let tip = `${day}/${y}`;
  if (gran === "week") tip = `Semana de ${tip}`;
  else if (gran === "month") {
    label = `${MONTHS[m]}/${String(y).slice(2)}`;
    tip = `${MONTHS_LONG[m]} de ${y}`;
  } else if (gran === "quarter") {
    label = `T${Math.floor(m / 3) + 1}/${String(y).slice(2)}`;
    tip = `${Math.floor(m / 3) + 1}º trimestre de ${y}`;
  } else if (gran === "year") {
    label = String(y);
    tip = String(y);
  }
  return { label, tip, value, partial: end > now };
}

export interface Kpis {
  /** Sessions analysed (distinct conversations) and the workspace's total. */
  covered: number;
  total: number;
  /** Current analyses: the latest per session and rubric; the unit of score, approval, review and the Sessões list. */
  current: number;
  scored: number;
  avgScore: number | null;
  approved: number;
  rejected: number;
  decided: number;
  inReview: number;
  notEvaluable: number;
  cost: number;
  /** Executed: everything that ran and was paid = current + replaced. */
  executed: number;
  executedCurrent: number;
}

/** One vocabulary, and every number reconciles with the next (sessions -> current analyses -> approved + rejected + in review + not evaluable). */
export function kpisOf(d: DashboardSummary): Kpis {
  let scored = 0;
  let sum = 0;
  let approved = 0;
  let rejected = 0;
  let inReview = 0;
  let notEvaluable = 0;
  let current = 0;
  for (const r of d.quality) {
    current += r.sessions;
    scored += r.scored_sessions;
    sum += (r.avg_score || 0) * r.scored_sessions;
    approved += r.approved;
    rejected += r.rejected;
    inReview += r.needs_review;
    notEvaluable += r.not_evaluable;
  }
  const cov = d.coverage[0];
  const models = d.models ?? [];
  const executed = models.reduce((a, m) => a + (Number(m.analyses) || 0), 0);
  const executedCurrent = Math.min(executed, models.reduce((a, m) => a + (Number(m.current_analyses) || 0), 0));
  return {
    covered: Number(cov?.analysed) || 0,
    total: Number(cov?.sessions) || 0,
    current,
    scored,
    avgScore: scored ? sum / scored : null,
    approved,
    rejected,
    decided: approved + rejected,
    inReview,
    notEvaluable,
    cost: d.cost.reduce((a, r) => a + (Number(r.cost_usd) || 0), 0),
    executed,
    executedCurrent,
  };
}

export interface EfficiencyRow {
  provider: string;
  model: string;
  n: number;
  cur: number;
  cost: number;
  done: number;
  perAnalysis: number | null;
  perDone: number | null;
  share: number | null;
}

/** Cost per analysis, share completed, and cost per COMPLETED analysis (it includes what was spent on those that gave no result), cheapest first. */
export function modelEfficiency(rows: DashboardSummary["models"]): EfficiencyRow[] {
  const out = rows.map((r) => {
    const n = Number(r.analyses) || 0;
    const cost = Number(r.cost_usd) || 0;
    const done = Number(r.completed) || 0;
    const cur = Math.min(n, Number(r.current_analyses) || 0);
    return { provider: r.provider, model: r.model, n, cur, cost, done, perAnalysis: n ? cost / n : null, perDone: done ? cost / done : null, share: n ? done / n : null };
  });
  out.sort((a, b) => (a.perDone === null ? Infinity : a.perDone) - (b.perDone === null ? Infinity : b.perDone) || b.n - a.n);
  return out;
}

/** The cheapest model, only when two have a sample large enough to compare. */
export function bestModel(rows: EfficiencyRow[]): EfficiencyRow | null {
  const comparable = rows.filter((r) => r.n >= MIN_COMPARABLE && r.perDone !== null);
  return comparable.length > 1 ? (comparable[0] ?? null) : null;
}
