/** What an AI call was paid for. The same words everywhere a cost is shown: the spend ledger names every paid call by one of these steps. */
export const STEP_LABEL: Record<string, string> = { ROUTING: "Roteamento", ANALYSIS: "Análise", EVIDENCE: "Evidência", SUMMARY: "Avaliação geral", SUGGESTION: "Sugestões de prompt" };
/** One sentence each, for a tooltip or a note. */
export const STEP_HELP: Record<string, string> = {
  ROUTING: "Escolhe para qual rubrica a sessão vai.",
  ANALYSIS: "A chamada que responde às perguntas dos critérios.",
  EVIDENCE: "Uma segunda chamada, a outro modelo, que cita as mensagens que sustentam cada resposta.",
  SUMMARY: "A avaliação geral da sessão (pontos fortes, fracos e oportunidades), escrita depois da nota.",
  SUGGESTION: "A chamada que escreve as sugestões de ajuste do prompt de um agente (Melhorar prompt), a partir dos números das análises. Não é de uma sessão.",
};
const ORDER = ["ROUTING", "ANALYSIS", "EVIDENCE", "SUMMARY", "SUGGESTION"];

/** A row of the spend ledger, added up per step and model. */
export interface CostLine {
  kind: string;
  model: string | null;
  calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
}

export const stepLabel = (kind: string): string => STEP_LABEL[kind] ?? kind;

/** In the order the steps happen (routing, analysis, evidence, general evaluation), then by model; a step this page does not know goes last. */
export function sortLines<T extends { kind: string; model?: string | null }>(lines: readonly T[]): T[] {
  const rank = (k: string): number => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);
  return [...lines].sort((a, b) => rank(a.kind) - rank(b.kind) || String(a.model ?? "").localeCompare(String(b.model ?? "")));
}

export const totalOf = (lines: ReadonlyArray<{ cost_usd: number | null }>): number => lines.reduce((n, l) => n + (Number(l.cost_usd) || 0), 0);

/** Do the lines add up to the recorded total of the analysis (within a millionth of a dollar, which is how the ledger is rounded)? */
export const addsUp = (lines: ReadonlyArray<{ cost_usd: number | null }>, recorded: number | null | undefined): boolean =>
  recorded === null || recorded === undefined || Math.abs(totalOf(lines) - Number(recorded)) < 1e-6;
