import { useState } from "preact/hooks";
import { go } from "../../app/router";
import { Alert } from "../../components/Alert";
import { StatusBadge, STATUS } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { useConfirm } from "../../components/Modal";
import { reasonItems } from "../../components/ReasonBlock";
import { RubricBadge } from "../../components/RubricBadge";
import { useToast } from "../../components/Toasts";
import { DECISION_INFO, MAX_REVIEW_COMMENT, decisionValid, reviewWhy } from "../../lib/evidence";
import { fmtDt, fmtNum } from "../../lib/format";
import { ROLE_LABEL, type CriterionResult, type ReviewDecisionRow, type SessionAnalysis } from "../../lib/types";
import { useSession } from "../../state/session";

interface Props {
  sessionId: string;
  analysis: SessionAnalysis;
  crit: CriterionResult[];
  decision: ReviewDecisionRow | undefined;
  /** Called after a decision was recorded: the page reads the session again. */
  onDecided: () => void;
}

/** Goes to the next session still waiting for a decision, or back to the queue when there is none. */
async function nextInQueue(api: ReturnType<typeof useSession>["api"], currentId: string, fail: (e: unknown) => void): Promise<void> {
  try {
    const page = await api("review.list", { limit: 20, filter: "pending" });
    const next = page.rows.find((r) => r.session_id !== currentId);
    go(next ? `#/sessions/${encodeURIComponent(next.session_id)}` : "#/review");
  } catch (e) {
    fail(e);
  }
}

/**
 * One card per analysis that is (or was) in review: the reason, what to do, and either the decision form or the decision already recorded.
 * A decision is stored next to the analysis (review_decisions): it never changes the analysis, its score or its status.
 */
export function ReviewCard({ sessionId, analysis: a, crit, decision: done, onDecided }: Props) {
  const { api, role, can } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const [sel, setSel] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => toast(e instanceof Error ? e.message : "Erro inesperado.", true);
  const head = (
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <RubricBadge rubricId={a.rubric_id} version={a.rubric_version} />
      <StatusBadge code={done ? done.decision : "PENDING_REVIEW"} />
    </div>
  );

  if (done) {
    return (
      <Card title="Revisão">
        {head}
        <p><strong>{DECISION_INFO[done.decision]?.[0] ?? done.decision}</strong> · {done.reviewer_email} · {fmtDt(done.decided_at)}</p>
        {done.comment ? <blockquote class="my-2 border-l-4 border-line pl-3 whitespace-pre-wrap">{done.comment}</blockquote> : <p class="text-muted">Sem justificativa.</p>}
        <p class="text-xs text-muted">A análise original não foi alterada: nota {fmtNum(a.overall_score)}, status {STATUS[a.analysis_status]?.[0] ?? a.analysis_status}.</p>
      </Card>
    );
  }

  const why = reviewWhy(crit);
  const reasons = reasonItems(a);
  const why_ = (
    <div class="rounded-control bg-surface-2 p-3">
      <div class="text-xs font-medium tracking-wide text-muted uppercase">Por que está aqui</div>
      <ul class="mt-1 list-disc space-y-1 pl-5">
        {reasons.map((r, i) => <li key={`r${i}`}>{r}</li>)}
        {why.map((t) => <li key={t}>{t}</li>)}
      </ul>
      <div class="mt-2 text-muted">Nota do motor: <strong class="text-fg">{fmtNum(a.overall_score)}</strong>{a.approval_status ? ` · ${STATUS[a.approval_status]?.[0] ?? a.approval_status}` : ""}</div>
    </div>
  );
  if (!can("EDITOR")) {
    return (
      <Card title="Revisão">
        {head}
        {why_}
        <Alert tone="info" class="mt-3">Seu perfil ({ROLE_LABEL[role]}) pode consultar esta análise, mas só Editor ou Administrador registra a decisão.</Alert>
      </Card>
    );
  }

  const valid = decisionValid(sel, comment);
  const submit = async () => {
    if (!sel || !valid) return;
    const yes = await confirm({
      title: "Registrar decisão?",
      okLabel: "Registrar decisão",
      body: (
        <>
          <p class="mb-2">Decisão: <strong>{DECISION_INFO[sel]?.[0]}</strong>.</p>
          <p class="text-muted">Ela ficará registrada ao lado da análise e não poderá ser alterada. A nota e o status originais não mudam.</p>
        </>
      ),
    });
    if (!yes) return;
    setBusy(true);
    try {
      await api("review.decide", { sessionId, analysisId: a.analysis_id, decision: sel, comment: comment.trim() });
      toast("Decisão registrada.");
      onDecided();
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  };
  const name = `dec-${a.analysis_id}`;
  return (
    <Card title="Revisão">
      {head}
      {why_}
      <div class="mt-4 text-xs font-medium tracking-wide text-muted uppercase">O que fazer</div>
      <p class="mt-1 mb-3 text-muted">Leia a conversa abaixo (as evidências estão destacadas) e compare com os critérios da análise. Depois escolha uma decisão.</p>
      <div role="radiogroup" aria-label="Sua decisão" class="flex flex-col gap-2">
        {Object.entries(DECISION_INFO).map(([k, [label, help]]) => (
          <label key={k} class="flex cursor-pointer items-start gap-3 rounded-control border border-line p-3 has-[:checked]:border-primary has-[:checked]:bg-primary-soft">
            <input type="radio" name={name} value={k} checked={sel === k} onChange={() => setSel(k)} class="mt-1" />
            <span><span class="block font-medium">{label}</span><span class="block text-xs text-muted">{help}</span></span>
          </label>
        ))}
      </div>
      <label class="mt-4 block">
        <span class="mb-1 flex items-center justify-between text-xs font-medium text-muted"><span>Justificativa</span><span class="font-normal">{comment.length}/{MAX_REVIEW_COMMENT}</span></span>
        <textarea
          rows={3}
          maxLength={MAX_REVIEW_COMMENT}
          aria-label="Justificativa"
          placeholder="Justificativa (obrigatória para discordar ou recomendar nova análise)"
          value={comment}
          onInput={(e) => setComment(e.currentTarget.value)}
          class="w-full rounded-control border border-line bg-surface p-3 text-sm placeholder:text-faint"
        />
      </label>
      <p class="mt-1 text-xs text-muted">Não inclua dados pessoais: CPF, e-mail e telefone são mascarados automaticamente. Nomes não são.</p>
      <div class="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={!valid || busy} onClick={submit}>Registrar decisão</Button>
        <Button onClick={() => nextInQueue(api, sessionId, fail)}>Pular para a próxima</Button>
        <span class="text-xs text-muted" aria-live="polite">{!sel ? "Escolha uma decisão para continuar." : valid ? "Pronto para registrar." : "Explique o motivo (pelo menos 3 caracteres)."}</span>
      </div>
    </Card>
  );
}
