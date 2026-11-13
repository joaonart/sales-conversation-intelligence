import { fmtInt, fmtUsd } from "./format";
import type { ExecRow, ScheduleRow } from "./types";

export const EXEC_KIND: Record<string, string> = { ROUTING: "Roteamento", ANALYSIS: "Análise por rubrica", SESSION_ANALYSIS: "Análise de uma sessão" };
export const EXEC_HELP: Record<string, string> = {
  ROUTING: "Classifica cada sessão da janela e grava para qual rubrica ela deve ir. Custo muito baixo: usa só o início da conversa.",
  ANALYSIS: "Roda uma versão publicada da rubrica nas sessões da janela. Com “somente roteadas”, só entram as sessões que o roteamento enviou para ela.",
  SESSION_ANALYSIS: "Analisa uma sessão específica com uma versão publicada. Só gera custo se o conteúdo, a rubrica ou o modelo mudaram.",
};
export const API_LABEL: Record<string, string> = { decisions: "Decisions", responses: "Responses" };
export const PROC_MODE: Record<string, string> = { historical: "Histórico", live: "Ao vivo" };

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The id of the schedule that made a request (it is in the request's params), or null when a person asked for it in the console. */
export function scheduleIdOf(r: Pick<ExecRow, "params">): string | null {
  const id = parseJson(r.params)?.schedule_id;
  return typeof id === "string" && id ? id : null;
}

/** Where a request came from, in words: "Manual" or "Agenda: <name>" (the name, when the schedule is still known; otherwise just that it was a schedule). */
export function originText(r: Pick<ExecRow, "params">, names: ReadonlyMap<string, string>): string {
  const id = scheduleIdOf(r);
  return id === null ? "Manual" : `Agenda: ${names.get(id) ?? "(removida)"}`;
}

/** The parameters of a request on one line. */
export function execSummary(r: Pick<ExecRow, "params">): string {
  const p = parseJson(r.params) ?? {};
  const parts: string[] = [];
  if (p.schedule_id) parts.push("agendada");
  if (p.session_id) parts.push(`sessão ${String(p.session_id)}`);
  if (p.start) parts.push(`${String(p.start)} a ${String(p.end)}`);
  if (p.rubric_id) parts.push(`${String(p.rubric_id)} v${String(p.rubric_version)}`);
  if (p.only_routed) parts.push("somente roteadas");
  if (p.max_sessions) parts.push(`até ${String(p.max_sessions)} sessões`);
  if (p.model) parts.push(`${String(p.model)} (${API_LABEL[String(p.provider)] ?? String(p.provider)})`);
  return parts.join(" · ") || "—";
}

/** What a request produced: the counts and the spend, or why it failed. */
export function execResult(r: Pick<ExecRow, "status" | "error" | "result">): string {
  if (r.status === "FAILED") return r.error || "Falhou";
  const x = parseJson(r.result);
  return x ? `${fmtInt(Number(x.processed) || 0)} ok · ${fmtInt(Number(x.failed) || 0)} falhas · ${fmtUsd(x.spent_usd as number)}` : "—";
}

export const WEEKDAYS = ["segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado", "domingo"];
export const SCHED_STATUS: Record<string, [string, "ok" | "warn" | "neutral"]> = { ACTIVE: ["Ativa", "ok"], PAUSED: ["Pausada", "warn"], ARCHIVED: ["Arquivada", "neutral"] };
const pad2 = (n: number) => (n < 10 ? "0" : "") + n;

/** "02:00 UTC (23:00 no seu horário)": a schedule is stored in UTC, so the screen always says what time that is for the person reading it. */
export function utcTime(hour: number, minute: number): string {
  const local = new Date(Date.UTC(2026, 0, 15, hour, minute));
  return `${pad2(hour)}:${pad2(minute)} UTC (${pad2(local.getHours())}:${pad2(local.getMinutes())} no seu horário)`;
}

export function schedWhen(r: { frequency: string; weekday: number | null; hour_utc: number; minute_utc: number }): string {
  return `${r.frequency === "WEEKLY" ? `Toda ${WEEKDAYS[Number(r.weekday)] ?? "semana"}` : "Todo dia"}, ${utcTime(Number(r.hour_utc), Number(r.minute_utc))}`;
}

/** The causes of a failed session (a closed set from the platform) -> what it means and what to do. Never the raw error: the platform does not store messages or provider bodies. */
export const FAILURE_CODES: Record<string, [string, string]> = {
  PROVIDER_UNAVAILABLE: ["A OpenAI não respondeu a tempo ou limitou o ritmo das chamadas (429 ou erro 5xx), mesmo depois das novas tentativas.", "Rode o mesmo job de novo: só as sessões com falha são tentadas outra vez."],
  PROVIDER_QUOTA: ["A conta da OpenAI está sem saldo ou atingiu o limite de uso.", "Confira o saldo e os limites da conta na OpenAI e rode o job de novo."],
  PROVIDER_AUTH: ["A chave da OpenAI foi recusada (inválida ou sem permissão).", "Confira a chave configurada no executor ou no Secret Manager."],
  PROVIDER_REJECTED: ["A OpenAI recusou o pedido (erro 4xx, por exemplo modelo ou parâmetro inválido).", "Veja o código do provedor na tabela e confira o modelo e a versão do prompt."],
  PROVIDER_CIRCUIT_OPEN: ["As chamadas foram suspensas depois de falhas seguidas do provedor.", "Aguarde alguns minutos e rode o job de novo."],
  INVALID_PROVIDER_RESPONSE: ["O modelo respondeu num formato inesperado.", "Rode de novo. Se repetir na mesma sessão, a conversa ou a rubrica pode estar confundindo o modelo."],
  INPUT_TOO_LARGE: ["A conversa passa do limite de tokens do adaptador e não foi enviada.", "Analise essa sessão à parte ou reduza o conteúdo analisado."],
  PROVIDER_ERROR: ["Erro do provedor de IA sem classificação específica.", "Rode de novo e, se persistir, veja os logs do job com o ID desta execução."],
  RUBRIC_UNAVAILABLE: ["A rubrica não está disponível (não encontrada ou não publicada).", "Confira a rubrica e a versão pedidas."],
  QUERY_TOO_EXPENSIVE: ["Uma consulta ao BigQuery passaria do limite de bytes configurado.", "Reduza a janela de datas."],
  BIGQUERY_ERROR: ["Erro do BigQuery ao ler ou gravar.", "Rode de novo e, se persistir, veja os logs do job e as permissões."],
  TIMEOUT: ["O tempo esgotou antes de a operação terminar.", "Rode de novo."],
  UNEXPECTED: ["Erro inesperado.", "Veja os logs do job com o ID desta execução."],
};
export const FAILURE_STAGE: Record<string, string> = { EVALUATION: "Avaliação", ROUTING: "Roteamento", JOB: "Execução inteira", LIVE: "Ao vivo" };
export const failureText = (code: string): string => FAILURE_CODES[code]?.[0] ?? code;

export const RUN_STATUS_HELP: Record<string, string> = {
  COMPLETED: "Terminou sem falhas.",
  COMPLETED_WITH_FAILURES: "Terminou, mas algumas sessões falharam. Rodar o mesmo job de novo tenta apenas as sessões com falha; as que já foram analisadas são puladas.",
  FAILED: "Parou por um erro que impediu a execução de continuar.",
  BUDGET_STOPPED: "Parou porque a próxima chamada passaria do teto de custo aprovado. Rodar o mesmo job de novo continua de onde parou.",
  SESSION_GATE_STOPPED: "Parou porque o número de sessões passaria do limite aprovado.",
  RUNNING: "Ainda em andamento.",
};

/** The filters of the list of schedules. Everything is applied here, on the rows already loaded: the server returns every schedule of the workspace at once (up to 100). */
export interface ScheduleFilters {
  query: string;
  /** "" = not archived, i.e. active and paused (what the server sends by default), a status, or "ALL" (also the archived ones). */
  status: string;
  rubric: string;
  frequency: string;
  /** "" = any, "NEVER" = has not run yet, or the status of the last request the schedule made. */
  last: string;
}
export const SCHEDULE_DEFAULTS: ScheduleFilters = { query: "", status: "", rubric: "", frequency: "", last: "" };
export const scheduleFiltersDirty = (f: ScheduleFilters): boolean => (Object.keys(SCHEDULE_DEFAULTS) as Array<keyof ScheduleFilters>).some((k) => f[k] !== SCHEDULE_DEFAULTS[k]);
/** Archived schedules are only fetched when the person asks for them. */
export const needsArchived = (f: ScheduleFilters): boolean => f.status === "ARCHIVED" || f.status === "ALL";

export function filterSchedules(rows: ScheduleRow[], f: ScheduleFilters): ScheduleRow[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (!q || r.name.toLowerCase().includes(q)) &&
      (f.status === "" ? r.status !== "ARCHIVED" : f.status === "ALL" || r.status === f.status) &&
      (!f.rubric || r.rubric_id === f.rubric) &&
      (!f.frequency || r.frequency === f.frequency) &&
      (!f.last || (f.last === "NEVER" ? !r.last_request_id : r.last_status === f.last)),
  );
}
