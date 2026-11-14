import { STATUS } from "../components/Badge";
import { fmtDt, fmtInt, fmtUsd } from "./format";
import type { PipelineOverview } from "./types";

/** What a component is doing for this workspace: its label, a tone ("" is neutral) and a detail line. */
export type NodeState = [label: string, tone: "" | "ok" | "warn" | "info", detail: string];

/** A request waiting longer than this is not being picked up: the executor is woken every few minutes. */
export const EXEC_WAIT_WARN_MIN = 30;

const n = (v: unknown): number => Number(v) || 0;
const plural = (count: number, one: string, many: string): string => `${fmtInt(count)} ${count === 1 ? one : many}`;
const first = <T>(rows: T[] | undefined): T | null => rows?.[0] ?? null;

/** "há 12 min", "há 3 h", "há 2 dias": how long ago something happened, for the nodes that say a request has been waiting. */
export function agoText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `há ${m} min` : m < 2880 ? `há ${Math.round(m / 60)} h` : `há ${Math.round(m / 1440)} dias`;
}

/** The live worker's events by outcome: handled (all), evaluated (paid analysis), repeated (same content, no cost), refused (budget, rate limit...), and the last one. */
export function liveSummary(o: PipelineOverview): { handled: number; evaluated: number; repeated: number; refused: number; last: string | null } {
  const r = { handled: 0, evaluated: 0, repeated: 0, refused: 0, last: null as string | null };
  for (const x of o.liveEvents ?? []) {
    const c = n(x.events);
    r.handled += c;
    if (x.run_status === "EVALUATED") r.evaluated += c;
    else if (x.run_status === "DUPLICATE_CONTENT") r.repeated += c;
    else r.refused += c;
    if (x.last_at && (!r.last || x.last_at > r.last)) r.last = x.last_at;
  }
  return r;
}

/** The executor's queue (administrators only): how many wait, for how long, how many run, and the last request that finished. */
export function execQueue(o: PipelineOverview): { visible: boolean; waiting: number; running: number; oldest: string | null; last: { at: string; status: string } | null } {
  const q = { visible: Boolean(first(o.execVisible)?.visible), waiting: 0, running: 0, oldest: null as string | null, last: null as { at: string; status: string } | null };
  for (const x of o.executor ?? []) {
    const c = n(x.requests);
    if (x.status === "REQUESTED") {
      q.waiting += c;
      if (x.oldest_at && (!q.oldest || x.oldest_at < q.oldest)) q.oldest = x.oldest_at;
    } else if (x.status === "RUNNING") q.running += c;
    else if (x.last_at && (!q.last || x.last_at > q.last.at)) q.last = { at: x.last_at, status: x.status };
  }
  return q;
}

/** The analyses that are still the current one (latest per session and rubric): the sum of the results by status. */
export const currentAnalyses = (o: PipelineOverview): number => (o.results ?? []).reduce((a, r) => a + n(r.analyses), 0);

export function archState(id: string, o: PipelineOverview, now: number = Date.now()): NodeState {
  const models = o.models ?? [];
  const run = first(o.lastRun);
  const used = (mode: string) => models.some((m) => m.analysis_mode === mode) || run?.processing_mode === mode;
  // Two different counts, never mixed: EXECUTED = every analysis that ran and was paid (cost view); CURRENT = the latest one per session and rubric (results).
  const analyses = n(first(o.cost)?.analyses);
  const current = currentAnalyses(o);
  const sessions = n(first(o.source)?.sessions);
  const decided = n(first(o.decided)?.decided);
  if (id === "conversations") return sessions ? ["Em uso", "ok", `${fmtInt(sessions)} sessões`] : ["Sem dados", "", "Nenhuma sessão"];
  if (id === "rubrics") {
    const rt = n(first(o.rubricCount)?.total);
    const rp = n(first(o.rubricCount)?.published);
    return rt ? ["Em uso", "ok", `${plural(rt, "rubrica", "rubricas")} · ${plural(rp, "publicada", "publicadas")}`] : ["Sem rubricas", "", "Nenhuma rubrica"];
  }
  // What the live worker handled: one row per event, whose status is the outcome (EVALUATED, DUPLICATE_CONTENT, BUDGET_BLOCKED, ...).
  const lv = liveSummary(o);
  if (id === "live") {
    return lv.handled
      ? ["Em uso", "ok", `${plural(lv.evaluated, "analisada", "analisadas")} · ${plural(lv.repeated, "repetida", "repetidas")}${lv.refused ? ` · ${plural(lv.refused, "recusada", "recusadas")}` : ""}`]
      : ["Sem atividade", "warn", "Nenhum aviso tratado ainda"];
  }
  if (id === "event") return lv.handled ? ["Em uso", "ok", `${plural(lv.handled, "aviso tratado", "avisos tratados")} · último: ${fmtDt(lv.last)}`] : ["Sem avisos", "warn", "Nenhum aviso tratado ainda"];
  if (id === "queue") return lv.handled ? ["Em uso", "ok", "Junta os avisos de cada sessão antes de analisar"] : ["Sem atividade", "warn", "Nenhum aviso agendado ainda"];
  if (id === "inbox") return ["Sob demanda", "", "Recebe do produtor"];
  if (id === "ingest") return ["Sob demanda", "", "Grava as conversas recebidas"];
  if (id === "executor" || id === "schedules") {
    const eq = execQueue(o);
    if (!eq.visible) return ["Restrito", "", "Visível para administradores"];
    if (id === "schedules") {
      const sc = first(o.schedules);
      const act = n(sc?.active);
      const pau = n(sc?.paused);
      if (act) return ["Em uso", "ok", `${plural(act, "agenda ativa", "agendas ativas")}${sc?.next_run ? ` · próxima: ${fmtDt(sc.next_run)}` : ""}${pau ? ` · ${plural(pau, "pausada", "pausadas")}` : ""}`];
      return pau ? ["Pausadas", "warn", plural(pau, "agenda pausada", "agendas pausadas")] : ["Sem agendas", "", "Crie em Execuções › Agendas"];
    }
    if (eq.waiting) {
      const waited = eq.oldest ? now - Date.parse(eq.oldest) : 0;
      const what = `${plural(eq.waiting, "execução esperando", "execuções esperando")} ${agoText(waited)}`;
      return waited > EXEC_WAIT_WARN_MIN * 60000 ? ["Execução parada", "warn", `${what}: o worker sob demanda ainda não começou`] : ["Execução na fila", "info", what];
    }
    if (eq.running) return ["Rodando", "info", plural(eq.running, "execução em andamento", "execuções em andamento")];
    return eq.last ? ["Em uso", "ok", `Última execução: ${(STATUS[eq.last.status]?.[0] ?? eq.last.status).toLowerCase()} · ${fmtDt(eq.last.at)}`] : ["Sob demanda", "", "Nenhuma execução ainda"];
  }
  if (id === "engine") return analyses ? ["Em uso", "ok", `${fmtInt(analyses)} executadas · ${fmtInt(current)} vigentes`] : ["Sem análises", "", "—"];
  if (id === "budget") return ["Sempre ativo", "ok", "Recusa acima do teto"];
  if (id === "openai") return models.length ? ["Em uso", "ok", `Custo total · ${fmtUsd(first(o.cost)?.cost_usd)}`] : ["Sem uso", "", "Nenhuma chamada"];
  if (id === "results") return current ? ["Em uso", "ok", `${fmtInt(current)} análises vigentes`] : ["Vazio", "", "Sem resultados"];
  return ["Você está aqui", "info", `${fmtInt(decided)} revisões decididas`];
}

type Rule = { type?: string; criterion_id?: string; equals?: string[]; rules?: unknown[]; conditions?: Array<{ criterion_id: string; equals: string[] }> };

/** The applicability rule of a criterion, in words. A published rubric stores `conditions` (all of them must hold); older shapes are `depends_on` and `all_of`. */
export function ruleText(r: Rule | null | undefined): string {
  if (!r) return "Sempre";
  if (r.conditions?.length) return r.conditions.map((c) => `Se ${c.criterion_id} = ${c.equals.join(" ou ")}`).join(" e ");
  if (r.type === "depends_on") return `Se ${r.criterion_id} = ${(r.equals ?? []).join(" ou ")}`;
  if (r.type === "all_of") return (r.rules ?? []).map((x) => ruleText(x as Rule)).join(" e ");
  return "Regra condicional";
}
