import { useEffect, useState } from "preact/hooks";
import { go } from "../app/router";
import { Alert, EmptyState } from "../components/Alert";
import { StatusBadge, STATUS } from "../components/Badge";
import { ErrorAlert, KV, Loading, SummaryGrid } from "../components/Bits";
import { Card } from "../components/Card";
import { DataTable } from "../components/DataTable";
import { Field, Input, Select } from "../components/Field";
import { FilterBar } from "../components/FilterBar";
import { PageHead } from "../components/PageHead";
import { Pager } from "../components/Pager";
import { useToast } from "../components/Toasts";
import { fmtDt, isoDay } from "../lib/format";
import { readPaging, usePagedList } from "../lib/usePagedList";
import { useAsync } from "../lib/useAsync";
import type { AuditEvent, AuditFacets, AuditFilters } from "../lib/types";
import { useSession } from "../state/session";

/** What each recorded action means, in words. The code stays visible next to it: it is what the logs and the data use. */
export const AUDIT_ACTION: Record<string, string> = {
  "session.view": "Conteúdo de uma conversa visualizado", "rubrics.createDraft": "Rascunho de rubrica criado", "rubrics.saveDraft": "Rascunho de rubrica salvo",
  "rubrics.deleteDraft": "Rascunho de rubrica descartado", "rubrics.publish": "Rubrica publicada", "users.upsert": "Acesso de usuário alterado",
  "review.decide": "Decisão de revisão registrada", "executions.request": "Execução pedida", "executions.cancel": "Pedido de execução cancelado",
  "user.bootstrap_admin": "Administrador inicial criado",
};
const AUDIT_KEY: Record<string, string> = {
  rubric_id: "Rubrica", version: "Versão", criteria: "Critérios", issues: "Pendências", etag: "Versão do rascunho (etag)", cloned_from: "Criada a partir da versão",
  session_id: "Sessão", analysis_id: "Análise", decision: "Decisão", has_comment: "Teve comentário", target: "Usuário alterado", role: "Perfil", status: "Status",
  kind: "Tipo", max_cost_usd: "Teto de custo (US$)", estimate_high_usd: "Estimativa máxima (US$)", request_id: "Pedido", start: "De", end: "Até", only_routed: "Somente roteadas",
};

export function auditValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Sim" : "Não";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function parseDetails(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Where the target of an event leads, when there is a page for it (never invents one). */
function Target({ e, det }: { e: AuditEvent; det: Record<string, unknown> | null }) {
  if (!e.entity_id) return <>—</>;
  const label = `${e.entity_type ? `${e.entity_type} ` : ""}${e.entity_id}`;
  if (e.entity_type === "session") return <a href={`#/sessions/${encodeURIComponent(e.entity_id)}`}>{label}</a>;
  if (e.entity_type === "rubrics" && det && typeof det.version === "number") return <a href={`#/rubrics/${encodeURIComponent(e.entity_id)}/${det.version}`}>{`${label} v${det.version}`}</a>;
  return <>{label}</>;
}

function AuditDetail({ eventId }: { eventId: string }) {
  const { api } = useSession();
  const res = useAsync(() => api("audit.get", { event_id: eventId }), [eventId]);
  return (
    <>
      <PageHead title="Evento de auditoria" subtitle={eventId} trail={[["Auditoria", "#/audit"], [eventId]]} />
      {res.status === "loading" ? <Loading /> : null}
      {res.status === "error" ? <ErrorAlert message={res.message} /> : null}
      {res.status === "ready" ? <AuditDetailBody e={res.data} /> : null}
    </>
  );
}

function AuditDetailBody({ e }: { e: AuditEvent }) {
  const det = parseDetails(e.details);
  const keys = det ? Object.keys(det) : [];
  return (
    <div class="flex flex-col gap-4">
      <Card>
        <SummaryGrid>
          <KV label="Quando">{fmtDt(e.occurred_at)}</KV>
          <KV label="Quem">{e.actor_email || "—"}</KV>
          <KV label="Resultado"><StatusBadge code={e.outcome} /></KV>
          <KV label="Ação">{AUDIT_ACTION[e.action] ?? e.action}</KV>
          <KV label="Código da ação"><span class="font-mono text-xs">{e.action}</span></KV>
          <KV label="Alvo"><Target e={e} det={det} /></KV>
          <KV label="ID do evento"><span class="font-mono text-xs">{e.event_id}</span></KV>
          <KV label="ID da requisição">{e.request_id ? <span class="font-mono text-xs">{e.request_id}</span> : "—"}</KV>
        </SummaryGrid>
      </Card>
      {e.outcome === "DENIED" ? <Alert tone="warn">Esta tentativa foi negada: a pessoa não tinha permissão para a ação. Nada foi alterado.</Alert> : null}
      <Card title="Detalhes">
        {det && keys.length ? (
          <>
            <p class="mb-3 text-muted">Só metadados: a auditoria nunca guarda o texto das conversas nem comentários.</p>
            <DataTable
              columns={[
                { header: "Campo", cell: (k: string) => <span>{AUDIT_KEY[k] ?? k} {AUDIT_KEY[k] ? <span class="font-mono text-xs text-muted">{k}</span> : null}</span> },
                { header: "Valor", cell: (k: string) => auditValue(det[k]) },
              ]}
              rows={keys}
              rowKey={(k) => k}
            />
            <details class="mt-3">
              <summary class="cursor-pointer text-primary">Ver JSON bruto</summary>
              <pre class="mt-2 overflow-x-auto rounded-control bg-surface-2 p-3 font-mono text-xs">{JSON.stringify(det, null, 2)}</pre>
            </details>
          </>
        ) : (
          <EmptyState icon="audit">Este evento não tem detalhes adicionais.</EmptyState>
        )}
      </Card>
    </div>
  );
}

const defaults = (): AuditFilters => ({ from: isoDay(29), to: isoDay(0), actor: "", action: "", outcome: "", entity: "" });
const sameFilters = (a: AuditFilters, b: AuditFilters) => (Object.keys(a) as Array<keyof AuditFilters>).every((k) => a[k] === b[k]);

function AuditList() {
  const { api, tenantKey } = useSession();
  const toast = useToast();
  const [initial] = useState(() => readPaging<AuditFilters>("audit", tenantKey));
  // `draft` is what the fields show while typing; `applied` is what "Buscar" committed and what the list is loaded with.
  const [draft, setDraft] = useState<AuditFilters>(() => ({ ...defaults(), ...(initial?.filters ?? {}) }));
  const [applied, setApplied] = useState<AuditFilters>(draft);
  const [facets, setFacets] = useState<AuditFacets>({ actors: [], actions: [], outcomes: [] });
  const set = <K extends keyof AuditFilters>(k: K, v: AuditFilters[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const loadFacets = (from: string, to: string) => {
    // Options come from what is recorded in the period, so no option returns an empty list. Without them the filters keep working.
    api("audit.facets", { from, to }).then(setFacets, () => undefined);
  };
  useEffect(() => loadFacets(applied.from, applied.to), []); // eslint-disable-line react-hooks/exhaustive-deps

  const list = usePagedList<AuditEvent, AuditFilters>({
    key: "audit",
    tenantKey,
    filters: applied,
    restore: initial,
    load: (cursor, limit) => api("audit.list", { ...applied, limit, cursor }),
    count: () => api("audit.count", applied),
    onCountError: (e) => toast(e instanceof Error ? e.message : "Não foi possível contar.", true),
  });

  const filtered = !sameFilters(applied, defaults());
  const withKept = (values: string[], keep: string) => (keep && !values.includes(keep) ? [...values, keep] : values);
  return (
    <>
      <PageHead title="Auditoria" subtitle="Alterações de configuração e acessos a conteúdo de conversas (somente metadados). Clique num evento para ver os detalhes." />
      <FilterBar
        dirty={!sameFilters(draft, defaults())}
        onSubmit={() => {
          loadFacets(draft.from, draft.to);
          setApplied(draft);
        }}
        onClear={() => {
          const d = defaults();
          setDraft(d);
          setApplied(d);
          loadFacets(d.from, d.to);
        }}
      >
        <Field label="De"><Input type="date" value={draft.from} onChange={(e) => set("from", e.currentTarget.value)} /></Field>
        <Field label="Até"><Input type="date" value={draft.to} onChange={(e) => set("to", e.currentTarget.value)} /></Field>
        <Field label="Quem">
          <Select value={draft.actor} onChange={(e) => set("actor", e.currentTarget.value)}>
            <option value="">Todos</option>
            {withKept(facets.actors, draft.actor).map((x) => <option key={x} value={x} selected={x === draft.actor}>{x}</option>)}
          </Select>
        </Field>
        <Field label="Ação">
          <Select value={draft.action} onChange={(e) => set("action", e.currentTarget.value)}>
            <option value="">Todas</option>
            {withKept(facets.actions, draft.action).map((x) => <option key={x} value={x} selected={x === draft.action}>{AUDIT_ACTION[x] ? `${AUDIT_ACTION[x]} (${x})` : x}</option>)}
          </Select>
        </Field>
        <Field label="Resultado">
          <Select value={draft.outcome} onChange={(e) => set("outcome", e.currentTarget.value)}>
            <option value="">Todos</option>
            {withKept(facets.outcomes, draft.outcome).map((x) => <option key={x} value={x} selected={x === draft.outcome}>{STATUS[x]?.[0] ?? x}</option>)}
          </Select>
        </Field>
        <Field label="Alvo"><Input type="search" placeholder="ID exato" maxLength={128} value={draft.entity} onInput={(e) => set("entity", e.currentTarget.value.trim())} /></Field>
      </FilterBar>
      <Card flush>
        {list.status === "error" ? <div class="p-4"><ErrorAlert message={list.error ?? ""} /></div> : null}
        {list.status === "loading" && !list.rows.length ? <Loading /> : null}
        {list.status !== "error" && list.status === "ready" && !list.rows.length ? <EmptyState icon="audit">{filtered ? "Nenhum evento com estes filtros." : "Sem eventos no período."}</EmptyState> : null}
        {list.rows.length ? (
          <DataTable
            caption="Eventos de auditoria"
            rows={list.rows}
            rowKey={(r) => r.event_id}
            onRowClick={(r) => go(`#/audit/${encodeURIComponent(r.event_id)}`)}
            columns={[
              { header: "Quando", cell: (r) => fmtDt(r.occurred_at) },
              { header: "Quem", cell: (r) => r.actor_email },
              { header: "Ação", cell: (r) => <span class="font-mono text-xs">{r.action}</span> },
              { header: "Alvo", cell: (r) => (r.entity_id ? `${r.entity_type ?? ""} ${r.entity_id}` : "—") },
              { header: "Resultado", cell: (r) => <StatusBadge code={r.outcome} /> },
            ]}
          />
        ) : null}
        <Pager list={list} unit="eventos" />
      </Card>
    </>
  );
}

export function AuditView({ parts }: { parts: string[] }) {
  const id = parts[0];
  return id ? <AuditDetail eventId={decodeURIComponent(id)} /> : <AuditList />;
}
