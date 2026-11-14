import { useEffect, useState } from "preact/hooks";
import { go } from "../app/router";
import { StatusBadge } from "../components/Badge";
import { Card } from "../components/Card";
import { Field, FacetSelect, Input, Select } from "../components/Field";
import { FilterBar } from "../components/FilterBar";
import { PagedTable } from "../components/PagedTable";
import { PageHead } from "../components/PageHead";
import { RubricBadge } from "../components/RubricBadge";
import { fmtDt, isoDay } from "../lib/format";
import { readPaging, usePagedList } from "../lib/usePagedList";
import { ROLE_LABEL, type ReviewFilters, type ReviewRow } from "../lib/types";
import { useSession } from "../state/session";

export const REVIEW_REASON: Array<[string, string]> = [["INSUFFICIENT", "Evidência insuficiente"], ["SHORT", "Conversa curta demais"], ["UNCERTAIN", "Decisão incerta"]];
export const REVIEW_DECISION: Array<[string, string]> = [["CONFIRMED", "Resultado confirmado"], ["DISAGREED", "Revisor discordou"], ["REANALYSIS", "Reanálise recomendada"]];
const SITUATIONS: Array<[string, string]> = [["pending", "Pendentes"], ["decided", "Decididas"], ["all", "Todas"]];

/** Why an analysis is in the queue, in words (the three cases the engine produces). */
export function reviewReason(r: Pick<ReviewRow, "insufficient" | "criteria">): string {
  if (r.insufficient > 0) return `Evidência insuficiente em ${r.insufficient} de ${r.criteria} ${r.criteria === 1 ? "critério" : "critérios"}`;
  if (!r.criteria) return "Sem avaliação por critério (conversa curta demais para a rubrica)";
  return "Decisão incerta: o motor pediu confirmação humana";
}

const defaults = (): ReviewFilters => ({ filter: "pending", from: isoDay(89), to: isoDay(0), reason: "", rubric: "", decision: "", reviewer: "", query: "" });
const differs = (a: ReviewFilters, b: ReviewFilters) => (Object.keys(a) as Array<keyof ReviewFilters>).some((k) => a[k] !== b[k]);

export function ReviewView() {
  const { api, tenantKey, role, can } = useSession();
  const canDecide = can("EDITOR");
  const [initial] = useState(() => readPaging<ReviewFilters>("review", tenantKey));
  const [draft, setDraft] = useState<ReviewFilters>({ ...defaults(), ...(initial?.filters ?? {}) });
  const [applied, setApplied] = useState<ReviewFilters>(draft);
  const [facets, setFacets] = useState<{ rubrics: string[]; reviewers: string[] }>({ rubrics: [], reviewers: [] });
  const loadFacets = (from: string, to: string) => api("review.facets", { from, to }).then(setFacets, () => undefined);
  useEffect(() => void loadFacets(applied.from, applied.to), []); // eslint-disable-line react-hooks/exhaustive-deps

  const list = usePagedList<ReviewRow, ReviewFilters>({
    key: "review",
    tenantKey,
    filters: applied,
    restore: initial,
    load: (cursor, limit) => api("review.list", { ...applied, limit, cursor }),
    count: () => api("review.count", applied),
  });
  const set = (patch: Partial<ReviewFilters>) => setDraft((d) => ({ ...d, ...patch }));
  // A decision or a reviewer only exists on decided analyses: picking one moves the view to "Decididas" instead of showing an empty list.
  const toDecided = (patch: Partial<ReviewFilters>) => set({ ...patch, ...(draft.filter === "pending" ? { filter: "decided" } : {}) });
  const narrowed = applied.reason || applied.rubric || applied.decision || applied.reviewer || applied.query;
  const empty = differs(applied, defaults()) && narrowed ? "Nada na fila com estes filtros." : applied.filter === "decided" ? "Nenhuma decisão registrada ainda." : applied.filter === "all" ? "A fila está vazia neste período." : "Nada aguardando revisão.";
  return (
    <>
      <PageHead title="Fila de revisão" subtitle="Análises que o motor não conseguiu concluir sozinho e esperam uma decisão humana" />
      <Card title="Como revisar" class="mb-4">
        <ol class="mb-3 list-decimal space-y-1 pl-5">
          <li><strong>Abra a sessão. </strong>Veja por que ela veio para a fila.</li>
          <li><strong>Leia a conversa. </strong>As mensagens usadas como evidência ficam destacadas.</li>
          <li><strong>Registre sua decisão: </strong>confirmar o resultado, discordar ou recomendar uma nova análise (que é pedida em Execuções).</li>
        </ol>
        <p class="text-muted">
          Sua decisão fica registrada ao lado da análise (quem, quando e por quê). A nota, o status e a rubrica originais não mudam.
          {canDecide ? "" : ` Seu perfil (${ROLE_LABEL[role]}) pode consultar a fila, mas só Editor ou Administrador registra decisões.`}
        </p>
      </Card>
      <FilterBar
        dirty={differs(draft, defaults())}
        onSubmit={() => {
          void loadFacets(draft.from, draft.to);
          setApplied(draft);
        }}
        onClear={() => {
          const d = defaults();
          setDraft(d);
          setApplied(d);
          void loadFacets(d.from, d.to);
        }}
      >
        <Field label="Situação">
          <Select aria-label="Situação" value={draft.filter} onChange={(e) => set({ filter: e.currentTarget.value })}>
            {SITUATIONS.map(([v, l]) => <option key={v} value={v} selected={v === draft.filter}>{l}</option>)}
          </Select>
        </Field>
        <Field label="De"><Input type="date" value={draft.from} onChange={(e) => set({ from: e.currentTarget.value })} /></Field>
        <Field label="Até"><Input type="date" value={draft.to} onChange={(e) => set({ to: e.currentTarget.value })} /></Field>
        <FacetSelect label="Por que está na fila" first="Todos" value={draft.reason} values={REVIEW_REASON.map(([v]) => v)} labelOf={(v) => REVIEW_REASON.find(([k]) => k === v)?.[1] ?? v} onChange={(v) => set({ reason: v })} />
        <FacetSelect label="Rubrica" first="Todas" value={draft.rubric} values={facets.rubrics} onChange={(v) => set({ rubric: v })} />
        <FacetSelect label="Decisão" first="Todas" value={draft.decision} values={REVIEW_DECISION.map(([v]) => v)} labelOf={(v) => REVIEW_DECISION.find(([k]) => k === v)?.[1] ?? v} onChange={(v) => toDecided({ decision: v })} />
        <FacetSelect label="Revisor" first="Todos" value={draft.reviewer} values={facets.reviewers} onChange={(v) => toDecided({ reviewer: v })} />
        <Field label="Sessão"><Input type="search" placeholder="ID exato" maxLength={128} value={draft.query} onInput={(e) => set({ query: e.currentTarget.value.trim() })} /></Field>
      </FilterBar>
      <PagedTable
        list={list}
        unit="análises"
        caption="Fila de revisão"
        emptyIcon={applied.filter === "pending" ? "ok" : "inbox"}
        empty={empty}
        rowKey={(r) => `${r.session_id}|${r.rubric_id}|${r.rubric_version}|${r.completed_at}`}
        onRowClick={(r) => go(`#/sessions/${encodeURIComponent(r.session_id)}`)}
        columns={[
          { header: "Sessão", cell: (r) => <span class="font-mono text-xs">{r.session_id}</span> },
          { header: "Por que está na fila", cell: (r) => reviewReason(r) },
          { header: "Rubrica", cell: (r) => <RubricBadge rubricId={r.rubric_id} version={r.rubric_version} /> },
          { header: "Concluída em", cell: (r) => fmtDt(r.completed_at) },
          {
            header: "Situação",
            cell: (r) =>
              r.decision ? (
                <span class="flex flex-wrap items-center gap-2">
                  <StatusBadge code={r.decision} />
                  <span class="text-xs text-muted">{r.reviewer_email ?? ""} · {fmtDt(r.decided_at)}</span>
                </span>
              ) : (
                <StatusBadge code="PENDING_REVIEW" />
              ),
          },
          {
            header: "Ação",
            cell: (r) => (
              <a href={`#/sessions/${encodeURIComponent(r.session_id)}`} class={!r.decision && canDecide ? "inline-flex h-8 items-center rounded-control bg-primary px-3 text-[13px] font-medium text-on-primary hover:no-underline" : "inline-flex h-8 items-center rounded-control border border-line px-3 text-[13px] font-medium text-fg hover:no-underline"} onClick={(e) => e.stopPropagation()}>
                {r.decision || !canDecide ? "Abrir" : "Revisar"}
              </a>
            ),
          },
        ]}
      />
    </>
  );
}
