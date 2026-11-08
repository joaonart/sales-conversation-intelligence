import type { CriterionInput, EvaluationTypeName, PolicyInput, RubricDraftInput } from "./types";

/** A criterion with a local key: its identity while it is edited (its id can be empty or change as the person types). */
export interface EditableCriterion {
  key: number;
  c: CriterionInput;
}

export interface RubricModel {
  name: string;
  description: string;
  summary_prompt: string;
  policy: PolicyInput;
  crits: EditableCriterion[];
}

let seq = 0;

export function fromDraft(d: RubricDraftInput): RubricModel {
  return {
    name: d.name,
    description: d.description,
    summary_prompt: d.summary_prompt || "",
    policy: { ...d.policy },
    crits: d.criteria.map((c) => ({
      key: ++seq,
      c: {
        ...c,
        score_mapping: { ...c.score_mapping },
        level_descriptions: { ...(c.level_descriptions ?? {}) },
        applicability_rule: c.applicability_rule?.conditions?.length ? { conditions: c.applicability_rule.conditions.map((x) => ({ criterion_id: x.criterion_id, equals: [...x.equals] })) } : null,
      },
    })),
  };
}

export function toDraft(m: RubricModel): RubricDraftInput {
  return { name: m.name, description: m.description, summary_prompt: m.summary_prompt, policy: m.policy, criteria: m.crits.map((x) => x.c) };
}

export function blankCriterion(n: number): EditableCriterion {
  return {
    key: ++seq,
    c: {
      criterion_id: "", criterion_name: "", evaluation_instructions: "", evaluation_type: "PREDICATE", weight: 10, required: false, enabled: true,
      score_mapping: { true: 100, false: 0 }, level_descriptions: {}, applicability_rule: null, display_order: n,
    },
  };
}

/** A yes/no criterion has its two fixed answers; any other type starts from two editable levels. */
export function withType(c: CriterionInput, type: EvaluationTypeName): CriterionInput {
  if (type === "PREDICATE") return { ...c, evaluation_type: type, score_mapping: { true: 100, false: 0 }, level_descriptions: {} };
  const keep = Object.keys(c.score_mapping).length >= 2 && c.score_mapping.true === undefined;
  return keep ? { ...c, evaluation_type: type } : { ...c, evaluation_type: type, score_mapping: { baixo: 0, alto: 100 }, level_descriptions: {} };
}

/** Renames an answer option keeping its position, its score and its description. Refuses an empty or duplicate name (returns null). */
export function renameOption(c: CriterionInput, from: string, to: string): CriterionInput | null {
  const next = to.trim();
  if (!next || next === from || c.score_mapping[next] !== undefined) return null;
  const mapping: Record<string, number> = {};
  for (const [k, v] of Object.entries(c.score_mapping)) mapping[k === from ? next : k] = v;
  const levels = { ...c.level_descriptions };
  if (levels[from] !== undefined) {
    levels[next] = levels[from] as string;
    delete levels[from];
  }
  return { ...c, score_mapping: mapping, level_descriptions: levels };
}

export function addOption(c: CriterionInput): CriterionInput {
  let n = 1;
  while (c.score_mapping[`opcao_${n}`] !== undefined) n++;
  return { ...c, score_mapping: { ...c.score_mapping, [`opcao_${n}`]: 0 } };
}

export function removeOption(c: CriterionInput, k: string): CriterionInput {
  const { [k]: _s, ...mapping } = c.score_mapping;
  const { [k]: _l, ...levels } = c.level_descriptions;
  return { ...c, score_mapping: mapping, level_descriptions: levels };
}

/** Gate candidates: other criteria that have an id and no rule themselves (a gate cannot be gated: one deterministic pass). */
export function gateCandidates(crits: EditableCriterion[], self: EditableCriterion): CriterionInput[] {
  return crits.filter((x) => x !== self && x.c.criterion_id && !x.c.applicability_rule).map((x) => x.c);
}

/** Sum of the weights of the enabled criteria (they are normalized in the grade). */
export function weightSum(crits: EditableCriterion[]): number {
  return crits.filter((x) => x.c.enabled).reduce((a, x) => a + Number(x.c.weight || 0), 0);
}
