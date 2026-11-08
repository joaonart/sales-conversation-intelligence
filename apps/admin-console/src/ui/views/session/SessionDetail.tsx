import { useRef, useState } from "preact/hooks";
import { Alert, EmptyState } from "../../components/Alert";
import { Badge, StatusBadge } from "../../components/Badge";
import { ErrorAlert, KV, Loading, SummaryGrid } from "../../components/Bits";
import { Card } from "../../components/Card";
import { Chat } from "../../components/Chat";
import { DataTable } from "../../components/DataTable";
import { CriteriaBadges, EvidenceLinks } from "../../components/Evidence";
import { PageHead } from "../../components/PageHead";
import { ReasonBlock } from "../../components/ReasonBlock";
import { RubricBadge } from "../../components/RubricBadge";
import { Switch } from "../../components/Switch";
import { PROC_MODE } from "../../lib/executions";
import { analysedOf, critKey, highlightOf, noEvidenceNote, reviewable, type Analysed } from "../../lib/evidence";
import { jumpTo } from "../../lib/dom";
import { fmtDt, fmtNum, fmtUsd } from "../../lib/format";
import { answerValue, formulaText, noteText, type Breakdown } from "../../lib/score";
import { readStore, writeStore } from "../../lib/storage";
import type { CriterionResult, SessionDetail as Detail } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";
import { useSession } from "../../state/session";
import { GeneralCard } from "./GeneralCard";
import { ReviewCard } from "./ReviewCard";

const NAMES_KEY = "sci.critnames";

/** "Nome (identificador)": the name is what people read, the id is what the rubric and the data use. Falls back to the id alone. */
function CritLabel({ r }: { r: CriterionResult }) {
  if (!r.criterion_name || r.criterion_name === r.criterion_id) return <span class="font-mono text-xs">{r.criterion_id}</span>;
  return <span><strong>{r.criterion_name}</strong> <span class="font-mono text-xs text-muted">({r.criterion_id})</span></span>;
}

function BreakdownNote({ bd, crit }: { bd: Breakdown; crit: CriterionResult[] }) {
  // The stored grade is not the plain weighted average (a held or not evaluable analysis): do not claim a formula that was not used.
  if (!bd.matches) return null;
  const out = crit.filter((c) => !bd.inside.includes(c));
  const gates = bd.inside.filter((c) => !Number(c.criterion_weight));
  return (
    <div class="mt-3 space-y-1">
      <p><strong>{formulaText(bd)}</strong></p>
      <p class="text-xs text-muted">
        Cada critério contribui com nota × peso ÷ {fmtNum(bd.totalW, 2)}, e a soma das contribuições é a nota final.
        {gates.length ? ` Peso 0 (${gates.map((c) => c.criterion_id).join(", ")}): só decide quando outros critérios se aplicam, não pesa na nota.` : ""}
        {out.length ? ` Fora do cálculo: ${out.map((c) => `${c.criterion_id} (${c.applicability_status === "NOT_APPLICABLE" ? "não aplicável" : "sem evidência"})`).join(", ")}.` : ""}
      </p>
    </div>
  );
}

function SummaryCard({ d, analysed }: { d: Detail; analysed: Analysed[] }) {
  const s = d.session;
  return (
    <Card title="Resumo" aside={<span title="Código da sessão">Sessão <span class="font-mono">{s.session_id}</span></span>}>
      <SummaryGrid>
        <KV label="Canal">{s.channel || "—"}</KV>
        <KV label="Início">{fmtDt(s.started_at)}</KV>
        <KV label="Status da sessão">{s.status || "—"}</KV>
      </SummaryGrid>
      {!analysed.length ? <p class="mt-3 text-muted">Sessão ainda não analisada.</p> : null}
      {analysed.map(({ analysis: a }) => (
        <div key={a.analysis_id} role="group" aria-label={`Análise com a rubrica ${a.rubric_id} versão ${a.rubric_version}`} class="mt-4 border-t border-divider pt-4">
          <SummaryGrid>
            <KV label="Rubrica utilizada"><RubricBadge rubricId={a.rubric_id} version={a.rubric_version} /></KV>
            <KV label="Status da análise"><StatusBadge code={a.analysis_status} /></KV>
            <KV label="Resultado">{a.approval_status ? <StatusBadge code={a.approval_status} /> : "—"}</KV>
            <KV label="Nota"><strong>{fmtNum(a.overall_score)}</strong></KV>
            <KV label="Concluída em">{fmtDt(a.completed_at)}</KV>
          </SummaryGrid>
          <div class="mt-3">
            <SummaryGrid>
              <KV label="Modelo"><span class="font-mono text-xs">{a.model || "—"}</span></KV>
              <KV label="Prompt"><span class="font-mono text-xs">{a.prompt_version || "—"}</span></KV>
              <KV label="Modo">{(a.analysis_mode && PROC_MODE[a.analysis_mode]) || a.analysis_mode || "—"}</KV>
              <KV label="Custo">{fmtUsd(a.estimated_cost_usd)}</KV>
            </SummaryGrid>
          </div>
          <ReasonBlock a={a} />
        </div>
      ))}
    </Card>
  );
}

function Body({ d, onDecided }: { d: Detail; onDecided: () => void }) {
  const { sessionId } = { sessionId: d.session.session_id };
  const analysed = analysedOf(d);
  const highlight = highlightOf(d, analysed);
  const msgEls = useRef<Record<string, HTMLElement | null>>({});
  const critRows = useRef<Record<string, HTMLElement | null>>({});
  // Per-browser convenience: which text the criterion badges carry (the name by default, the identifier if the person switches it off).
  const [showNames, setShowNames] = useState(() => readStore("local", NAMES_KEY) !== "id");
  const goMessage = (id: string) => jumpTo(msgEls.current[id]);
  const evidenceCount = d.messages.filter((m) => highlight[m.message_id]).length;
  const note = noEvidenceNote(d, evidenceCount);
  const several = d.analyses.length > 1;
  const reviews = reviewable(d);
  return (
    <div class="flex flex-col gap-4">
      <Alert tone="info">Conteúdo mascarado (CPF, CNPJ, e-mail, telefone). Nomes não são mascarados. Este acesso foi registrado na auditoria.</Alert>
      {reviews.map(({ analysis, decision }) => (
        <ReviewCard key={analysis.analysis_id} sessionId={sessionId} analysis={analysis} crit={d.criteria.filter((c) => c.analysis_id === analysis.analysis_id)} decision={decision} onDecided={onDecided} />
      ))}
      <SummaryCard d={d} analysed={analysed} />
      {analysed.map(({ analysis: a, crit, breakdown: bd }) => {
        const written = (d.summaries ?? []).find((x) => x.analysis_id === a.analysis_id);
        return (
          <div key={a.analysis_id} class="flex flex-col gap-4">
            <Card flush>
              {several ? <div class="px-5 pt-5 pb-3"><RubricBadge rubricId={a.rubric_id} version={a.rubric_version} /></div> : null}
              {!crit.length ? (
                <p class="p-5 text-muted">Nenhum critério foi avaliado nesta análise (por exemplo, conversa abaixo do mínimo de mensagens exigido pela rubrica).</p>
              ) : (
                <DataTable
                  caption="Critérios da análise"
                  rows={crit}
                  rowKey={(r) => critKey(r.analysis_id, r.criterion_id)}
                  rowRef={(r, el) => {
                    critRows.current[critKey(r.analysis_id, r.criterion_id)] = el;
                  }}
                  columns={[
                    { header: "Critério", cell: (r) => <CritLabel r={r} /> },
                    { header: "Aplicabilidade", cell: (r) => <StatusBadge code={r.applicability_status} /> },
                    { header: "Resposta", cell: (r) => { const v = answerValue(r); return v === null ? "—" : String(v); } },
                    { header: "Nota", align: "right", cell: (r) => noteText(r) },
                    { header: "Peso", align: "right", cell: (r) => fmtNum(r.criterion_weight) },
                    {
                      header: "Contribuição",
                      align: "right",
                      cell: (r) => (!bd || bd.parts[r.criterion_id] === undefined ? <span class="text-muted" title="Não entra no cálculo da nota">fora</span> : <span title={`nota × peso ÷ ${fmtNum(bd.totalW, 2)}`}>{fmtNum(bd.parts[r.criterion_id], 2)}</span>),
                    },
                    { header: "Evidências", cell: (r) => <EvidenceLinks ids={r.evidence_message_ids} messages={d.messages} onGo={goMessage} /> },
                  ]}
                  foot={bd?.matches ? <tr><td colSpan={4} class="px-4 py-2">Total dos critérios que entram no cálculo</td><td class="px-4 py-2 text-right tabular-nums">{fmtNum(bd.totalW, 2)}</td><td class="px-4 py-2 text-right tabular-nums">{fmtNum(bd.sum, 2)}</td><td /></tr> : undefined}
                />
              )}
              {bd ? <div class="px-5 pb-5"><BreakdownNote bd={bd} crit={crit} /></div> : null}
            </Card>
            {written ? <GeneralCard analysis={a} summary={written} messages={d.messages} several={several} onGo={goMessage} /> : null}
          </div>
        );
      })}
      {!d.analyses.length ? <Card><EmptyState icon="sessions">Sessão ainda não analisada.</EmptyState></Card> : null}
      <Card
        title="Mensagens"
        aside={
          <span class="flex flex-wrap items-center gap-2">
            <Badge>{d.messages.length} {d.messages.length === 1 ? "mensagem" : "mensagens"}{d.truncated ? " (truncado)" : ""}</Badge>
            {evidenceCount ? <Badge tone="warn" withIcon>{evidenceCount} {evidenceCount === 1 ? "evidência" : "evidências"}</Badge> : null}
            {/* Only when there are badges to switch: the name of the criterion (the rubric's) or its identifier (what the data and the API use). */}
            {evidenceCount ? (
              <Switch
                label="Nome do critério nas badges"
                checked={showNames}
                onChange={(on) => {
                  setShowNames(on);
                  writeStore("local", NAMES_KEY, on ? "name" : "id");
                }}
              />
            ) : null}
          </span>
        }
      >
        {note ? <p class="mb-3 text-muted">{note}</p> : null}
        {d.messages.length ? (
          <Chat
            messages={d.messages}
            marked={(m) => Boolean(highlight[m.message_id])}
            rowRef={(id, el) => {
              msgEls.current[id] = el;
            }}
            extra={(m) => (highlight[m.message_id] ? <CriteriaBadges list={highlight[m.message_id] ?? []} showNames={showNames} onJump={(key) => jumpTo(critRows.current[key])} /> : null)}
          />
        ) : (
          <EmptyState icon="sessions">Sem mensagens.</EmptyState>
        )}
      </Card>
    </div>
  );
}

export function SessionDetail({ sessionId }: { sessionId: string }) {
  const { api } = useSession();
  const [reloads, setReloads] = useState(0);
  const res = useAsync(() => api("sessions.get", { sessionId }), [sessionId, reloads]);
  return (
    <>
      <PageHead title={`Sessão ${sessionId}`} trail={[["Sessões", "#/sessions"], [sessionId]]} />
      {res.status === "loading" ? <Loading /> : null}
      {res.status === "error" ? <ErrorAlert message={res.message} /> : null}
      {res.status === "ready" ? <Body d={res.data} onDecided={() => setReloads((n) => n + 1)} /> : null}
    </>
  );
}
