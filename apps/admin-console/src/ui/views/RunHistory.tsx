import { useEffect, useState } from "preact/hooks";
import { go } from "../app/router";
import { Badge, StatusBadge } from "../components/Badge";
import { Field, FacetSelect, Input } from "../components/Field";
import { FilterBar } from "../components/FilterBar";
import { PagedTable } from "../components/PagedTable";
import { RubricBadge } from "../components/RubricBadge";
import { PROC_MODE } from "../lib/executions";
import { fmtDt, fmtInt, fmtUsd, isoDay } from "../lib/format";
import { readPaging, usePagedList } from "../lib/usePagedList";
import type { RunFilters, RunRow } from "../lib/types";
import { useSession } from "../state/session";
import { STATUS } from "../components/Badge";

const defaults = (): RunFilters => ({ from: isoDay(29), to: isoDay(0), status: "", mode: "", rubric: "", query: "" });
const differs = (a: RunFilters, b: RunFilters) => (Object.keys(a) as Array<keyof RunFilters>).some((k) => a[k] !== b[k]);

/** The processing history: the last row of each run. A click opens the run (what happened and why sessions failed). */
export function RunHistory() {
  const { api, tenantKey } = useSession();
  const [initial] = useState(() => readPaging<RunFilters>("runs", tenantKey));
  const [draft, setDraft] = useState<RunFilters>({ ...defaults(), ...(initial?.filters ?? {}) });
  const [applied, setApplied] = useState<RunFilters>(draft);
  const [facets, setFacets] = useState<{ statuses: string[]; modes: string[]; rubrics: string[] }>({ statuses: [], modes: [], rubrics: [] });
  const loadFacets = (from: string, to: string) => api("runs.facets", { from, to }).then(setFacets, () => undefined);
  useEffect(() => void loadFacets(applied.from, applied.to), []); // eslint-disable-line react-hooks/exhaustive-deps
  const list = usePagedList<RunRow, RunFilters>({
    key: "runs",
    tenantKey,
    filters: applied,
    size: 25,
    restore: initial,
    load: (cursor, limit) => api("runs.list", { ...applied, limit, cursor }),
    count: () => api("runs.count", applied),
  });
  const set = (patch: Partial<RunFilters>) => setDraft((d) => ({ ...d, ...patch }));
  return (
    <>
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
        <Field label="De"><Input type="date" value={draft.from} onChange={(e) => set({ from: e.currentTarget.value })} /></Field>
        <Field label="Até"><Input type="date" value={draft.to} onChange={(e) => set({ to: e.currentTarget.value })} /></Field>
        <FacetSelect label="Status" first="Todos" value={draft.status} values={facets.statuses} labelOf={(x) => STATUS[x]?.[0] ?? x} onChange={(v) => set({ status: v })} />
        <FacetSelect label="Modo" first="Todos" value={draft.mode} values={facets.modes} labelOf={(x) => PROC_MODE[x] ?? x} onChange={(v) => set({ mode: v })} />
        <FacetSelect label="Rubrica" first="Todas" value={draft.rubric} values={facets.rubrics} onChange={(v) => set({ rubric: v })} />
        <Field label="ID da execução"><Input type="search" placeholder="exato" maxLength={128} value={draft.query} onInput={(e) => set({ query: e.currentTarget.value.trim() })} /></Field>
      </FilterBar>
      <PagedTable
        list={list}
        unit="execuções"
        caption="Histórico de execuções"
        empty={differs(applied, defaults()) ? "Nenhuma execução com estes filtros." : "Nenhuma execução neste período."}
        rowKey={(r) => r.run_id}
        onRowClick={(r) => go(`#/runs/${encodeURIComponent(r.run_id)}`)}
        columns={[
          { header: "Execução", cell: (r) => <span class="font-mono text-xs">{r.run_id}</span> },
          { header: "Modo", cell: (r) => (r.processing_mode && PROC_MODE[r.processing_mode]) || r.processing_mode || "—" },
          { header: "Status", cell: (r) => <StatusBadge code={r.run_status} /> },
          { header: "Rubrica", cell: (r) => (r.rubric_id ? <RubricBadge rubricId={r.rubric_id} version={r.rubric_version ?? 0} /> : "—") },
          { header: "Total", align: "right", cell: (r) => fmtInt(r.sessions_total) },
          { header: "OK", align: "right", cell: (r) => fmtInt(r.sessions_processed) },
          { header: "Falhas", align: "right", cell: (r) => (Number(r.sessions_failed) > 0 ? <Badge tone="bad">{fmtInt(r.sessions_failed)}</Badge> : "0") },
          { header: "Puladas", align: "right", cell: (r) => fmtInt(r.sessions_skipped) },
          { header: "Custo", align: "right", cell: (r) => fmtUsd(r.actual_cost_usd) },
          { header: "Criada", cell: (r) => fmtDt(r.created_at) },
        ]}
      />
    </>
  );
}
