import { useState } from "preact/hooks";
import { go } from "../app/router";
import { Alert, EmptyState } from "../components/Alert";
import { Badge, StatusBadge } from "../components/Badge";
import { ErrorAlert, KV, Loading, SummaryGrid } from "../components/Bits";
import { Card } from "../components/Card";
import { DataTable } from "../components/DataTable";
import { PagedTable } from "../components/PagedTable";
import { PageHead } from "../components/PageHead";
import { RubricBadge } from "../components/RubricBadge";
import { FAILURE_CODES, FAILURE_STAGE, PROC_MODE, RUN_STATUS_HELP, failureText } from "../lib/executions";
import { fmtDt, fmtInt, fmtNum, fmtUsd } from "../lib/format";
import { usePagedList } from "../lib/usePagedList";
import { useAsync } from "../lib/useAsync";
import type { RunDetail as RunDetailData, RunFailureRow, RunSessionRow } from "../lib/types";
import { useSession } from "../state/session";

const SESSION_SIZES = [10, 25, 50];
const sessionHref = (id: string) => `#/sessions/${encodeURIComponent(id)}`;

/** The sessions this run analysed. Runs made since the analyses carry the run id are exact; older ones are inferred from the run's time window. */
function RunSessions({ run }: { run: RunDetailData["run"] }) {
  const { api, tenantKey } = useSession();
  const [basis, setBasis] = useState<string | undefined>();
  const list = usePagedList<RunSessionRow, { run: string }>({
    key: "runsess",
    tenantKey,
    filters: { run: run.run_id },
    sizes: SESSION_SIZES,
    size: 25,
    load: async (cursor, limit) => {
      const res = await api("runs.sessions", { run_id: run.run_id, limit, cursor });
      setBasis(res.basis);
      return res;
    },
  });
  return (
    <Card title="Sessões analisadas" flush>
      {basis === "inferred" ? (
        <p class="px-5 pb-3 text-xs text-muted">
          Esta execução é anterior ao registro da execução em cada análise. A lista foi montada pelo horário: análises do mesmo modo, rubrica e versão feitas desde o fim da execução anterior até o fim desta. Pode haver diferença em relação ao total.
        </p>
      ) : null}
      <PagedTable
        bare
        list={list}
        unit="sessões"
        noun="Sessões por página"
        caption="Sessões analisadas nesta execução"
        empty={Number(run.sessions_processed) > 0 ? "Não há como listar as sessões desta execução." : "Esta execução não analisou nenhuma sessão."}
        rowKey={(x) => x.session_id}
        onRowClick={(x) => go(sessionHref(x.session_id))}
        columns={[
          { header: "Sessão", cell: (x) => <a href={sessionHref(x.session_id)} class="font-mono text-xs" onClick={(e) => e.stopPropagation()}>{x.session_id}</a> },
          { header: "Status", cell: (x) => <StatusBadge code={x.analysis_status} /> },
          { header: "Nota", align: "right", cell: (x) => fmtNum(x.overall_score) },
          { header: "Resultado", cell: (x) => (x.approval_status ? <StatusBadge code={x.approval_status} /> : "—") },
          { header: "Modelo", cell: (x) => x.model || "—" },
          { header: "Custo", align: "right", cell: (x) => fmtUsd(x.estimated_cost_usd) },
          { header: "Quando", cell: (x) => fmtDt(x.completed_at) },
        ]}
      />
    </Card>
  );
}

function RunFailures({ runId }: { runId: string }) {
  const { api, tenantKey } = useSession();
  const list = usePagedList<RunFailureRow, { run: string }>({
    key: "runfail",
    tenantKey,
    filters: { run: runId },
    sizes: SESSION_SIZES,
    size: 25,
    load: (cursor, limit) => api("runs.failures", { run_id: runId, limit, cursor }),
  });
  return (
    <Card title="Sessões e etapas que falharam" flush>
      <PagedTable
        bare
        list={list}
        unit="falhas"
        noun="Falhas por página"
        caption="Falhas desta execução"
        empty="Nenhuma falha registrada."
        rowKey={(x) => `${x.session_id}|${x.stage}|${x.occurred_at}|${x.error_code}`}
        columns={[
          { header: "Sessão", cell: (x) => (x.session_id ? <a href={sessionHref(x.session_id)} class="font-mono text-xs">{x.session_id}</a> : <span class="text-muted">execução inteira</span>) },
          { header: "Etapa", cell: (x) => FAILURE_STAGE[x.stage] ?? x.stage },
          { header: "Causa", cell: (x) => <span class="whitespace-normal">{failureText(x.error_code)}</span> },
          { header: "Técnico", cell: (x) => <span class="font-mono text-xs text-muted">{[x.error_type, x.http_status ? `HTTP ${x.http_status}` : null, x.provider_code].filter(Boolean).join(" · ")}</span> },
          { header: "Quando", cell: (x) => fmtDt(x.occurred_at) },
        ]}
      />
    </Card>
  );
}

function RunBody({ d }: { d: RunDetailData }) {
  const { run: r, failures: f } = d;
  const failed = Number(r.sessions_failed) || 0;
  const help = RUN_STATUS_HELP[r.run_status];
  return (
    <div class="flex flex-col gap-4">
      <Card>
        <SummaryGrid>
          <KV label="Status"><StatusBadge code={r.run_status} /></KV>
          <KV label="Modo">{(r.processing_mode && PROC_MODE[r.processing_mode]) || r.processing_mode || "—"}</KV>
          <KV label="Rubrica">{r.rubric_id ? <RubricBadge rubricId={r.rubric_id} version={r.rubric_version ?? 0} /> : "—"}</KV>
          <KV label="Criada">{fmtDt(r.created_at)}</KV>
          <KV label="Terminou">{fmtDt(r.finished_at)}</KV>
          <KV label="Custo">{fmtUsd(r.actual_cost_usd)} de {fmtUsd(r.estimated_cost_usd)} estimados</KV>
        </SummaryGrid>
        <div class="mt-4 border-t border-divider pt-4">
          <SummaryGrid>
            <KV label="Sessões">{fmtInt(r.sessions_total)}</KV>
            <KV label="Analisadas">{fmtInt(r.sessions_processed)}</KV>
            <KV label="Falhas">{failed ? <Badge tone="bad">{fmtInt(failed)}</Badge> : "0"}</KV>
            <KV label="Puladas">{fmtInt(r.sessions_skipped)}</KV>
          </SummaryGrid>
        </div>
      </Card>
      {help ? <Alert tone={failed || r.run_status === "FAILED" ? "warn" : "info"}>{help}</Alert> : null}
      <RunSessions run={r} />
      {!failed && r.run_status !== "FAILED" ? (
        <Card><EmptyState icon="ok">Esta execução não teve falhas.</EmptyState></Card>
      ) : !f.available || !f.total ? (
        <Alert tone="info">
          Os detalhes das falhas desta execução não foram guardados. Isso acontece com execuções feitas antes de o registro existir. Rodar o mesmo job de novo tenta as sessões com falha outra vez e passa a registrar o motivo de cada uma.
        </Alert>
      ) : (
        <>
          <Card title="Por que falhou" flush>
            <p class="px-5 pb-3 text-muted">Causas agrupadas. O motivo é registrado como um código seguro: a plataforma não guarda o texto da conversa nem a resposta do provedor.</p>
            <DataTable
              caption="Causas das falhas"
              rows={f.by_code}
              rowKey={(c) => c.error_code}
              columns={[
                { header: "Falhas", align: "right", cell: (c) => fmtInt(c.n) },
                { header: "O que aconteceu", cell: (c) => <span class="whitespace-normal">{FAILURE_CODES[c.error_code]?.[0] ?? c.error_code} <span class="font-mono text-xs text-muted">{c.error_code}</span></span> },
                { header: "O que fazer", cell: (c) => <span class="whitespace-normal">{FAILURE_CODES[c.error_code]?.[1] || "—"}</span> },
              ]}
            />
          </Card>
          <RunFailures runId={r.run_id} />
        </>
      )}
    </div>
  );
}

export function RunDetail({ runId }: { runId: string }) {
  const { api } = useSession();
  const res = useAsync(() => api("runs.get", { run_id: runId }), [runId]);
  return (
    <>
      <PageHead title="Execução" subtitle={runId} trail={[["Execuções", "#/runs"], [runId]]} />
      {res.status === "loading" ? <Loading /> : null}
      {res.status === "error" ? <ErrorAlert message={res.message} /> : null}
      {res.status === "ready" ? <RunBody d={res.data} /> : null}
    </>
  );
}
