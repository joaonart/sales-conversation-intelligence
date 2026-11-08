import { fmtNum } from "./format";
import { parseJson, scoreBreakdown, type Breakdown } from "./score";
import type { CriterionResult, SessionAnalysis, SessionDetail } from "./types";

/** The identity of a criterion within one analysis (a session may have several analyses, with the same criterion ids). */
export const critKey = (analysisId: string, criterionId: string): string => `${analysisId}\u0000${criterionId}`;

/** One criterion cited as evidence on a message: what the badge under the message shows. */
export interface Cited {
  key: string;
  id: string;
  name: string | null;
  weight: number | null;
  score: number | null;
  contrib: number | null;
  answer: { answer?: unknown } | null;
  status: string;
  rubric: string | null;
}

export const answerText = (c: Pick<Cited, "answer">): string | null => (c.answer && c.answer.answer !== undefined && c.answer.answer !== null ? String(c.answer.answer) : null);

/**
 * What a criterion badge under a message says, from the criterion's stored values: the answer (true/false, or the level) and what it contributed to the
 * final grade ("+26,67": its share of the sum of the weights that count), so the badges add up to the grade. A weightless criterion (an applicability gate)
 * has no share, so it only says its answer.
 */
export function badgeText(c: Cited): string | null {
  const ans = answerText(c);
  const gate = !Number(c.weight) && c.answer !== null && typeof c.answer.answer === "boolean";
  const share = !gate && c.contrib !== null && c.contrib !== undefined ? (Number(c.contrib) > 0 ? `+${fmtNum(c.contrib, 2)}` : "0") : null;
  const parts = [ans, share].filter((x): x is string => x !== null);
  return parts.length ? parts.join(" · ") : null;
}

/** The badges of a message, heaviest first, then by id. */
export const sortCited = (list: Cited[]): Cited[] => list.slice().sort((x, y) => (Number(y.weight) || 0) - (Number(x.weight) || 0) || x.id.localeCompare(y.id));

export interface Analysed {
  analysis: SessionAnalysis;
  crit: CriterionResult[];
  breakdown: Breakdown | null;
}

/** Each analysis with its criteria and (when it has a grade) the breakdown that explains it. */
export function analysedOf(d: SessionDetail): Analysed[] {
  return d.analyses.map((analysis) => {
    const crit = d.criteria.filter((c) => c.analysis_id === analysis.analysis_id);
    const breakdown = crit.length && analysis.overall_score !== null && analysis.overall_score !== undefined ? scoreBreakdown(crit, analysis) : null;
    return { analysis, crit, breakdown };
  });
}

/** message id -> the criteria that cite it as evidence, across every analysis of the session. */
export function highlightOf(d: SessionDetail, analysed: Analysed[] = analysedOf(d)): Record<string, Cited[]> {
  const out: Record<string, Cited[]> = {};
  for (const { analysis: a, crit, breakdown: bd } of analysed) {
    for (const c of crit) {
      for (const m of c.evidence_message_ids ?? []) {
        (out[m] ??= []).push({
          key: critKey(c.analysis_id, c.criterion_id),
          id: c.criterion_id,
          name: c.criterion_name || null,
          weight: c.criterion_weight,
          score: c.normalized_score,
          contrib: bd && bd.parts[c.criterion_id] !== undefined ? bd.parts[c.criterion_id] ?? null : null,
          answer: parseJson(c.evaluation_result) as Cited["answer"],
          status: c.applicability_status,
          rubric: d.analyses.length > 1 ? `${a.rubric_id} v${a.rubric_version}` : null,
        });
      }
    }
  }
  return out;
}

/**
 * Why nothing is highlighted: the step that cites the messages is optional (a second AI call), and an analysis says whether it ran
 * (its prompt version carries `;evidence=`). Null when there is something highlighted or nothing was scored.
 */
export function noEvidenceNote(d: SessionDetail, evidenceCount: number): string | null {
  const scored = d.analyses.filter((a) => d.criteria.some((c) => c.analysis_id === a.analysis_id));
  if (evidenceCount || !scored.length) return null;
  return scored.every((a) => !String(a.prompt_version ?? "").includes(";evidence="))
    ? "Esta análise não coletou evidências: a etapa que cita as mensagens de cada resposta é opcional (uma segunda chamada de IA) e não estava ligada. Por isso nenhuma mensagem aparece destacada."
    : "A etapa de evidências rodou, mas não apontou mensagens para nenhum critério.";
}

/** The analyses still in review, or that already have a decision: one review card each. */
export function reviewable(d: SessionDetail): Array<{ analysis: SessionAnalysis; decision: NonNullable<SessionDetail["decisions"]>[number] | undefined }> {
  const decided = new Map<string, NonNullable<SessionDetail["decisions"]>[number]>();
  for (const x of d.decisions ?? []) if (!decided.has(x.analysis_id)) decided.set(x.analysis_id, x);
  return d.analyses.filter((a) => a.analysis_status === "NEEDS_REVIEW" || decided.has(a.analysis_id)).map((analysis) => ({ analysis, decision: decided.get(analysis.analysis_id) }));
}

/** Why an analysis came to review, in words (the criteria that lacked evidence, or that nothing was evaluated). */
export function reviewWhy(crit: CriterionResult[]): string[] {
  const ins = crit.filter((c) => c.applicability_status === "INSUFFICIENT_EVIDENCE");
  const why: string[] = [];
  if (!crit.length) why.push("Não houve avaliação por critério: a conversa tem menos mensagens do que a rubrica exige.");
  if (ins.length) why.push(`Sem evidência suficiente em ${ins.length} de ${crit.length} critérios: ${ins.map((c) => c.criterion_id).join(", ")}.`);
  if (!why.length) why.push("A decisão do modelo ficou incerta ou perto do limite, e o motor pediu confirmação humana.");
  return why;
}

export const DECISION_INFO: Record<string, [label: string, help: string]> = {
  CONFIRMED: ["Confirmar o resultado", "O resultado do motor está adequado. Não precisa de justificativa."],
  DISAGREED: ["Discordar do resultado", "O resultado está incorreto ou injusto. Explique o motivo."],
  REANALYSIS: ["Pedir nova análise", "Falta informação, a conversa ou a rubrica mudou. Explique o motivo."],
};
export const MAX_REVIEW_COMMENT = 1000;
/** A decision is ready to send: one is chosen, and anything but "confirm" says why (at least 3 characters). */
export const decisionValid = (sel: string | null, comment: string): boolean => Boolean(sel) && (sel === "CONFIRMED" || comment.trim().length >= 3);
