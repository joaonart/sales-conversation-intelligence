import { useEffect, useState } from "preact/hooks";
import { EmptyState } from "../components/Alert";
import { Badge, StatusBadge, STATUS, type Tone } from "../components/Badge";
import { ErrorAlert, Loading } from "../components/Bits";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { DataTable } from "../components/DataTable";
import { Field, FacetSelect, Input } from "../components/Field";
import { FilterBar } from "../components/FilterBar";
import { useConfirm } from "../components/Modal";
import { PagedTable } from "../components/PagedTable";
import { RubricBadge } from "../components/RubricBadge";
import { useToast } from "../components/Toasts";
import { API_LABEL, EXEC_KIND, SCHED_STATUS, execResult, execSummary, schedWhen } from "../lib/executions";
import { fmtDt, fmtInt, fmtUsd, isoDay } from "../lib/format";
import { readPaging, usePagedList } from "../lib/usePagedList";
import { useAsync } from "../lib/useAsync";
import type { ExecFilters, ExecRow, ScheduleRow } from "../lib/types";
import { useSession } from "../state/session";

const SIZES = [5, 10, 25];
const defaults = (): ExecFilters => ({ from: isoDay(89), to: isoDay(0), status: "", kind: "", rubric: "", requested_by: "", query: "" });
const differs = (a: ExecFilters, b: ExecFilters) => (Object.keys(a) as Array<keyof ExecFilters>).some((k) => a[k] !== b[k]);

/** Pedidos de execução (administrators only; the server enforces it too). `reloadKey` changes when a request was made elsewhere. */
export function RequestsTab({ reloadKey, onChange }: { reloadKey: number; onChange: () => void }) {
  const { api, tenantKey } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const [initial] = useState(() => readPaging<ExecFilters>("execreq", tenantKey, SIZES));
  const [draft, setDraft] = useState<ExecFilters>({ ...defaults(), ...(initial?.filters ?? {}) });
  const [applied, setApplied] = useState<ExecFilters>(draft);
  const [facets, setFacets] = useState<{ statuses: string[]; kinds: string[]; rubrics: string[]; requesters: string[] }>({ statuses: [], kinds: [], rubrics: [], requesters: [] });
  const loadFacets = (from: string, to: string) => api("executions.facets", { from, to }).then(setFacets, () => undefined);
  useEffect(() => void loadFacets(applied.from, applied.to), []); // eslint-disable-line react-hooks/exhaustive-deps
  const list = usePagedList<ExecRow, ExecFilters>({
    key: "execreq",
    tenantKey,
    filters: applied,
    sizes: SIZES,
    size: 10,
    restore: initial,
    load: (cursor, limit) => api("executions.list", { ...applied, limit, cursor }),
  });
  // A new request (made in the form above) shows up: reload the page that is open.
  useEffect(() => {
    if (reloadKey) list.reload();
  }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<ExecFilters>) => setDraft((d) => ({ ...d, ...patch }));
  const cancel = async (r: ExecRow) => {
    const yes = await confirm({ title: "Cancelar pedido", okLabel: "Cancelar pedido", danger: true, body: <p>O pedido {r.request_id} deixa de aguardar o executor.</p> });
    if (!yes) return;
    try {
      await api("executions.cancel", { request_id: r.request_id });
      toast("Pedido cancelado.");
      onChange();
      list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Não foi possível cancelar.", true);
    }
  };
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
        <FacetSelect label="Tipo" first="Todos" value={draft.kind} values={facets.kinds} labelOf={(x) => EXEC_KIND[x] ?? x} onChange={(v) => set({ kind: v })} />
        <FacetSelect label="Rubrica" first="Todas" value={draft.rubric} values={facets.rubrics} onChange={(v) => set({ rubric: v })} />
        <FacetSelect label="Pedido por" first="Todos" value={draft.requested_by} values={facets.requesters} onChange={(v) => set({ requested_by: v })} />
        <Field label="ID do pedido"><Input type="search" placeholder="exato" maxLength={128} value={draft.query} onInput={(e) => set({ query: e.currentTarget.value.trim() })} /></Field>
      </FilterBar>
      <Card title="Pedidos de execução" flush>
        <p class="px-5 pb-3 text-muted">
          O console registra o pedido, com o teto de custo e quem pediu. Quem executa é o executor, que confere o teto de novo e só chama a IA se estiver habilitado. Enquanto não houver executor ligado, o pedido fica aguardando.
        </p>
        <PagedTable
          bare
          list={list}
          unit="pedidos"
          noun="Pedidos por página"
          caption="Pedidos de execução"
          empty={differs(applied, defaults()) ? "Nenhum pedido com estes filtros." : "Nenhum pedido de execução neste período."}
          rowKey={(r) => r.request_id}
          columns={[
            { header: "Pedido", cell: (r) => <span class="font-mono text-xs">{r.request_id}</span> },
            { header: "Tipo", cell: (r) => EXEC_KIND[r.kind] ?? r.kind },
            { header: "Parâmetros", cell: (r) => <span class="whitespace-normal">{execSummary(r)}</span> },
            { header: "Status", cell: (r) => <StatusBadge code={r.status} /> },
            { header: "Teto", align: "right", cell: (r) => fmtUsd(r.max_cost_usd) },
            { header: "Estimativa", align: "right", cell: (r) => fmtUsd(r.estimate_high_usd) },
            { header: "Resultado", cell: (r) => <span class="whitespace-normal">{execResult(r)}</span> },
            { header: "Pedido por", cell: (r) => <span>{r.requested_by} <span class="text-muted">{fmtDt(r.requested_at)}</span></span> },
            { header: "Ação", cell: (r) => (r.status === "REQUESTED" ? <Button small variant="danger" onClick={() => cancel(r)}>Cancelar</Button> : null) },
          ]}
        />
      </Card>
    </>
  );
}

const ACTIONS: Array<{ status: ScheduleRow["status"][]; label: string; action: string; text: string; danger: boolean }> = [
  { status: ["ACTIVE"], label: "Pausar", action: "pause", text: "A agenda deixa de pedir execuções a partir do próximo horário. Você pode retomá-la depois.", danger: false },
  { status: ["PAUSED"], label: "Retomar", action: "resume", text: "A agenda volta a pedir execuções a partir do próximo horário (não recupera os que passaram).", danger: false },
  { status: ["ACTIVE", "PAUSED"], label: "Arquivar", action: "archive", text: "A agenda deixa de existir para o executor e sai da lista. Para ter uma igual, crie outra.", danger: true },
];

/** Agendas. `reloadKey` changes when one was created in the form above. */
export function SchedulesTab({ reloadKey, onNew }: { reloadKey: number; onNew: () => void }) {
  const { api } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const [again, setAgain] = useState(0);
  const res = useAsync(() => api("schedules.list", {}), [reloadKey, again]);
  const act = async (x: ScheduleRow, a: (typeof ACTIONS)[number]) => {
    const yes = await confirm({ title: `${a.label} agenda`, okLabel: a.label, danger: a.danger, body: <p>{a.text}</p> });
    if (!yes) return;
    try {
      await api("schedules.setStatus", { schedule_id: x.schedule_id, action: a.action });
      toast("Agenda atualizada.");
      setAgain((n) => n + 1);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Não foi possível atualizar.", true);
    }
  };
  return (
    <Card title="Agendas" aside={<Button small variant="primary" icon="add" onClick={onNew}>Nova agenda</Button>} flush>
      <p class="px-5 pb-3 text-muted">
        Uma agenda pede uma execução no horário escolhido, sem ninguém precisar abrir o console. Ela nunca gasta por conta própria: o executor confere de novo o teto de cada execução, o teto mensal de IA e se quem criou a agenda ainda é administrador. Se a IA do executor estiver desligada, nada roda.
      </p>
      {res.status === "loading" ? <Loading /> : null}
      {res.status === "error" ? <div class="p-4"><ErrorAlert message={res.message} /></div> : null}
      {res.status === "ready" && !res.data.rows.length ? <EmptyState icon="clock">Nenhuma agenda. Crie uma para que o executor analise as sessões novas sozinho.</EmptyState> : null}
      {res.status === "ready" && res.data.rows.length ? (
        <DataTable
          caption="Agendas"
          rows={res.data.rows}
          rowKey={(x) => x.schedule_id}
          columns={[
            {
              header: "Agenda",
              cell: (x) => {
                const [label, tone] = SCHED_STATUS[x.status] ?? [x.status, "neutral" as Tone];
                return (
                  <div>
                    <div class="flex items-center gap-2"><strong>{x.name}</strong><Badge tone={tone}>{label}</Badge></div>
                    <div class="text-xs text-muted whitespace-normal">{schedWhen(x)}</div>
                  </div>
                );
              },
            },
            {
              header: "O que roda",
              cell: (x) => (
                <div class="whitespace-normal">
                  <RubricBadge rubricId={x.rubric_id} version={x.rubric_version} />
                  <div class="mt-1 text-xs">Últimos {x.window_days} dias · até {fmtInt(x.max_sessions)} sessões{x.only_routed ? " · somente roteadas" : ""}</div>
                  <div class="text-xs text-muted">{x.model} ({API_LABEL[x.provider] ?? x.provider})</div>
                </div>
              ),
            },
            { header: "Teto por execução", align: "right", cell: (x) => fmtUsd(x.max_cost_usd) },
            { header: "Próxima", cell: (x) => (x.next_run ? fmtDt(x.next_run) : <span class="text-muted">—</span>) },
            { header: "Última execução", cell: (x) => (x.last_request_id ? <div><StatusBadge code={x.last_status} /><div class="text-xs text-muted">{fmtDt(x.last_requested_at)}</div></div> : <span class="text-muted">Ainda não rodou</span>) },
            { header: "Ações", cell: (x) => <div class="flex gap-2">{ACTIONS.filter((a) => a.status.includes(x.status)).map((a) => <Button key={a.action} small variant={a.danger ? "danger" : "secondary"} onClick={() => act(x, a)}>{a.label}</Button>)}</div> },
          ]}
        />
      ) : null}
    </Card>
  );
}
