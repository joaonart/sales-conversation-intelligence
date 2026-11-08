import { useEffect, useState } from "preact/hooks";
import { go } from "../app/router";
import { Alert } from "../components/Alert";
import { Badge } from "../components/Badge";
import { ErrorAlert, Loading } from "../components/Bits";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Field, Input, Select } from "../components/Field";
import { Icon } from "../components/Icon";
import { useConfirm } from "../components/Modal";
import { PageHead } from "../components/PageHead";
import { Switch } from "../components/Switch";
import { TabPanel, Tabs } from "../components/Tabs";
import { useToast } from "../components/Toasts";
import { ApiError } from "../lib/api";
import { cx } from "../lib/cx";
import { fmtInt, fmtNum } from "../lib/format";
import { addOption, blankCriterion, fromDraft, gateCandidates, removeOption, renameOption, toDraft, weightSum, withType, type EditableCriterion, type RubricModel } from "../lib/rubricModel";
import { DEFAULT_SUMMARY_PROMPT } from "../lib/summaryPrompt";
import { MAX_SUMMARY_PROMPT } from "../../server/types";
import type { CriterionInput, EvaluationTypeName, Issue, PolicyInput } from "../lib/types";
import { useAsync } from "../lib/useAsync";
import { useSession } from "../state/session";

const TYPE_LABEL: Record<EvaluationTypeName, string> = { PREDICATE: "Sim/Não", SCORE: "Escala", CHOICE: "Escolha" };
const TEXTAREA = "w-full rounded-control border border-line bg-surface p-3 text-sm placeholder:text-faint disabled:opacity-60";
const IconX = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button type="button" aria-label={label} title={label} onClick={onClick} class="inline-flex size-9 items-center justify-center rounded-control border border-line text-bad hover:bg-bad-soft">
    <Icon name="close" size="sm" />
  </button>
);

interface RuleProps {
  model: RubricModel;
  item: EditableCriterion;
  ro: boolean;
  onChange: (c: CriterionInput) => void;
}

/** The criterion's applicability rule: ALL the conditions must hold, each on an answer of another (gate) criterion. */
function RuleEditor({ model, item, ro, onChange }: RuleProps) {
  const c = item.c;
  const conds = c.applicability_rule?.conditions ?? [];
  const candidates = gateCandidates(model.crits, item);
  const sync = (next: typeof conds) => onChange({ ...c, applicability_rule: next.length ? { conditions: next } : null });
  const free = candidates.filter((x) => conds.every((cc) => cc.criterion_id !== x.criterion_id));
  return (
    <div class="mt-4 flex flex-col gap-2 rounded-control bg-surface-2 p-3">
      <div class="text-muted">{conds.length ? "Aplicabilidade: só se TODAS as condições abaixo forem verdadeiras" : "Aplicabilidade: sempre se aplica"}</div>
      {conds.map((cond, idx) => {
        const gate = model.crits.find((x) => x.c.criterion_id === cond.criterion_id)?.c;
        const keys = gate ? Object.keys(gate.score_mapping) : [];
        const used = conds.map((x) => x.criterion_id);
        const options = candidates.filter((x) => x.criterion_id === cond.criterion_id || !used.includes(x.criterion_id));
        return (
          <div key={cond.criterion_id} class="flex flex-wrap items-center gap-3">
            <span class="w-24 whitespace-nowrap text-muted">{idx === 0 ? "Somente se" : "E"}</span>
            <Select
              class="!w-56"
              disabled={ro}
              aria-label="Critério de controle"
              value={cond.criterion_id}
              onChange={(e) => sync(conds.map((x, i) => (i === idx ? { criterion_id: e.currentTarget.value, equals: [] } : x)))}
            >
              {options.map((x) => (
                <option key={x.criterion_id} value={x.criterion_id} selected={x.criterion_id === cond.criterion_id}>
                  “{x.criterion_id}” for…
                </option>
              ))}
              {gate ? null : <option value={cond.criterion_id} selected>“{cond.criterion_id}” (não existe mais)</option>}
            </Select>
            <div class="flex flex-1 flex-wrap gap-x-5 gap-y-1">
              {keys.map((k) => (
                <Switch
                  key={k}
                  label={k}
                  disabled={ro}
                  checked={cond.equals.includes(k)}
                  onChange={(on) => sync(conds.map((x, i) => (i === idx ? { ...x, equals: on ? [...x.equals.filter((v) => v !== k), k] : x.equals.filter((v) => v !== k) } : x)))}
                />
              ))}
            </div>
            {ro ? null : <IconX label="Remover condição" onClick={() => sync(conds.filter((_, i) => i !== idx))} />}
          </div>
        );
      })}
      {!ro && free.length && conds.length < 5 && free[0] ? (
        <div>
          <Button small onClick={() => sync([...conds, { criterion_id: free[0]?.criterion_id ?? "", equals: [] }])}>
            {conds.length ? "Adicionar condição (E)" : "Aplicar somente se…"}
          </Button>
        </div>
      ) : null}
      {conds.length ? (
        <div class="text-muted">
          Fora disso o critério fica “não aplicável” (não entra na nota, nem como zero). Sem resposta de um critério de controle, vai para revisão, a menos que outra condição já exclua. Se todos os critérios ficarem não aplicáveis, a sessão é “não avaliável”. O critério de controle costuma ter peso 0.
        </div>
      ) : null}
    </div>
  );
}

function Options({ c, ro, onChange }: { c: CriterionInput; ro: boolean; onChange: (c: CriterionInput) => void }) {
  const fixed = c.evaluation_type === "PREDICATE";
  return (
    <div class="mt-3 flex flex-col gap-2">
      {fixed ? null : <div class="text-muted">Opções e notas (0–100). Descreva cada nível: sem definição, o modelo tende a escolher o meio.</div>}
      {Object.keys(c.score_mapping).map((k) => (
        <div key={k} class="flex flex-wrap items-center gap-2">
          <Input
            class="!w-40"
            defaultValue={k}
            disabled={ro || fixed}
            aria-label="Opção de resposta"
            maxLength={64}
            onChange={(e) => {
              const next = renameOption(c, k, e.currentTarget.value);
              if (next) onChange(next);
              else e.currentTarget.value = k;
            }}
          />
          <Input
            type="number"
            class="!w-24"
            min={0}
            max={100}
            step={1}
            value={c.score_mapping[k]}
            disabled={ro}
            aria-label="Nota 0 a 100"
            onChange={(e) => onChange({ ...c, score_mapping: { ...c.score_mapping, [k]: Number(e.currentTarget.value) } })}
          />
          <Input
            class="min-w-48 flex-1"
            value={c.level_descriptions[k] ?? ""}
            disabled={ro}
            placeholder="O que significa esta opção (enviado ao modelo)"
            maxLength={500}
            aria-label="Descrição da opção"
            onInput={(e) => {
              const v = e.currentTarget.value;
              const levels = { ...c.level_descriptions };
              if (v.trim()) levels[k] = v;
              else delete levels[k];
              onChange({ ...c, level_descriptions: levels });
            }}
          />
          {ro || fixed ? null : <IconX label="Remover opção" onClick={() => onChange(removeOption(c, k))} />}
        </div>
      ))}
      {!ro && !fixed ? (
        <div>
          <Button small onClick={() => onChange(addOption(c))}>Adicionar opção</Button>
        </div>
      ) : null}
    </div>
  );
}

interface CriterionCardProps {
  model: RubricModel;
  item: EditableCriterion;
  open: boolean;
  ro: boolean;
  onToggle: () => void;
  onChange: (c: CriterionInput) => void;
  onRemove: () => void;
}

function CriterionCard({ model, item, open, ro, onToggle, onChange, onRemove }: CriterionCardProps) {
  const { c } = item;
  const set = <K extends keyof CriterionInput>(k: K, v: CriterionInput[K]) => onChange({ ...c, [k]: v });
  const bodyId = `crit-body-${item.key}`;
  return (
    <div class={cx("mb-3 overflow-hidden rounded-card border bg-surface shadow-card", open ? "border-primary/40" : "border-line")}>
      <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={onToggle} class="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-surface-2">
        <Icon name="chevron" size="sm" class={cx("text-muted transition-transform", open && "rotate-90")} />
        <span class="min-w-40 font-medium">{c.criterion_name || c.criterion_id || "Novo critério"}</span>
        <span class="min-w-24 font-mono text-xs text-muted">{c.criterion_name && c.criterion_id ? c.criterion_id : ""}</span>
        <Badge>{TYPE_LABEL[c.evaluation_type]}</Badge>
        <Badge>peso {fmtNum(Number(c.weight) || 0)}</Badge>
        <span class="ml-auto flex gap-2">
          {c.required ? <Badge tone="warn">Obrigatório</Badge> : null}
          {c.enabled === false ? <Badge>Desabilitado</Badge> : null}
          {c.applicability_rule ? <Badge tone="info">Condicional</Badge> : null}
        </span>
      </button>
      <div id={bodyId} hidden={!open} class="border-t border-divider p-4">
        <div class="flex flex-wrap items-end gap-3">
          <Field label="Identificador" class="min-w-40 flex-1">
            <Input value={c.criterion_id} disabled={ro} maxLength={64} placeholder="ex.: saudacao" onInput={(e) => set("criterion_id", e.currentTarget.value.trim())} />
          </Field>
          <Field label="Nome" class="min-w-40 flex-1">
            <Input value={c.criterion_name} disabled={ro} maxLength={120} onInput={(e) => set("criterion_name", e.currentTarget.value)} />
          </Field>
          <Field label="Tipo" class="w-36">
            <Select disabled={ro} value={c.evaluation_type} onChange={(e) => onChange(withType(c, e.currentTarget.value as EvaluationTypeName))}>
              {(Object.keys(TYPE_LABEL) as EvaluationTypeName[]).map((t) => (
                <option key={t} value={t} selected={t === c.evaluation_type}>{TYPE_LABEL[t]}</option>
              ))}
            </Select>
          </Field>
          <Field label="Peso" class="w-24">
            <Input type="number" min={0} step="any" value={c.weight} disabled={ro} onInput={(e) => set("weight", Number(e.currentTarget.value))} />
          </Field>
          <div class="flex h-9 items-center gap-5">
            <Switch label="Obrigatório" checked={c.required} disabled={ro} onChange={(v) => set("required", v)} />
            <Switch label="Habilitado" checked={c.enabled} disabled={ro} onChange={(v) => set("enabled", v)} />
          </div>
          {ro ? null : <Button small variant="danger" onClick={onRemove}>Remover</Button>}
        </div>
        <Field label="Pergunta de avaliação (enviada ao modelo)" class="mt-3">
          <textarea class={TEXTAREA} rows={3} disabled={ro} maxLength={4000} value={c.evaluation_instructions} onInput={(e) => set("evaluation_instructions", e.currentTarget.value)} />
        </Field>
        <RuleEditor model={model} item={item} ro={ro} onChange={onChange} />
        <Options c={c} ro={ro} onChange={onChange} />
      </div>
    </div>
  );
}

function PolicyPanel({ policy, ro, onChange }: { policy: PolicyInput; ro: boolean; onChange: (p: PolicyInput) => void }) {
  type NumKey = "minimum_approval_score" | "min_messages" | "min_customer_messages" | "min_seller_messages" | "max_analyses_per_session" | "max_input_tokens" | "monthly_budget_usd";
  const num = (label: string, key: NumKey, hint?: string, nullable?: boolean) => (
    <Field label={label}>
      <Input
        type="number"
        min={0}
        step="any"
        title={hint ?? ""}
        disabled={ro}
        value={policy[key] ?? ""}
        onChange={(e) => {
          const v = e.currentTarget.value;
          onChange({ ...policy, [key]: v === "" ? (nullable ? null : 0) : Number(v) });
        }}
      />
    </Field>
  );
  const grid = "grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4";
  return (
    <Card>
      <div class={grid}>
        {num("Nota mínima de aprovação (0–100)", "minimum_approval_score")}
        <Field label="Evidência ausente">
          <Select disabled={ro} value={policy.missing_evidence_policy} onChange={(e) => onChange({ ...policy, missing_evidence_policy: e.currentTarget.value as PolicyInput["missing_evidence_policy"] })}>
            <option value="NEEDS_REVIEW" selected={policy.missing_evidence_policy === "NEEDS_REVIEW"}>Enviar para revisão</option>
            <option value="EXCLUDE_OPTIONAL" selected={policy.missing_evidence_policy === "EXCLUDE_OPTIONAL"}>Excluir critérios opcionais</option>
          </Select>
        </Field>
      </div>
      <h3 class="mt-5 mb-2 font-semibold">Evidência mínima (antes de chamar o modelo)</h3>
      <div class={grid}>
        {num("Mensagens mínimas", "min_messages", "0 desliga a regra")}
        {num("Mensagens mínimas do cliente", "min_customer_messages", "0 = desligado")}
        {num("Mensagens mínimas do vendedor", "min_seller_messages", "0 = desligado")}
      </div>
      <h3 class="mt-5 mb-2 font-semibold">Limites</h3>
      <div class={grid}>
        {num("Máx. análises por sessão", "max_analyses_per_session", "vazio = sem limite", true)}
        {num("Máx. tokens de entrada", "max_input_tokens", "vazio = sem limite; máx. 272000", true)}
        {num("Orçamento mensal (US$)", "monthly_budget_usd", "vazio = sem limite", true)}
      </div>
    </Card>
  );
}

/** The prompt of the general evaluation: a field of THIS version of the rubric (immutable once published, so changing it is a new revision). */
function GeneralPanel({ value, ro, onChange }: { value: string; ro: boolean; onChange: (v: string) => void }) {
  const confirm = useConfirm();
  const fill = () => onChange(DEFAULT_SUMMARY_PROMPT);
  return (
    <Card title="Avaliação geral da conversa">
      <p class="mb-3 text-muted">
        Depois de calcular a nota, uma chamada de IA lê a conversa e o resultado de cada critério e escreve um resumo com pontos positivos, pontos negativos e oportunidades. Este é o texto que orienta essa avaliação.
      </p>
      <ul class="mb-4 list-disc space-y-1 pl-5">
        <li><strong>Não altera a nota.</strong> A nota, a aprovação e os critérios já estão fechados quando o texto é escrito.</li>
        <li><strong>Custa uma chamada de IA a mais por análise,</strong> e só roda onde a avaliação geral está ligada. Sem texto aqui, esta rubrica não gera avaliação geral.</li>
        <li><strong>O texto da conversa é tratado como dado, não como instrução.</strong> Regras fixas de segurança vêm antes do seu texto e ele não consegue desligá-las.</li>
        <li><strong>Faz parte da versão.</strong> Depois de publicada a rubrica não muda: para ajustar este texto, crie uma nova revisão.</li>
      </ul>
      <textarea class={TEXTAREA} rows={12} maxLength={MAX_SUMMARY_PROMPT} disabled={ro} aria-label="Prompt da avaliação geral" placeholder="Vazio: esta rubrica não gera avaliação geral." value={value} onInput={(e) => onChange(e.currentTarget.value)} />
      <div class="mt-2 flex items-center justify-between">
        <span aria-live="polite" class="text-xs text-muted">{fmtInt(value.length)} / {fmtInt(MAX_SUMMARY_PROMPT)} caracteres</span>
        {ro ? null : (
          <Button
            small
            onClick={async () => {
              if (value.trim() && value.trim() !== DEFAULT_SUMMARY_PROMPT) {
                if (await confirm({ title: "Substituir o texto atual?", okLabel: "Substituir", body: <p>O texto atual será trocado pelo texto sugerido.</p> })) fill();
              } else fill();
            }}
          >
            Usar o texto sugerido
          </Button>
        )}
      </div>
    </Card>
  );
}

const TABS = [
  { id: "criteria", label: "Critérios" },
  { id: "policy", label: "Política" },
  { id: "general", label: "Avaliação geral" },
];

export function RubricEditor({ rubricId, version }: { rubricId: string; version: number }) {
  const { api, can } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const [reloads, setReloads] = useState(0);
  const loaded = useAsync(() => api("rubrics.get", { rubric_id: rubricId, version }), [rubricId, version, reloads]);
  const [model, setModel] = useState<RubricModel | null>(null);
  const [etag, setEtag] = useState("");
  const [status, setStatus] = useState<string>("");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set()); // every card starts collapsed so the page stays short
  const [tab, setTab] = useState("criteria");

  useEffect(() => {
    if (loaded.status !== "ready") return;
    const m = fromDraft(loaded.data.draft);
    setModel(m);
    setEtag(loaded.data.etag);
    setStatus(loaded.data.header.status);
    setIssues(loaded.data.issues);
    setDirty(false);
    // Pending issues point at fields: show them all.
    setOpen(loaded.data.issues.length ? new Set(m.crits.map((x) => x.key)) : new Set());
  }, [loaded]);

  useEffect(() => {
    window.__sciDirty = () => dirty;
    return () => {
      window.__sciDirty = null;
    };
  }, [dirty]);

  const title = `Rubrica ${rubricId} v${version}`;
  const head = <PageHead title={title} trail={[["Rubricas", "#/rubrics"], [`${rubricId} v${version}`]]} />;
  if (loaded.status === "loading" && !model) return <>{head}<Loading /></>;
  if (loaded.status === "error") return <>{head}<ErrorAlert message={loaded.message} /></>;
  if (!model) return <>{head}<Loading /></>;

  const editable = status === "DRAFT" && can("EDITOR");
  const ro = !editable;
  const edit = (fn: (m: RubricModel) => RubricModel) => {
    setModel((m) => (m ? fn(m) : m));
    setDirty(true);
  };
  const setCrit = (key: number, c: CriterionInput) => edit((m) => ({ ...m, crits: m.crits.map((x) => (x.key === key ? { ...x, c } : x)) }));

  const fail = (e: unknown) => {
    toast(e instanceof Error ? e.message : "Erro inesperado.", true);
    if (e instanceof ApiError && e.code === "CONFLICT") setReloads((n) => n + 1);
  };
  const save = async () => {
    try {
      const r = await api("rubrics.saveDraft", { rubric_id: rubricId, version, etag, draft: toDraft(model) });
      setEtag(r.etag);
      setDirty(false);
      setIssues(r.issues);
      if (r.issues.length) setOpen(new Set(model.crits.map((x) => x.key)));
      toast(r.issues.length ? `Salvo com ${r.issues.length} pendência(s).` : "Rascunho salvo.");
      return r;
    } catch (e) {
      fail(e);
      return null;
    }
  };
  const publish = async () => {
    const r = await save();
    if (!r) return;
    if (r.issues.length) {
      toast("Resolva as pendências antes de publicar.", true);
      return;
    }
    const yes = await confirm({
      title: `Publicar ${rubricId} v${version}`,
      okLabel: "Publicar",
      body: (
        <>
          <p class="mb-2">Depois de publicada, esta versão será imutável e passará a ser a versão mais recente usada pelo processamento.</p>
          <p class="text-muted">{model.crits.filter((x) => x.c.enabled).length} critério(s) habilitado(s) · nota mínima {model.policy.minimum_approval_score}</p>
        </>
      ),
    });
    if (!yes) return;
    try {
      await api("rubrics.publish", { rubric_id: rubricId, version, etag: r.etag });
      toast("Rubrica publicada.");
    } catch (e) {
      fail(e);
    }
    setReloads((n) => n + 1);
  };
  const discard = async () => {
    const yes = await confirm({ title: "Descartar rascunho", okLabel: "Descartar", danger: true, body: <p>O rascunho e seus critérios serão apagados. Isso não afeta versões publicadas.</p> });
    if (!yes) return;
    try {
      await api("rubrics.deleteDraft", { rubric_id: rubricId, version });
      setDirty(false);
      window.__sciDirty = null;
      toast("Rascunho descartado.");
      go("#/rubrics");
    } catch (e) {
      fail(e);
    }
  };

  const allOpen = (on: boolean) => setOpen(on ? new Set(model.crits.map((x) => x.key)) : new Set());
  return (
    <>
      {head}
      <div class="flex flex-col gap-4">
        {status !== "DRAFT" ? <Alert tone="info">Esta versão está publicada e é imutável. Para alterar, crie uma nova revisão na lista de rubricas.</Alert> : null}
        {issues.length ? (
          <Alert tone="warn">
            <strong>Pendências antes de publicar:</strong>
            <ul class="mt-1 list-disc pl-5">{issues.map((i) => <li key={`${i.path}:${i.message}`}>{i.path}: {i.message}</li>)}</ul>
          </Alert>
        ) : null}
        <Card>
          <div class="grid gap-4 sm:grid-cols-2">
            <Field label="Nome"><Input value={model.name} disabled={ro} maxLength={120} onInput={(e) => edit((m) => ({ ...m, name: e.currentTarget.value }))} /></Field>
            <Field label="Descrição"><Input value={model.description} disabled={ro} maxLength={1000} onInput={(e) => edit((m) => ({ ...m, description: e.currentTarget.value }))} /></Field>
          </div>
        </Card>
        <div>
          <Tabs label="Seções da rubrica" idPrefix="rub" items={TABS} value={tab} onChange={setTab} />
          <div class="pt-4">
            <TabPanel idPrefix="rub" id="criteria" active={tab === "criteria"}>
              {model.crits.length > 1 ? (
                <div class="mb-3 flex items-center gap-2">
                  <span class="text-muted">{fmtInt(model.crits.length)} critérios</span>
                  <span class="flex-1" />
                  <Button small onClick={() => allOpen(true)}>Expandir todos</Button>
                  <Button small onClick={() => allOpen(false)}>Recolher todos</Button>
                </div>
              ) : model.crits.length === 1 ? <div class="mb-3 text-muted">1 critério</div> : null}
              {model.crits.map((item) => (
                <CriterionCard
                  key={item.key}
                  model={model}
                  item={item}
                  ro={ro}
                  open={open.has(item.key)}
                  onToggle={() => setOpen((s) => { const n = new Set(s); if (!n.delete(item.key)) n.add(item.key); return n; })}
                  onChange={(c) => setCrit(item.key, c)}
                  onRemove={() => {
                    edit((m) => ({ ...m, crits: m.crits.filter((x) => x.key !== item.key) }));
                    setIssues([]);
                  }}
                />
              ))}
              {ro ? null : (
                <Button
                  onClick={() => {
                    const nc = blankCriterion(model.crits.length + 1);
                    edit((m) => ({ ...m, crits: [...m.crits, nc] }));
                    setOpen((s) => new Set(s).add(nc.key));
                  }}
                >
                  Adicionar critério
                </Button>
              )}
            </TabPanel>
            <TabPanel idPrefix="rub" id="policy" active={tab === "policy"}>
              <PolicyPanel policy={model.policy} ro={ro} onChange={(policy) => edit((m) => ({ ...m, policy }))} />
            </TabPanel>
            <TabPanel idPrefix="rub" id="general" active={tab === "general"}>
              <GeneralPanel value={model.summary_prompt} ro={ro} onChange={(v) => edit((m) => ({ ...m, summary_prompt: v }))} />
            </TabPanel>
          </div>
        </div>
        <p class="text-muted">Soma dos pesos habilitados: {fmtNum(weightSum(model.crits))} (os pesos são normalizados na nota).</p>
        {editable ? (
          <div class="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-2 border-t border-line bg-bg/95 px-1 py-3 backdrop-blur">
            <Button variant="primary" icon="save" onClick={save}>Salvar rascunho</Button>
            {can("ADMIN") ? <Button icon="publish" onClick={publish}>Publicar…</Button> : <span class="text-muted">Somente administradores publicam.</span>}
            <span class="flex-1" />
            <Button variant="danger" icon="trash" onClick={discard}>Descartar rascunho</Button>
          </div>
        ) : null}
      </div>
    </>
  );
}
