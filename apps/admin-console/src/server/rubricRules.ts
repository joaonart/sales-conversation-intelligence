import type { CriterionInput, PolicyInput } from "./types";

/**
 * Rubric validation. Rules marked [core] mirror sci_core.rubric (Python) and are covered by the shared
 * conformance fixtures; rules marked [console] are stricter on purpose (they protect the model contract).
 */
export interface Issue {
  path: string;
  message: string;
}

const CRITERION_ID = /^[a-z][a-z0-9_]{0,63}$/; // [console] becomes the question name sent to the provider
const MAX_LEVELS: Record<string, number> = { PREDICATE: 2, SCORE: 10, CHOICE: 255 };

export function validateCriterion(c: CriterionInput, index: number): Issue[] {
  const p = `criteria[${index}]`;
  const out: Issue[] = [];
  const add = (path: string, message: string): void => void out.push({ path: `${p}.${path}`, message });
  if (!CRITERION_ID.test(c.criterion_id)) add("criterion_id", "Use minúsculas, números e _; comece com letra (máx. 64).");
  if (!c.evaluation_instructions.trim()) add("evaluation_instructions", "Descreva a pergunta de avaliação."); // [core] min_length=1
  if (c.weight < 0) add("weight", "O peso não pode ser negativo."); // [core]
  if (c.enabled && c.required && c.weight === 0) add("weight", "Critério obrigatório não pode ter peso zero."); // [core]
  const keys = Object.keys(c.score_mapping);
  if (keys.length === 0) add("score_mapping", "Defina o mapeamento de respostas."); // [core]
  if (Object.values(c.score_mapping).some((v) => !(v >= 0 && v <= 100))) add("score_mapping", "Notas devem estar entre 0 e 100."); // [core]
  if (c.evaluation_type === "PREDICATE") {
    if (keys.length !== 2 || !keys.includes("true") || !keys.includes("false")) add("score_mapping", "PREDICATE deve ter exatamente 'true' e 'false'."); // [core]
  } else if (keys.length < 2 || keys.length > (MAX_LEVELS[c.evaluation_type] ?? 0)) {
    add("score_mapping", `${c.evaluation_type} aceita de 2 a ${MAX_LEVELS[c.evaluation_type]} opções.`); // [console] provider limits
  }
  if (c.evaluation_type === "SCORE" && new Set(Object.values(c.score_mapping)).size !== keys.length) {
    add("score_mapping", "Em SCORE, cada nível precisa de uma nota diferente (a ordem vem da nota)."); // [console]
  }
  for (const k of Object.keys(c.level_descriptions)) {
    if (!keys.includes(k)) add("level_descriptions", `Descrição para opção inexistente: ${k}.`); // [core] keys must match mapping
  }
  return out;
}

export function validateCriteria(criteria: readonly CriterionInput[]): Issue[] {
  const out = criteria.flatMap((c, i) => validateCriterion(c, i));
  const ids = criteria.map((c) => c.criterion_id);
  if (new Set(ids).size !== ids.length) out.push({ path: "criteria", message: "criterion_id duplicado." }); // [core]
  const active = criteria.filter((c) => c.enabled);
  if (active.length === 0) out.push({ path: "criteria", message: "A rubrica precisa de ao menos um critério habilitado." }); // [core]
  else if (active.reduce((s, c) => s + c.weight, 0) <= 0) out.push({ path: "criteria", message: "A soma dos pesos habilitados deve ser positiva." }); // [core]
  return out;
}

export function validatePolicy(p: PolicyInput): Issue[] {
  const out: Issue[] = [];
  const bad = (path: string, message: string): void => void out.push({ path: `policy.${path}`, message });
  if (!(p.minimum_approval_score >= 0 && p.minimum_approval_score <= 100)) bad("minimum_approval_score", "Entre 0 e 100.");
  for (const k of ["max_analyses_per_session", "max_input_tokens"] as const) {
    if (p[k] !== null && !(Number.isInteger(p[k]) && (p[k] as number) > 0)) bad(k, "Deve ser um inteiro positivo ou vazio.");
  }
  if (p.monthly_budget_usd !== null && !(p.monthly_budget_usd >= 0)) bad("monthly_budget_usd", "Deve ser zero ou positivo.");
  for (const k of ["min_messages", "min_customer_messages", "min_seller_messages"] as const) {
    if (!(Number.isInteger(p[k]) && p[k] >= 0)) bad(k, "Deve ser um inteiro maior ou igual a zero.");
  }
  return out;
}

/** Shape used by the shared conformance cases (criteria only, `core` rules). */
export function coreValid(criteria: readonly CriterionInput[]): boolean {
  return validateCriteria(criteria).length === 0;
}
