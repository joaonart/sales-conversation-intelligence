import { useEffect, useState } from "preact/hooks";
import { go } from "../app/router";
import { StatusBadge } from "../components/Badge";
import { Field, FacetSelect, Input, Select } from "../components/Field";
import { FilterBar } from "../components/FilterBar";
import { PagedTable } from "../components/PagedTable";
import { PageHead } from "../components/PageHead";
import { RubricBadge } from "../components/RubricBadge";
import { fmtDt, fmtNum, fmtInt, isoDay } from "../lib/format";
import { readPaging, usePagedList } from "../lib/usePagedList";
import type { SessionFilters, SessionListRow } from "../lib/types";
import { useSession } from "../state/session";
import { SessionDetail } from "./session/SessionDetail";

const RESULT_OPTIONS: Array<[string, string]> = [["", "Todos"], ["APPROVED", "Aprovada"], ["REJECTED", "Reprovada"], ["PENDING", "Pendente de revisão"], ["N_A", "Não se aplica"]];
const STATUS_OPTIONS: Array<[string, string]> = [["", "Todos"], ["ANALYSED", "Com análise"], ["COMPLETED", "Concluída"], ["NEEDS_REVIEW", "Revisão necessária"], ["NOT_EVALUABLE", "Não avaliável"], ["FAILED", "Falha"], ["UNANALYSED", "Não analisada"]];

// 180 days: the dashboard counts by analysis day, and sessions of the same analyses started earlier.
const defaults = (): SessionFilters => ({ from: isoDay(179), to: isoDay(0), status: "", result: "", channel: "", rubric: "", query: "", analysed_from: "", analysed_to: "" });
const differs = (a: SessionFilters, b: SessionFilters) => (Object.keys(a) as Array<keyof SessionFilters>).some((k) => a[k] !== b[k]);

function SessionList() {
  const { api, tenantKey } = useSession();
  const [initial] = useState(() => readPaging<SessionFilters>("sessions", tenantKey));
  const [draft, setDraft] = useState<SessionFilters>({ ...defaults(), ...(initial?.filters ?? {}) });
  const [applied, setApplied] = useState<SessionFilters>(draft);
  const [channels, setChannels] = useState<string[]>([]);
  const [rubrics, setRubrics] = useState<string[]>([]);
  const loadChannels = (from: string, to: string) => api("sessions.channels", { from, to }).then(setChannels, () => undefined);
  useEffect(() => {
    void loadChannels(applied.from, applied.to);
    api("rubrics.ids").then(setRubrics, () => undefined); // optional: the filter keeps working with what it has
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const list = usePagedList<SessionListRow, SessionFilters>({
    key: "sessions",
    tenantKey,
    filters: applied,
    restore: initial,
    load: (cursor, limit) => api("sessions.list", { ...applied, limit, cursor }),
    count: () => api("sessions.count", applied),
    // One row is one analysis (a session and a rubric): the note says how many sessions are behind them when that differs, so the total reconciles with the Painel.
    noteOf: (r) => (r.sessions !== undefined && r.sessions !== r.total ? `${fmtInt(Number(r.sessions))} ${r.sessions === 1 ? "sessão" : "sessões"}` : ""),
  });
  const set = (patch: Partial<SessionFilters>) => setDraft((d) => ({ ...d, ...patch }));
  const options = (opts: Array<[string, string]>, value: string, key: keyof SessionFilters, label: string) => (
    <Field label={label}>
      <Select aria-label={label} value={value} onChange={(e) => set({ [key]: e.currentTarget.value })}>
        {opts.map(([v, l]) => <option key={v} value={v} selected={v === value}>{l}</option>)}
      </Select>
    </Field>
  );
  return (
    <>
      <PageHead title="Sessões" subtitle="Conversas e a análise mais recente de cada rubrica" />
      <FilterBar
        dirty={differs(draft, defaults())}
        onSubmit={() => {
          void loadChannels(draft.from, draft.to);
          setApplied(draft);
        }}
        onClear={() => {
          const d = defaults();
          setDraft(d);
          setApplied(d);
          void loadChannels(d.from, d.to);
        }}
      >
        <Field label="De"><Input type="date" value={draft.from} onChange={(e) => set({ from: e.currentTarget.value })} /></Field>
        <Field label="Até"><Input type="date" value={draft.to} onChange={(e) => set({ to: e.currentTarget.value })} /></Field>
        {options(STATUS_OPTIONS, draft.status, "status", "Status")}
        {options(RESULT_OPTIONS, draft.result, "result", "Resultado")}
        <FacetSelect label="Canal" first="Todos" value={draft.channel} values={channels} onChange={(v) => set({ channel: v })} />
        <FacetSelect label="Rubrica" first="Todas" value={draft.rubric} values={rubrics} onChange={(v) => set({ rubric: v })} />
        <Field label="ID da sessão"><Input type="search" placeholder="exato" maxLength={128} value={draft.query} onInput={(e) => set({ query: e.currentTarget.value.trim() })} /></Field>
        <Field label="Analisada de"><Input type="date" value={draft.analysed_from} onChange={(e) => set({ analysed_from: e.currentTarget.value })} /></Field>
        <Field label="Analisada até"><Input type="date" value={draft.analysed_to} onChange={(e) => set({ analysed_to: e.currentTarget.value })} /></Field>
      </FilterBar>
      <PagedTable
        list={list}
        unit="análises"
        caption="Sessões e análises"
        emptyIcon="sessions"
        empty={differs(applied, defaults()) ? "Nenhuma sessão com estes filtros." : "Nenhuma sessão encontrada neste período."}
        rowKey={(r) => `${r.session_id}|${r.rubric_id ?? ""}|${r.rubric_version ?? ""}`}
        onRowClick={(r) => go(`#/sessions/${encodeURIComponent(r.session_id)}`)}
        columns={[
          { header: "Sessão", cell: (r) => <span class="font-mono text-xs">{r.session_id}</span> },
          { header: "Início", cell: (r) => fmtDt(r.started_at) },
          { header: "Canal", cell: (r) => r.channel ?? "—" },
          { header: "Status", cell: (r) => (r.analysis_status ? <StatusBadge code={r.analysis_status} /> : <span class="text-muted">Não analisada</span>) },
          { header: "Nota", align: "right", cell: (r) => fmtNum(r.overall_score) },
          { header: "Resultado", cell: (r) => <StatusBadge code={r.approval_status} /> },
          { header: "Rubrica", cell: (r) => (r.rubric_id ? <RubricBadge rubricId={r.rubric_id} version={r.rubric_version ?? 0} /> : "—") },
        ]}
      />
    </>
  );
}

export function SessionsView({ parts }: { parts: string[] }) {
  const id = parts[0];
  return id ? <SessionDetail sessionId={decodeURIComponent(id)} /> : <SessionList />;
}
