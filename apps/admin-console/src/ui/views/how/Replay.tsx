import { useEffect, useState } from "preact/hooks";
import { Alert, EmptyState } from "../../components/Alert";
import { Badge, StatusBadge, STATUS } from "../../components/Badge";
import { KV, Loading, SummaryGrid } from "../../components/Bits";
import { Button, IconButton } from "../../components/Button";
import { Card } from "../../components/Card";
import { Chat } from "../../components/Chat";
import { DataTable } from "../../components/DataTable";
import { Select } from "../../components/Field";
import { ReasonBlock } from "../../components/ReasonBlock";
import { RubricBadge } from "../../components/RubricBadge";
import { REPLAY_STEPS } from "../../lib/howData";
import { cx } from "../../lib/cx";
import { fmtDt, fmtInt, fmtNum, fmtPct, fmtUsd, isoDay } from "../../lib/format";
import { ruleText } from "../../lib/pipelineState";
import { answerValue, formulaText, noteText, scoreBreakdown } from "../../lib/score";
import type { CriterionResult, RubricView, SessionDetail } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";
import { useSession } from "../../state/session";

const TYPE_LABEL: Record<string, string> = { PREDICATE: "Sim/Não", CHOICE: "Escolha", SCORE: "Níveis" };
const SPEEDS: Array<[number, string]> = [[7000, "Lenta"], [4000, "Normal"], [2000, "Rápida"]];
const LAST = REPLAY_STEPS.length - 1;

interface Loaded {
  d: SessionDetail;
  rubric: RubricView | null;
}

function StepBody({ step, loaded }: { step: number; loaded: Loaded }) {
  const { d, rubric } = loaded;
  const a = d.analyses[0];
  if (!a) return null;
  const crit = d.criteria.filter((c) => c.analysis_id === a.analysis_id);
  const byId = new Map((rubric?.draft.criteria ?? []).map((c) => [c.criterion_id, c]));
  const name = (id: string) => byId.get(id)?.criterion_name || id;
  const answerOf = (c: CriterionResult) => {
    const v = answerValue(c);
    return v === null ? "—" : String(v);
  };

  if (step === 0) {
    const shown = d.messages.slice(0, 8);
    return (
      <>
        <p class="mb-3 text-muted">Origem: tabelas de sessões e mensagens do BigQuery. Esta sessão tem {fmtInt(d.messages.length)} mensagens; só o texto vai para a IA.</p>
        <Chat messages={shown} />
        {d.messages.length > shown.length ? <p class="mt-3 text-xs text-muted">… e mais {fmtInt(d.messages.length - shown.length)} mensagens.</p> : null}
      </>
    );
  }
  if (step === 1) {
    if (!rubric) return <Alert tone="info">Os detalhes desta rubrica não estão disponíveis.</Alert>;
    const pol = rubric.draft.policy;
    return (
      <>
        <p class="mb-3 text-muted">
          Rubrica <RubricBadge rubricId={a.rubric_id} version={a.rubric_version} /> · aprovação mínima <strong>{fmtNum(pol.minimum_approval_score, 0)}</strong> · sem evidência: {pol.missing_evidence_policy === "EXCLUDE_OPTIONAL" ? "ignora os opcionais, pede revisão nos obrigatórios" : "pede revisão"}
        </p>
        <DataTable
          caption="Critérios da rubrica"
          rows={rubric.draft.criteria.filter((c) => c.enabled !== false)}
          rowKey={(c) => c.criterion_id}
          columns={[
            { header: "Critério", cell: (c) => <span><strong>{c.criterion_name || c.criterion_id}</strong> <span class="font-mono text-xs text-muted">{c.criterion_id}</span></span> },
            { header: "Tipo", cell: (c) => TYPE_LABEL[c.evaluation_type] ?? c.evaluation_type },
            { header: "Peso", align: "right", cell: (c) => fmtNum(c.weight) },
            { header: "Obrigatório", cell: (c) => (c.required ? <Badge tone="warn">Obrigatório</Badge> : "—") },
            { header: "Quando se aplica", cell: (c) => ruleText(c.applicability_rule) },
          ]}
        />
      </>
    );
  }
  if (step === 2) {
    if (!crit.length) return <Alert tone="info">Nenhum critério foi avaliado nesta análise (por exemplo, conversa abaixo do mínimo de mensagens da rubrica). Nesse caso a IA nem é chamada.</Alert>;
    return (
      <>
        <p class="mb-3 text-muted">Modelo <span class="font-mono">{a.model || "—"}</span> · prompt <span class="font-mono">{a.prompt_version || "—"}</span> · custo {fmtUsd(a.estimated_cost_usd)}</p>
        <DataTable
          caption="Respostas da IA"
          rows={crit}
          rowKey={(c) => c.criterion_id}
          columns={[
            { header: "Critério", cell: (c) => name(c.criterion_id) },
            { header: "Resposta da IA", cell: (c) => <span class="font-mono text-xs">{answerOf(c)}</span> },
            { header: "Situação", cell: (c) => <StatusBadge code={c.applicability_status} /> },
            { header: "Evidências", align: "right", cell: (c) => fmtInt((c.evidence_message_ids ?? []).length) },
            { header: "Confiança (só informativa)", align: "right", cell: (c) => (c.confidence === null || c.confidence === undefined ? "—" : fmtPct(c.confidence)) },
          ]}
        />
        <p class="mt-3 text-xs text-muted">A confiança nunca entra na nota. Critério sem evidência não vira zero: vai para revisão ou fica de fora, conforme a política.</p>
      </>
    );
  }
  if (step === 3) {
    const bd = scoreBreakdown(crit, a);
    const min = rubric ? Number(rubric.draft.policy.minimum_approval_score) : null;
    return (
      <>
        <DataTable
          caption="Cálculo da nota"
          rows={crit}
          rowKey={(c) => c.criterion_id}
          columns={[
            { header: "Critério", cell: (c) => name(c.criterion_id) },
            { header: "Nota (0 a 100)", align: "right", cell: (c) => (c.normalized_score === null || c.normalized_score === undefined ? "—" : noteText(c)) },
            { header: "Peso", align: "right", cell: (c) => fmtNum(c.criterion_weight) },
            {
              header: "Contribuição",
              align: "right",
              cell: (c) => (c.applicability_status !== "APPLICABLE" || c.normalized_score === null || c.normalized_score === undefined ? <span class="text-muted">fora do cálculo</span> : bd.totalW ? fmtNum((Number(c.criterion_weight) * Number(c.normalized_score)) / bd.totalW, 1) : "—"),
            },
            {
              header: "Obrigatório",
              cell: (c) => {
                if (!byId.get(c.criterion_id)?.required) return "—";
                return min !== null && c.normalized_score !== null && Number(c.normalized_score) < min ? <Badge tone="bad">abaixo do mínimo</Badge> : <Badge tone="ok">ok</Badge>;
              },
            },
          ]}
        />
        <p class="mt-3">Σ pesos aplicáveis = <strong>{fmtNum(bd.totalW, 0)}</strong> · nota = <strong>{fmtNum(a.overall_score)}</strong>{min !== null ? ` · mínimo ${fmtNum(min, 0)}` : ""}</p>
        {bd.matches ? <p class="mt-1 text-xs text-muted">{formulaText(bd)}</p> : null}
        <p class="mt-1 text-xs text-muted">Não aplicável e sem evidência não valem zero: saem do cálculo. Um critério obrigatório abaixo do mínimo reprova mesmo com a média acima dele.</p>
      </>
    );
  }
  if (step === 4) {
    return (
      <>
        <SummaryGrid>
          <KV label="Status da análise"><StatusBadge code={a.analysis_status} /></KV>
          <KV label="Resultado">{a.approval_status ? <StatusBadge code={a.approval_status} /> : "—"}</KV>
          <KV label="Nota"><strong>{fmtNum(a.overall_score)}</strong></KV>
          <KV label="Modelo"><span class="font-mono text-xs">{a.model || "—"}</span></KV>
          <KV label="Prompt"><span class="font-mono text-xs">{a.prompt_version || "—"}</span></KV>
        </SummaryGrid>
        <ReasonBlock a={a} />
        <p class="mt-3 text-xs text-muted">Gravado no BigQuery com a rubrica, o modelo e a versão do prompt. Repetir a análise da mesma conversa com os mesmos dados não cria outro resultado.</p>
      </>
    );
  }
  const dec = (d.decisions ?? []).find((x) => x.analysis_id === a.analysis_id);
  if (dec) {
    return (
      <>
        <p>Decisão registrada: <StatusBadge code={dec.decision} /> por {dec.reviewer_email || "—"} em {fmtDt(dec.decided_at)}.</p>
        <p class="mt-1 text-xs text-muted">A análise original não foi alterada: a decisão fica ao lado dela.</p>
      </>
    );
  }
  if (a.analysis_status === "NEEDS_REVIEW") {
    return (
      <div class="flex flex-col items-start gap-3">
        <Alert tone="warn">Esta análise está na fila de revisão. Um Editor ou Administrador confirma, discorda ou pede nova análise.</Alert>
        <a href={`#/sessions/${encodeURIComponent(d.session.session_id)}`} class="inline-flex h-9 items-center rounded-control bg-primary px-4 font-medium text-on-primary hover:no-underline">Abrir a sessão para decidir</a>
      </div>
    );
  }
  return (
    <>
      <p>Esta análise não precisou de revisão humana.</p>
      <p class="mt-1 text-xs text-muted">Quando o motor não tem certeza (evidência insuficiente ou conversa curta demais), a análise vai para a fila de revisão e uma pessoa decide.</p>
    </>
  );
}

/** Reproduces, step by step, what is stored for one session. It never calls the AI provider: it re-reads the conversation, the rubric, the answers and the score. */
export function Replay({ onActiveStep }: { onActiveStep: (step: number | null) => void }) {
  const { api } = useSession();
  const [sid, setSid] = useState("");
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4000);

  const list = useAsync(async () => {
    const r = await api("sessions.list", { from: isoDay(364), to: isoDay(0), status: "", limit: 50 });
    return r.rows.filter((x) => x.analysis_status);
  }, []);
  useEffect(() => {
    if (list.status === "ready" && !sid && list.data[0]) setSid(list.data[0].session_id);
  }, [list]); // eslint-disable-line react-hooks/exhaustive-deps

  const loaded = useAsync<Loaded | null>(async () => {
    if (!sid) return null;
    const d = await api("sessions.get", { sessionId: sid });
    if (!d.analyses.length) throw new Error("Esta sessão ainda não foi analisada.");
    const a = d.analyses[0];
    const rubric = a ? await api("rubrics.get", { rubric_id: a.rubric_id, version: a.rubric_version }).catch(() => null) : null;
    return { d, rubric };
  }, [sid]);

  useEffect(() => {
    setStep(0);
    setPlaying(false);
  }, [sid]);
  const ready = loaded.status === "ready" && loaded.data !== null;
  useEffect(() => {
    onActiveStep(ready ? step : null);
  }, [ready, step]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onActiveStep(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Playing: one step at a time, each for the chosen time; at the last one it stops.
  useEffect(() => {
    if (!playing) return;
    if (step >= LAST) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setStep((s) => s + 1), speed);
    return () => clearTimeout(t);
  }, [playing, step, speed]);

  const goto = (i: number) => {
    setPlaying(false);
    setStep(i);
  };
  const toggle = () => {
    if (playing) setPlaying(false);
    else {
      if (step >= LAST) setStep(0);
      setPlaying(true);
    }
  };
  const [title, text] = REPLAY_STEPS[step] ?? ["", ""];
  return (
    <Card
      title="Replay de uma análise real"
      aside={
        <label class="flex items-center gap-2">
          Sessão
          <Select class="!h-8 !w-72" aria-label="Sessão para o replay" value={sid} onChange={(e) => setSid(e.currentTarget.value)}>
            {list.status === "loading" ? <option value="">Carregando sessões…</option> : null}
            {list.status === "error" ? <option value="">Erro ao listar</option> : null}
            {list.status === "ready" && !list.data.length ? <option value="">Nenhuma sessão analisada</option> : null}
            {list.status === "ready" ? list.data.map((x) => <option key={x.session_id} value={x.session_id} selected={x.session_id === sid}>{`${x.session_id} · ${STATUS[x.approval_status || x.analysis_status || ""]?.[0] ?? (x.approval_status || x.analysis_status)}${x.overall_score !== null && x.overall_score !== undefined ? ` · nota ${fmtNum(x.overall_score)}` : ""}`}</option>) : null}
          </Select>
        </label>
      }
    >
      <p class="mb-4 text-muted">Reproduz, passo a passo, o que está gravado para uma sessão. Não chama a IA e não gera custo. Abrir o conteúdo da conversa fica registrado na auditoria.</p>
      {list.status === "error" ? <Alert tone="bad">{list.message}</Alert> : null}
      {list.status === "ready" && !list.data.length ? <EmptyState icon="sessions">Escolha uma sessão analisada para ver o replay.</EmptyState> : null}
      {loaded.status === "loading" && sid ? <Loading /> : null}
      {loaded.status === "error" ? <Alert tone="bad">{loaded.message}</Alert> : null}
      {ready && loaded.data ? (
        <>
          <div role="group" aria-label="Passos do replay" class="mb-4 flex flex-wrap gap-2">
            {REPLAY_STEPS.map((s, i) => (
              <button key={s[0]} type="button" aria-current={i === step ? "step" : undefined} onClick={() => goto(i)} class={cx("inline-flex h-9 items-center gap-2 rounded-full border px-3 text-[13px] font-medium", i === step ? "border-primary bg-primary-soft text-on-primary-soft" : i < step ? "border-line bg-surface-2 text-fg" : "border-line text-muted hover:bg-surface-2")}>
                <span class="inline-flex size-5 items-center justify-center rounded-full bg-surface text-xs">{i + 1}</span>
                {s[0]}
              </button>
            ))}
          </div>
          <div aria-live="polite" class="rounded-card border border-line p-4">
            <h3 class="mb-1 text-base font-semibold">{step + 1}. {title}</h3>
            <p class="mb-3 text-muted">{text}</p>
            <StepBody step={step} loaded={loaded.data} />
          </div>
          <div class="mt-4 flex flex-wrap items-center gap-2">
            <IconButton icon="prev" label="Passo anterior" disabled={step === 0} onClick={() => goto(step - 1)} />
            <Button variant="primary" icon={playing ? "pause" : "play"} onClick={toggle}>{playing ? "Pausar" : step >= LAST ? "Reproduzir de novo" : "Reproduzir"}</Button>
            <IconButton icon="chevron" label="Próximo passo" disabled={step >= LAST} onClick={() => goto(step + 1)} />
            <span class="flex-1" />
            <label class="flex items-center gap-2 text-xs text-muted">
              Velocidade
              <Select class="!h-8 !w-28" aria-label="Velocidade" value={speed} onChange={(e) => setSpeed(Number(e.currentTarget.value))}>
                {SPEEDS.map(([v, l]) => <option key={v} value={v} selected={v === speed}>{l}</option>)}
              </Select>
            </label>
          </div>
        </>
      ) : null}
    </Card>
  );
}
