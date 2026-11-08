import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { go } from "../app/router";
import { EmptyState } from "../components/Alert";
import { Badge, StatusBadge } from "../components/Badge";
import { ErrorAlert, Loading } from "../components/Bits";
import { Card } from "../components/Card";
import { DataTable } from "../components/DataTable";
import { Icon } from "../components/Icon";
import { LineChart } from "../components/LineChart";
import { PageHead } from "../components/PageHead";
import { Select } from "../components/Field";
import { TabPanel, Tabs } from "../components/Tabs";
import { cx } from "../lib/cx";
import { MIN_COMPARABLE, SCORE_GRAN, SCORE_WINDOW, bestModel, kpisOf, modelEfficiency, scorePoint, type EfficiencyRow, type Kpis } from "../lib/dashboard";
import { API_LABEL } from "../lib/executions";
import { fmtDay, fmtNum, fmtPct, fmtUsd, isoDay } from "../lib/format";
import { openList } from "../lib/usePagedList";
import { useAsync } from "../lib/useAsync";
import type { DashboardSummary } from "../lib/types";
import { useSession } from "../state/session";

const PERIODS = [7, 30, 90, 180];
const grain = (g: string) => SCORE_GRAN.find(([id]) => id === g)?.[1] ?? g;

interface Doorway {
  key: string;
  hash: string;
  hint: string;
  filters: unknown;
}

/** A number on the panel. With a `doorway` it opens the list behind it, already filtered the way the number was computed (same period, same meaning). */
function Kpi({ label, value, sub, tip, doorway }: { label: string; value: string; sub?: string; tip?: string; doorway?: Doorway }) {
  const { tenantKey } = useSession();
  const inner = (
    <>
      <div class="flex items-center text-xs font-medium text-muted">{label}{doorway ? <Icon name="chevron" size="sm" class="ml-auto" /> : null}</div>
      <div class="mt-1 text-3xl font-semibold tracking-tight tabular-nums">{value}</div>
      {sub ? <div class="mt-0.5 text-xs text-faint">{sub}</div> : null}
    </>
  );
  const box = "block rounded-card border border-line bg-surface p-4 shadow-card";
  if (!doorway) return <div class={box} title={tip}>{inner}</div>;
  return (
    <a
      href={doorway.hash}
      title={doorway.hint}
      aria-label={`${label}: ${value}${sub ? `, ${sub}` : ""}. ${doorway.hint}`}
      class={cx(box, "text-fg transition-colors hover:border-primary hover:no-underline")}
      onClick={(e) => {
        e.preventDefault();
        openList(doorway.key, tenantKey, doorway.filters);
        go(doorway.hash);
      }}
    >
      {inner}
    </a>
  );
}

function Kpis6({ k, days }: { k: Kpis; days: number }) {
  const listFilters = { from: isoDay(365), to: isoDay(0), status: "", result: "", channel: "", rubric: "", query: "", analysed_from: isoDay(days), analysed_to: isoDay(0) };
  const plural = (n: number, one: string, many: string) => `${fmtNum(n, 0)} ${n === 1 ? one : many}`;
  return (
    <div class="mb-4 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
      <Kpi label="Sessões analisadas" value={fmtNum(k.covered, 0)} sub={k.total ? `de ${fmtNum(k.total, 0)} sessões do workspace (${fmtPct(k.covered / k.total)})` : "Nenhuma sessão no workspace"} doorway={{ key: "sessions", hash: "#/sessions", filters: listFilters, hint: "Ver as análises deste período, pelo dia da análise (a lista tem uma linha por sessão e rubrica)" }} />
      <Kpi label="Análises vigentes" value={fmtNum(k.current, 0)} sub={`em ${plural(k.covered, "sessão", "sessões")}${k.current > k.covered ? " (mais de uma rubrica em algumas)" : ""}`} doorway={{ key: "sessions", hash: "#/sessions", filters: listFilters, hint: "A análise mais recente de cada sessão para cada rubrica: é a base da nota média, da taxa de aprovação, da revisão e da lista de Sessões" }} />
      <Kpi label="Nota média" value={k.avgScore !== null ? fmtNum(k.avgScore) : "—"} sub={k.scored ? `de ${fmtNum(k.scored, 0)} análises pontuadas` : "Nenhuma análise pontuada"} tip={`Média ponderada das análises vigentes que receberam nota. Ficam de fora ${fmtNum(k.current - k.scored, 0)} sem nota (em revisão ou não avaliáveis).`} />
      <Kpi label="Taxa de aprovação" value={k.decided ? fmtPct(k.approved / k.decided) : "—"} sub={k.decided ? `${fmtNum(k.approved, 0)} aprovadas · ${fmtNum(k.rejected, 0)} reprovadas` : "Nenhuma análise decidida"} tip={`Aprovadas de (aprovadas + reprovadas) = ${fmtNum(k.decided, 0)} análises vigentes decididas. Ficam de fora ${fmtNum(k.inReview, 0)} em revisão e ${fmtNum(k.notEvaluable, 0)} não avaliáveis, que somam as ${fmtNum(k.current, 0)} vigentes.`} />
      <Kpi label="Em revisão" value={fmtNum(k.inReview, 0)} sub={`de ${fmtNum(k.current, 0)} análises vigentes`} doorway={{ key: "review", hash: "#/review", hint: "Ver as análises em revisão neste período (pendentes e decididas)", filters: { filter: "all", from: isoDay(days), to: isoDay(0), reason: "", rubric: "", decision: "", reviewer: "", query: "" } }} />
      <Kpi label="Custo de IA" value={fmtUsd(k.cost)} sub={`${fmtNum(k.executed, 0)} análises executadas · ${fmtNum(k.executedCurrent, 0)} vigentes`} tip="Tudo o que foi pago no período, inclusive as análises substituídas por reexecução (rubrica, modelo ou conteúdo mudou)." />
    </div>
  );
}

function ScoreCard({ days, gran, onGran }: { days: number; gran: string; onGran: (g: string) => void }) {
  const { api } = useSession();
  const res = useAsync(() => api("dashboard.score", { granularity: gran, days }), [gran, days]);
  const title = `Nota média por ${grain(gran).toLowerCase()}`;
  const points = res.status === "ready" ? res.data.rows.filter((x) => x.avg_score !== null && x.avg_score !== undefined).map((x) => scorePoint(gran, String(x.bucket), Number(x.avg_score))) : [];
  const last = points[points.length - 1];
  const windowText = gran === "day" ? `últimos ${days} dias (o período do painel)` : SCORE_WINDOW[gran];
  return (
    <Card title={title} aside={
      <div role="group" aria-label="Agrupar a nota média por" class="flex overflow-hidden rounded-control border border-line">
        {SCORE_GRAN.map(([id, label]) => (
          <button key={id} type="button" aria-pressed={id === gran} onClick={() => onGran(id)} class={cx("h-8 px-3 text-[13px] font-medium not-last:border-r not-last:border-line", id === gran ? "bg-primary-soft text-on-primary-soft" : "bg-surface text-muted hover:bg-surface-2")}>{label}</button>
        ))}
      </div>
    } class="mb-4">
      {res.status === "loading" ? <Loading /> : null}
      {res.status === "error" ? <ErrorAlert message={res.message} /> : null}
      {res.status === "ready" && !points.length ? <EmptyState icon="dashboard">Sem análises no período.</EmptyState> : null}
      {points.length ? (
        <>
          <LineChart points={points} title={title} />
          <div class="mt-2 flex flex-wrap gap-x-4 text-xs text-muted">
            <span>Nota média das sessões pontuadas (0 a 100), ponderada pelo número de sessões · {windowText}{gran === "week" ? " · semanas começam na segunda" : ""}</span>
            {last?.partial ? <span>O último ponto ainda está em andamento.</span> : null}
          </div>
        </>
      ) : null}
    </Card>
  );
}

function Efficiency({ models }: { models: DashboardSummary["models"] }) {
  const rows = modelEfficiency(models);
  const best = bestModel(rows);
  const worst = rows.reduce((m, r) => (r.perDone !== null && r.perDone > m ? r.perDone : m), 0);
  const anySmall = rows.some((r) => r.n < MIN_COMPARABLE);
  const tot = rows.reduce((t, r) => ({ n: t.n + r.n, cur: t.cur + r.cur, cost: t.cost + r.cost, done: t.done + r.done }), { n: 0, cur: 0, cost: 0, done: 0 });
  if (!rows.length) return <Card title="Eficiência por API e modelo"><EmptyState icon="dashboard">Sem análises com custo no período.</EmptyState></Card>;
  return (
    <Card title="Eficiência por API e modelo" flush>
      <DataTable<EfficiencyRow>
        caption="Eficiência por API e modelo"
        rows={rows}
        rowKey={(r) => `${r.provider}|${r.model}`}
        columns={[
          { header: "API", cell: (r) => API_LABEL[r.provider] ?? "—" },
          { header: "Modelo", cell: (r) => <span class="flex flex-wrap items-center gap-2"><span class="font-mono text-xs">{r.model || "—"}</span>{r === best ? <Badge tone="ok">Mais econômico</Badge> : null}{r.n < MIN_COMPARABLE ? <span title={`Menos de ${MIN_COMPARABLE} análises: a média diz pouco`}><Badge>Amostra pequena</Badge></span> : null}</span> },
          { header: "Executadas", align: "right", cell: (r) => fmtNum(r.n, 0) },
          { header: "Vigentes", align: "right", cell: (r) => fmtNum(r.cur, 0) },
          { header: "Custo total", align: "right", cell: (r) => fmtUsd(r.cost) },
          { header: "Custo por executada", align: "right", cell: (r) => fmtUsd(r.perAnalysis) },
          { header: "Concluídas", align: "right", cell: (r) => `${fmtNum(r.done, 0)} (${fmtPct(r.share)})` },
          {
            header: "Custo por concluída",
            align: "right",
            cell: (r) => (
              <span class="inline-flex items-center justify-end gap-2">
                {fmtUsd(r.perDone)}
                {r.perDone !== null && worst ? <span aria-hidden="true" title="Custo por concluída relativo ao modelo mais caro (menor é melhor)" class="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-surface-2"><i class="block h-full bg-primary" style={{ width: `${Math.max(3, Math.round((r.perDone / worst) * 100))}%` }} /></span> : null}
              </span>
            ),
          },
        ]}
        foot={
          <tr>
            <td class="px-4 py-2">Total</td><td />
            <td class="px-4 py-2 text-right tabular-nums">{fmtNum(tot.n, 0)}</td>
            <td class="px-4 py-2 text-right tabular-nums">{fmtNum(tot.cur, 0)}</td>
            <td class="px-4 py-2 text-right tabular-nums">{fmtUsd(tot.cost)}</td>
            <td class="px-4 py-2 text-right tabular-nums">{tot.n ? fmtUsd(tot.cost / tot.n) : "—"}</td>
            <td class="px-4 py-2 text-right tabular-nums">{fmtNum(tot.done, 0)}{tot.n ? ` (${fmtPct(tot.done / tot.n)})` : ""}</td>
            <td class="px-4 py-2 text-right tabular-nums">{tot.done ? fmtUsd(tot.cost / tot.done) : "—"}</td>
          </tr>
        }
      />
      <ul class="space-y-1 px-5 pt-4 pb-2 text-xs text-muted">
        <li><strong>Executadas</strong> Toda análise que rodou e foi paga, inclusive as substituídas por reexecução.</li>
        <li><strong>Vigentes</strong> A mais recente de cada sessão e rubrica (o que as notas e a lista de Sessões usam).</li>
        <li><strong>Custo por concluída</strong> Custo total ÷ análises concluídas: inclui o que foi gasto nas que não geraram resultado (não avaliáveis, em revisão ou com falha).</li>
        <li><strong>Barra</strong> A barra compara esse custo com o do modelo mais caro: quanto menor, mais econômico.</li>
        <li><strong>API</strong> Vem da lista de modelos permitidos.</li>
      </ul>
      <p class="px-5 pb-5 text-xs text-muted">
        Custo não é qualidade: um modelo mais barato pode concluir menos ou errar mais. Compare também as notas e as revisões.
        {anySmall ? ` Com menos de ${MIN_COMPARABLE} análises por modelo a comparação ainda não é confiável; o selo “Mais econômico” só aparece quando há dois modelos com amostra suficiente.` : ""}
      </p>
    </Card>
  );
}

const DETAIL_TABS = [{ id: "eff", label: "Eficiência por API e modelo" }, { id: "cost", label: "Custo por dia e modelo" }, { id: "runs", label: "Saúde das execuções" }];

function Body({ d, days, gran, onGran, tab, setTab }: { d: DashboardSummary; days: number; gran: string; onGran: (g: string) => void; tab: string; setTab: (t: string) => void }) {
  const k = kpisOf(d);
  const cost = d.cost.slice().reverse().slice(0, 30);
  const runs = d.runs.slice().reverse().slice(0, 30);
  let detail: ComponentChildren;
  if (tab === "eff") detail = <Efficiency models={d.models ?? []} />;
  else if (tab === "cost")
    detail = (
      <Card title="Custo por dia e modelo" flush>
        {cost.length ? (
          <DataTable
            caption="Custo por dia e modelo"
            rows={cost}
            rowKey={(r) => `${r.day}|${r.analysis_mode}|${r.model}`}
            columns={[
              { header: "Dia", cell: (r) => fmtDay(r.day) },
              { header: "Modo", cell: (r) => r.analysis_mode },
              { header: "Modelo", cell: (r) => r.model },
              { header: "Executadas", align: "right", cell: (r) => fmtNum(r.analyses, 0) },
              { header: "Custo", align: "right", cell: (r) => fmtUsd(r.cost_usd) },
              { header: "Duração média", align: "right", cell: (r) => (r.avg_duration_ms === null ? "—" : `${fmtNum(r.avg_duration_ms, 0)} ms`) },
            ]}
          />
        ) : <EmptyState icon="gauge">Sem custo registrado.</EmptyState>}
      </Card>
    );
  else
    detail = (
      <Card title="Saúde das execuções" flush>
        {runs.length ? (
          <DataTable
            caption="Saúde das execuções"
            rows={runs}
            rowKey={(r) => `${r.day}|${r.processing_mode}|${r.run_status}`}
            columns={[
              { header: "Dia", cell: (r) => fmtDay(r.day) },
              { header: "Modo", cell: (r) => r.processing_mode },
              { header: "Status", cell: (r) => <StatusBadge code={r.run_status} /> },
              { header: "Execuções", align: "right", cell: (r) => r.runs },
              { header: "Processadas", align: "right", cell: (r) => r.sessions_processed },
              { header: "Falhas", align: "right", cell: (r) => r.sessions_failed },
              { header: "Custo", align: "right", cell: (r) => fmtUsd(r.actual_cost_usd) },
            ]}
          />
        ) : <EmptyState icon="runs">Sem execuções.</EmptyState>}
      </Card>
    );
  return (
    <>
      <Kpis6 k={k} days={days} />
      <ScoreCard days={days} gran={gran} onGran={onGran} />
      <Tabs label="Detalhes de custo e execuções" idPrefix="dash" items={DETAIL_TABS} value={tab} onChange={setTab} />
      <div class="pt-4">
        <TabPanel idPrefix="dash" id={tab} active>{detail}</TabPanel>
      </div>
    </>
  );
}

export function DashboardView() {
  const { api } = useSession();
  const [days, setDays] = useState(30);
  // The grain of the score chart and the tab of the detail cards are kept when the period changes (the body is redrawn while the new numbers load).
  const [gran, setGran] = useState("day");
  const [tab, setTab] = useState("eff");
  const res = useAsync(() => api("dashboard.summary", { days }), [days]);
  return (
    <>
      <PageHead
        title="Painel"
        subtitle="Qualidade, custo e saúde do processamento · período pelo dia da análise"
        actions={<Select aria-label="Período" class="!w-44" value={days} onChange={(e) => setDays(Number(e.currentTarget.value))}>{PERIODS.map((n) => <option key={n} value={n} selected={n === days}>Últimos {n} dias</option>)}</Select>}
      />
      {res.status === "loading" ? <Loading /> : null}
      {res.status === "error" ? <ErrorAlert message={res.message} /> : null}
      {res.status === "ready" ? <Body d={res.data} days={days} gran={gran} onGran={setGran} tab={tab} setTab={setTab} /> : null}
    </>
  );
}
