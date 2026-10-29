import { f, i, s, type Bq, type Params } from "../bq";
import { conflict, invalid, notFound } from "../errors";
import { validateCriteria, validatePolicy, type Issue } from "../rubricRules";
import { TENANT, type Tables } from "../sql";
import type { CriterionInput, EvaluationType, PolicyInput, Row, RubricDraftInput, Tenant } from "../types";
import * as v from "../validate";

const TYPES = ["PREDICATE", "CHOICE", "SCORE"] as const;
const POLICY_DEFAULTS: PolicyInput = {
  minimum_approval_score: 80,
  missing_evidence_policy: "NEEDS_REVIEW",
  max_analyses_per_session: null,
  max_input_tokens: null,
  monthly_budget_usd: null,
  min_messages: 3,
  min_customer_messages: 0,
  min_seller_messages: 0,
};
const CRIT_COLS =
  "organization_id, workspace_id, rubric_id, rubric_version, criterion_id, criterion_name, evaluation_instructions, evaluation_type, " +
  "weight, required, enabled, score_mapping, score_levels, display_order";
const POLICY_COLS =
  "organization_id, workspace_id, rubric_id, rubric_version, minimum_approval_score, missing_evidence_policy, max_analyses_per_session, " +
  "max_input_tokens, monthly_budget_usd, min_messages, min_customer_messages, min_seller_messages";

export interface RubricView {
  header: Row;
  draft: RubricDraftInput;
  etag: string;
  issues: Issue[];
}

const nullableInt = (x: unknown, field: string, min: number, max: number): number | null =>
  x === null || x === undefined || x === "" ? null : v.int(x, field, min, max);

export function parsePolicy(raw: unknown): PolicyInput {
  const o = v.asObject(raw, "policy");
  return {
    minimum_approval_score: v.num(o.minimum_approval_score, "minimum_approval_score", 0, 100),
    missing_evidence_policy: v.oneOf(o.missing_evidence_policy, ["NEEDS_REVIEW", "EXCLUDE_OPTIONAL"] as const, "missing_evidence_policy"),
    max_analyses_per_session: nullableInt(o.max_analyses_per_session, "max_analyses_per_session", 1, 1_000_000),
    max_input_tokens: nullableInt(o.max_input_tokens, "max_input_tokens", 1, 272_000),
    monthly_budget_usd: o.monthly_budget_usd === null || o.monthly_budget_usd === undefined || o.monthly_budget_usd === "" ? null : v.num(o.monthly_budget_usd, "monthly_budget_usd", 0, 1_000_000),
    min_messages: v.int(o.min_messages, "min_messages", 0, 1000),
    min_customer_messages: v.int(o.min_customer_messages, "min_customer_messages", 0, 1000),
    min_seller_messages: v.int(o.min_seller_messages, "min_seller_messages", 0, 1000),
  };
}

export function parseCriterion(raw: unknown, index: number): CriterionInput {
  const o = v.asObject(raw, `criteria[${index}]`);
  const mapping = v.asObject(o.score_mapping, "score_mapping");
  const desc = v.asObject(o.level_descriptions ?? {}, "level_descriptions");
  const keys = Object.keys(mapping);
  if (keys.length > 255) throw invalid("Opções demais em um critério.");
  const score_mapping: Record<string, number> = {};
  for (const k of keys) {
    if (!k || k.length > 64) throw invalid("Opção de resposta inválida.");
    score_mapping[k] = v.num(mapping[k], "nota da opção", 0, 100);
  }
  const level_descriptions: Record<string, string> = {};
  for (const [k, val] of Object.entries(desc)) {
    const text = v.text(val, "descrição do nível", 500);
    if (text) level_descriptions[k] = text;
  }
  return {
    criterion_id: v.text(o.criterion_id, "criterion_id", 64, { min: 1 }),
    criterion_name: v.text(o.criterion_name, "nome do critério", 120, { min: 1 }),
    evaluation_instructions: v.text(o.evaluation_instructions, "instruções", 4000),
    evaluation_type: v.oneOf(o.evaluation_type, TYPES, "tipo") as EvaluationType,
    weight: v.num(o.weight, "peso", 0, 1000),
    required: v.bool(o.required, "obrigatório"),
    enabled: v.bool(o.enabled, "habilitado"),
    score_mapping,
    level_descriptions,
    display_order: v.int(o.display_order, "ordem", 0, 10_000),
  };
}

export function parseDraft(raw: unknown): RubricDraftInput {
  const o = v.asObject(raw, "rascunho");
  if (!Array.isArray(o.criteria) || o.criteria.length > 100) throw invalid("Informe até 100 critérios.");
  return {
    name: v.text(o.name, "nome", 120, { min: 1 }),
    description: v.text(o.description ?? "", "descrição", 1000),
    criteria: o.criteria.map((c, idx) => parseCriterion(c, idx)),
    policy: parsePolicy(o.policy),
  };
}

function canonical(draft: RubricDraftInput): string {
  const criteria = [...draft.criteria]
    .sort((a, c) => a.criterion_id.localeCompare(c.criterion_id))
    .map((c) => ({ ...c, score_mapping: sortKeys(c.score_mapping), level_descriptions: sortKeys(c.level_descriptions) }));
  return JSON.stringify({ name: draft.name, description: draft.description, criteria, policy: draft.policy });
}

const sortKeys = <T,>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).sort(([a], [c]) => a.localeCompare(c)));

const parseJson = (x: unknown): Record<string, unknown> => {
  if (typeof x !== "string" || !x) return {};
  try {
    const p: unknown = JSON.parse(x);
    return typeof p === "object" && p !== null && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export class RubricsService {
  constructor(
    private readonly bq: Bq,
    private readonly t: Tables,
    private readonly sha256: (text: string) => string,
  ) {}

  private p(t: Tenant, rubricId: string, version?: number): Params {
    return { org: s(t.organization_id), ws: s(t.workspace_id), rid: s(rubricId), ...(version === undefined ? {} : { ver: i(version) }) };
  }

  list(tenant: Tenant): Row[] {
    return this.bq.run(
      `SELECT rubric_id, version, name, status, published_at, created_at, description FROM ${this.t.rubrics} WHERE ${TENANT} ` +
        "ORDER BY rubric_id, version DESC LIMIT 500",
      { org: s(tenant.organization_id), ws: s(tenant.workspace_id) },
      { maxRows: 500 },
    );
  }

  get(tenant: Tenant, rubricIdRaw: unknown, versionRaw: unknown): RubricView {
    const rubricId = v.id(rubricIdRaw, "rubric_id");
    const version = v.int(versionRaw, "version", 1, 100_000);
    const base = this.p(tenant, rubricId, version);
    const header = this.bq.run(
      `SELECT rubric_id, version, name, status, published_at, created_at, description FROM ${this.t.rubrics} ` +
        `WHERE ${TENANT} AND rubric_id = @rid AND version = @ver LIMIT 1`,
      base,
      { maxRows: 1 },
    )[0];
    if (!header) throw notFound("Rubrica não encontrada.");
    const criteria = this.bq
      .run(
        `SELECT criterion_id, criterion_name, evaluation_instructions, evaluation_type, weight, required, enabled, score_mapping, score_levels, display_order ` +
          `FROM ${this.t.criteria} WHERE ${TENANT} AND rubric_id = @rid AND rubric_version = @ver ORDER BY display_order, criterion_id`,
        base,
        { maxRows: 500 },
      )
      .map((r): CriterionInput => ({
        criterion_id: String(r.criterion_id),
        criterion_name: String(r.criterion_name ?? r.criterion_id),
        evaluation_instructions: String(r.evaluation_instructions ?? ""),
        evaluation_type: r.evaluation_type as EvaluationType,
        weight: Number(r.weight),
        required: r.required === true,
        enabled: r.enabled === true,
        score_mapping: Object.fromEntries(Object.entries(parseJson(r.score_mapping)).map(([k, x]) => [k, Number(x)])),
        level_descriptions: Object.fromEntries(Object.entries(parseJson(r.score_levels)).filter(([, x]) => typeof x === "string")) as Record<string, string>,
        display_order: Number(r.display_order ?? 0),
      }));
    const pr = this.bq.run(
      `SELECT minimum_approval_score, missing_evidence_policy, max_analyses_per_session, max_input_tokens, monthly_budget_usd, ` +
        `min_messages, min_customer_messages, min_seller_messages FROM ${this.t.policies} WHERE ${TENANT} AND rubric_id = @rid AND rubric_version = @ver LIMIT 1`,
      base,
      { maxRows: 1 },
    )[0];
    const policy: PolicyInput = pr
      ? {
          minimum_approval_score: Number(pr.minimum_approval_score ?? POLICY_DEFAULTS.minimum_approval_score),
          missing_evidence_policy: pr.missing_evidence_policy === "EXCLUDE_OPTIONAL" ? "EXCLUDE_OPTIONAL" : "NEEDS_REVIEW",
          max_analyses_per_session: pr.max_analyses_per_session === null ? null : Number(pr.max_analyses_per_session),
          max_input_tokens: pr.max_input_tokens === null ? null : Number(pr.max_input_tokens),
          monthly_budget_usd: pr.monthly_budget_usd === null ? null : Number(pr.monthly_budget_usd),
          min_messages: Number(pr.min_messages ?? POLICY_DEFAULTS.min_messages),
          min_customer_messages: Number(pr.min_customer_messages ?? 0),
          min_seller_messages: Number(pr.min_seller_messages ?? 0),
        }
      : { ...POLICY_DEFAULTS };
    const draft: RubricDraftInput = { name: String(header.name ?? ""), description: String(header.description ?? ""), criteria, policy };
    return { header, draft, etag: this.sha256(canonical(draft)), issues: this.issues(draft) };
  }

  private issues(draft: RubricDraftInput): Issue[] {
    return [...validateCriteria(draft.criteria), ...validatePolicy(draft.policy)];
  }

  createDraft(tenant: Tenant, payload: Record<string, unknown>): { version: number } {
    const rubricId = v.id(payload.rubric_id, "rubric_id");
    const name = v.text(payload.name, "nome", 120, { min: 1 });
    const description = v.text(payload.description ?? "", "descrição", 1000);
    const cloneFrom = payload.cloneFromVersion === undefined || payload.cloneFromVersion === null ? null : v.int(payload.cloneFromVersion, "cloneFromVersion", 1, 100_000);
    if (cloneFrom !== null) this.get(tenant, rubricId, cloneFrom); // must exist in this tenant
    const clone = cloneFrom !== null;
    const sql =
      "DECLARE next_ver INT64 DEFAULT 0;\n" +
      "BEGIN TRANSACTION;\n" +
      `SET next_ver = (SELECT IFNULL(MAX(version), 0) + 1 FROM ${this.t.rubrics} WHERE ${TENANT} AND rubric_id = @rid);\n` +
      `IF EXISTS (SELECT 1 FROM ${this.t.rubrics} WHERE ${TENANT} AND rubric_id = @rid AND status = 'DRAFT') THEN RAISE USING MESSAGE = 'SCI_CONFLICT'; END IF;\n` +
      `INSERT INTO ${this.t.rubrics} (organization_id, workspace_id, rubric_id, version, name, status, published_at, created_at, description) ` +
      "VALUES (@org, @ws, @rid, next_ver, @name, 'DRAFT', NULL, CURRENT_TIMESTAMP(), @desc);\n" +
      (clone
        ? `INSERT INTO ${this.t.criteria} (${CRIT_COLS}) SELECT organization_id, workspace_id, rubric_id, next_ver, criterion_id, criterion_name, evaluation_instructions, ` +
          "evaluation_type, weight, required, enabled, score_mapping, score_levels, display_order " +
          `FROM ${this.t.criteria} WHERE ${TENANT} AND rubric_id = @rid AND rubric_version = @clone;\n` +
          `INSERT INTO ${this.t.policies} (${POLICY_COLS}) SELECT organization_id, workspace_id, rubric_id, next_ver, minimum_approval_score, missing_evidence_policy, ` +
          "max_analyses_per_session, max_input_tokens, monthly_budget_usd, min_messages, min_customer_messages, min_seller_messages " +
          `FROM ${this.t.policies} WHERE ${TENANT} AND rubric_id = @rid AND rubric_version = @clone;\n`
        : `INSERT INTO ${this.t.policies} (${POLICY_COLS}) VALUES (@org, @ws, @rid, next_ver, 80, 'NEEDS_REVIEW', NULL, NULL, NULL, 3, 0, 0);\n`) +
      "COMMIT TRANSACTION;";
    const params: Record<string, ReturnType<typeof s> | ReturnType<typeof i>> = { ...this.p(tenant, rubricId), name: s(name), desc: s(description) };
    if (clone) params.clone = i(cloneFrom);
    this.bq.run(sql, params);
    const created = this.bq.run(
      `SELECT MAX(version) AS version FROM ${this.t.rubrics} WHERE ${TENANT} AND rubric_id = @rid AND status = 'DRAFT'`,
      this.p(tenant, rubricId),
      { maxRows: 1 },
    )[0];
    return { version: Number(created?.version ?? 0) };
  }

  /** Drafts may be saved incomplete; the semantic issues are returned. Publishing requires none. */
  saveDraft(tenant: Tenant, payload: Record<string, unknown>): { etag: string; issues: Issue[] } {
    const rubricId = v.id(payload.rubric_id, "rubric_id");
    const version = v.int(payload.version, "version", 1, 100_000);
    const expectedEtag = v.text(payload.etag, "etag", 128, { min: 1 });
    const draft = parseDraft(payload.draft);
    const current = this.get(tenant, rubricId, version);
    if (current.header.status !== "DRAFT") throw conflict("Rubricas publicadas são imutáveis. Crie uma nova revisão.");
    if (current.etag !== expectedEtag) throw conflict("O rascunho foi alterado por outra pessoa. Recarregue antes de salvar.");
    const rows = draft.criteria.map((c) => ({
      criterion_id: c.criterion_id,
      criterion_name: c.criterion_name,
      instructions: c.evaluation_instructions,
      evaluation_type: c.evaluation_type,
      weight: c.weight,
      required: c.required,
      enabled: c.enabled,
      score_mapping: JSON.stringify(c.score_mapping),
      levels: Object.keys(c.level_descriptions).length ? JSON.stringify(c.level_descriptions) : null,
      display_order: c.display_order,
    }));
    const pol = draft.policy;
    const sql =
      "BEGIN TRANSACTION;\n" +
      `UPDATE ${this.t.rubrics} SET name = @name, description = @desc WHERE ${TENANT} AND rubric_id = @rid AND version = @ver AND status = 'DRAFT';\n` +
      "IF @@row_count = 0 THEN RAISE USING MESSAGE = 'SCI_CONFLICT'; END IF;\n" +
      `DELETE FROM ${this.t.criteria} WHERE ${TENANT} AND rubric_id = @rid AND rubric_version = @ver;\n` +
      `DELETE FROM ${this.t.policies} WHERE ${TENANT} AND rubric_id = @rid AND rubric_version = @ver;\n` +
      `INSERT INTO ${this.t.criteria} (${CRIT_COLS}) SELECT @org, @ws, @rid, @ver, c.criterion_id, c.criterion_name, c.instructions, c.evaluation_type, ` +
      "CAST(c.weight AS NUMERIC), c.required, c.enabled, PARSE_JSON(c.score_mapping), IF(c.levels IS NULL, NULL, PARSE_JSON(c.levels)), c.display_order " +
      "FROM UNNEST(@criteria) AS c;\n" +
      `INSERT INTO ${this.t.policies} (${POLICY_COLS}) VALUES (@org, @ws, @rid, @ver, CAST(@min_score AS NUMERIC), @mep, @max_an, @max_tok, CAST(@budget AS NUMERIC), @min_m, @min_c, @min_s);\n` +
      "COMMIT TRANSACTION;";
    this.bq.run(sql, {
      ...this.p(tenant, rubricId, version),
      name: s(draft.name),
      desc: s(draft.description),
      criteria: {
        t: "STRUCTS",
        fields: {
          criterion_id: "STRING", criterion_name: "STRING", instructions: "STRING", evaluation_type: "STRING", weight: "FLOAT64",
          required: "BOOL", enabled: "BOOL", score_mapping: "STRING", levels: "STRING", display_order: "INT64",
        },
        v: rows,
      },
      min_score: f(pol.minimum_approval_score),
      mep: s(pol.missing_evidence_policy),
      max_an: i(pol.max_analyses_per_session),
      max_tok: i(pol.max_input_tokens),
      budget: f(pol.monthly_budget_usd),
      min_m: i(pol.min_messages),
      min_c: i(pol.min_customer_messages),
      min_s: i(pol.min_seller_messages),
    });
    return { etag: this.sha256(canonical(draft)), issues: this.issues(draft) };
  }

  deleteDraft(tenant: Tenant, payload: Record<string, unknown>): void {
    const rubricId = v.id(payload.rubric_id, "rubric_id");
    const version = v.int(payload.version, "version", 1, 100_000);
    this.bq.run(
      "BEGIN TRANSACTION;\n" +
        `DELETE FROM ${this.t.rubrics} WHERE ${TENANT} AND rubric_id = @rid AND version = @ver AND status = 'DRAFT';\n` +
        "IF @@row_count = 0 THEN RAISE USING MESSAGE = 'SCI_CONFLICT'; END IF;\n" +
        `DELETE FROM ${this.t.criteria} WHERE ${TENANT} AND rubric_id = @rid AND rubric_version = @ver;\n` +
        `DELETE FROM ${this.t.policies} WHERE ${TENANT} AND rubric_id = @rid AND rubric_version = @ver;\n` +
        "COMMIT TRANSACTION;",
      this.p(tenant, rubricId, version),
    );
  }

  /** Immutable from here on. Only a draft whose content hash matches what the reviewer saw can be published. */
  publish(tenant: Tenant, payload: Record<string, unknown>): { version: number; criteria: number } {
    const rubricId = v.id(payload.rubric_id, "rubric_id");
    const version = v.int(payload.version, "version", 1, 100_000);
    const expectedEtag = v.text(payload.etag, "etag", 128, { min: 1 });
    const current = this.get(tenant, rubricId, version);
    if (current.header.status !== "DRAFT") throw conflict("Somente rascunhos podem ser publicados.");
    if (current.etag !== expectedEtag) throw conflict("O rascunho mudou depois da sua revisão. Recarregue e revise de novo.");
    if (current.issues.length) throw invalid("A rubrica tem pendências e não pode ser publicada.", current.issues.map((x) => `${x.path}: ${x.message}`));
    this.bq.run(
      `UPDATE ${this.t.rubrics} SET status = 'PUBLISHED', published_at = CURRENT_TIMESTAMP() WHERE ${TENANT} AND rubric_id = @rid AND version = @ver AND status = 'DRAFT';\n` +
        "IF @@row_count = 0 THEN RAISE USING MESSAGE = 'SCI_CONFLICT'; END IF;",
      this.p(tenant, rubricId, version),
    );
    return { version, criteria: current.draft.criteria.length };
  }
}

