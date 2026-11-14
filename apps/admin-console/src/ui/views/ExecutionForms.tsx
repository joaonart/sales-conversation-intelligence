import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Alert } from "../components/Alert";
import { cx } from "../lib/cx";
import { Button } from "../components/Button";
import { Field, Input, Select } from "../components/Field";
import { Modal, useConfirm } from "../components/Modal";
import { Switch } from "../components/Switch";
import { useToast } from "../components/Toasts";
import { API_LABEL, EXEC_HELP, EXEC_KIND, WEEKDAYS, utcTime } from "../lib/executions";
import { fmtInt, fmtUsd, isoDay } from "../lib/format";
import type { ExecPreview, ModelCatalog, RubricRow } from "../lib/types";
import { useModelCatalog, usePublishedRubrics } from "../lib/useExecutionRefs";
import { useSession } from "../state/session";

const grid = "grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4";
const rubricKey = (r: RubricRow) => `${r.rubric_id}@${r.version}`;
const parseRubric = (v: string): { rubric_id: string; rubric_version: number } => {
  const [id = "", ver = ""] = v.split("@");
  return { rubric_id: id, rubric_version: Number(ver) };
};
const pad2 = (n: number) => (n < 10 ? "0" : "") + n;

function RubricSelect({ rubrics, value, onChange }: { rubrics: RubricRow[]; value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Rubrica publicada">
      <Select aria-label="Rubrica publicada" value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        {rubrics.length ? rubrics.map((r) => <option key={rubricKey(r)} value={rubricKey(r)} selected={rubricKey(r) === value}>{r.rubric_id} v{r.version}</option>) : <option value="">Nenhuma publicada</option>}
      </Select>
    </Field>
  );
}

function ModelFields({ catalog, provider, model, onChange }: { catalog: ModelCatalog; provider: string; model: string; onChange: (provider: string, model: string) => void }) {
  const ofProvider = (p: string) => catalog.models.filter((m) => m.provider === p);
  return (
    <>
      <Field label="API">
        <Select aria-label="API" value={provider} onChange={(e) => onChange(e.currentTarget.value, ofProvider(e.currentTarget.value)[0]?.model ?? "")}>
          {Object.keys(API_LABEL).map((k) => <option key={k} value={k} selected={k === provider}>{API_LABEL[k]} API</option>)}
        </Select>
      </Field>
      <Field label="Modelo">
        <Select aria-label="Modelo" value={model} onChange={(e) => onChange(provider, e.currentTarget.value)}>
          {ofProvider(provider).map((m) => <option key={m.model} value={m.model} selected={m.model === model}>{m.model + (m.validated ? "" : " (não validado)")}</option>)}
        </Select>
      </Field>
    </>
  );
}

function PriceNote({ catalog, provider, model }: { catalog: ModelCatalog; provider: string; model: string }) {
  const m = catalog.models.find((x) => x.provider === provider && x.model === model);
  if (!m) return null;
  return (
    <p class="mt-3 text-xs text-muted">
      {m.model}: {fmtUsd(m.input_per_million)} por 1M tokens de entrada e {fmtUsd(m.output_per_million)} de saída (pior caso{m.verified_on ? `, conferido em ${m.verified_on}` : ""}). A estimativa usa estes preços.
      {m.validated ? null : <strong> Ainda não validado: a primeira execução real é o teste, limitada pelo teto.</strong>}
    </p>
  );
}

function NumField({ label, value, min, step, onChange }: { label: string; value: number; min: number; step: number; onChange: (n: number) => void }) {
  return (
    <Field label={label}>
      <Input type="number" min={min} step={step} value={value} onChange={(e) => onChange(Number(e.currentTarget.value))} />
    </Field>
  );
}

function PreviewBox({ p, extra, okWhen }: { p: ExecPreview; extra?: ComponentChildren; okWhen: boolean }) {
  return (
    <Alert tone={okWhen ? "info" : "warn"} class="mt-4">
      <div class="text-xs text-muted">{p.model} · {API_LABEL[p.provider] ?? p.provider} API</div>
      <div><strong>{fmtInt(p.to_process)} sessões a processar</strong> · {fmtInt(p.sessions)} na janela · {fmtInt(p.already)} já feitas · ~{fmtInt(p.approx_input_tokens)} tokens</div>
      <div>Estimativa: {fmtUsd(p.estimate_low_usd)} (mínimo) a {fmtUsd(p.estimate_high_usd)} (pior caso) · teto {fmtUsd(p.max_cost_usd)}</div>
      {p.within_ceiling ? null : <div>O teto está abaixo do pior caso: aumente o teto ou reduza a janela.</div>}
      {extra}
      {p.notes.map((n) => <div key={n} class="text-xs text-muted">{n}</div>)}
    </Alert>
  );
}

type Kind = "ROUTING" | "ANALYSIS" | "SESSION_ANALYSIS";
export type When = "now" | "repeat";

const WHEN: Array<[When, string]> = [["now", "Agora"], ["repeat", "Repetir"]];

/**
 * Nova execução, uma vez (um pedido) ou repetida (uma agenda). The console never runs a job and never holds the AI key: it estimates (read-only) and records
 * a request with a cost ceiling. A schedule is a standing instruction that never runs or spends by itself: at the hour, the executor turns it into an
 * ordinary request in the name of whoever created it, and that request passes every gate again (active ADMIN, its cost ceiling, the executor's monthly
 * budget, the AI gate). A schedule can only repeat an analysis by rubric, so "Repetir" fixes the type.
 */
export function ExecutionForm({ initialWhen = "now", onClose, onRequested, onScheduled }: { initialWhen?: When; onClose: () => void; onRequested: () => void; onScheduled: () => void }) {
  const { api } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const published = usePublishedRubrics();
  const catalog = useModelCatalog();
  const [when, setWhen] = useState<When>(initialWhen);
  const [st, setSt] = useState({
    kind: "ROUTING" as Kind, start: isoDay(29), end: isoDay(0), max_sessions: 200, max_cost_usd: 0.05, rubric: "", session_id: "", only_routed: false, provider: "", model: "",
    name: "", frequency: "DAILY", weekday: 0, hour_utc: 2, minute_utc: 0, window_days: 7,
  });
  const [preview, setPreview] = useState<ExecPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const repeat = when === "repeat";
  const kind: Kind = repeat ? "ANALYSIS" : st.kind;
  // Any change of the request makes the old estimate stale.
  const change = (patch: Partial<typeof st>) => {
    setSt((s) => ({ ...s, ...patch }));
    setPreview(null);
  };
  const changeWhen = (w: When) => {
    setWhen(w);
    setPreview(null);
  };
  useEffect(() => {
    if (catalog.settled) setSt((s) => (s.provider ? s : { ...s, provider: catalog.default.provider, model: catalog.default.model }));
  }, [catalog]);
  useEffect(() => {
    const first = published[0];
    if (first) setSt((s) => (s.rubric ? s : { ...s, rubric: rubricKey(first) }));
  }, [published]);

  const requestBody = () => {
    const b: Record<string, unknown> = { kind, max_cost_usd: st.max_cost_usd, provider: st.provider, model: st.model };
    if (kind === "SESSION_ANALYSIS") b.session_id = st.session_id.trim();
    else Object.assign(b, { start: st.start, end: st.end, max_sessions: st.max_sessions });
    if (kind !== "ROUTING") Object.assign(b, parseRubric(st.rubric));
    if (kind === "ANALYSIS") b.only_routed = st.only_routed;
    return b;
  };
  const scheduleBody = () => {
    const b: Record<string, unknown> = {
      name: st.name.trim(), frequency: st.frequency, hour_utc: st.hour_utc, minute_utc: st.minute_utc, window_days: st.window_days, max_sessions: st.max_sessions,
      ...parseRubric(st.rubric), only_routed: st.only_routed, provider: st.provider, model: st.model, max_cost_usd: st.max_cost_usd,
    };
    if (st.frequency === "WEEKLY") b.weekday = st.weekday;
    return b;
  };
  // The estimate of a schedule is the one of a request made by hand over the window as it would run today.
  const previewBody = () => {
    if (!repeat) return requestBody();
    const end = new Date();
    const start = new Date(end.getTime() - st.window_days * 864e5);
    const b = scheduleBody();
    return { kind: "ANALYSIS", start: isoDay(0, start), end: isoDay(0, end), max_sessions: b.max_sessions, rubric_id: b.rubric_id, rubric_version: b.rubric_version, only_routed: b.only_routed, provider: b.provider, model: b.model, max_cost_usd: b.max_cost_usd };
  };
  const ready = !busy && st.model !== "" && (repeat
    ? st.name.trim() !== "" && st.rubric !== ""
    : (kind === "SESSION_ANALYSIS" ? st.session_id.trim() !== "" : Boolean(st.start && st.end)) && (kind === "ROUTING" || st.rubric !== ""));
  // A schedule with nothing to process today is still fine to create (the next runs pay only what arrives); a request with nothing to process is not.
  const canSubmit = !!preview && (repeat ? preview.within_ceiling || preview.to_process === 0 : preview.within_ceiling && preview.to_process > 0);

  const estimate = async () => {
    setBusy(true);
    try {
      setPreview(await api("executions.preview", previewBody()));
    } catch (e) {
      setPreview(null);
      toast(e instanceof Error ? e.message : "Não foi possível estimar.", true);
    }
    setBusy(false);
  };

  const submit = async () => {
    const p = preview;
    if (!p) return;
    const yes = await confirm(
      repeat
        ? {
            title: "Criar agenda",
            okLabel: "Criar agenda",
            body: (
              <>
                <p class="mb-2">Esta agenda vai pedir uma execução <strong>{st.frequency === "WEEKLY" ? `toda ${WEEKDAYS[st.weekday]}` : "todo dia"}</strong> às {utcTime(st.hour_utc, st.minute_utc)}.</p>
                <p class="mb-2">Você autoriza gastar até <strong>{fmtUsd(st.max_cost_usd)}</strong> em chamadas à IA <strong>em cada execução</strong>, enquanto a agenda estiver ativa.</p>
                <ul class="mb-2 list-disc pl-5">
                  <li>Modelo: {p.model} ({API_LABEL[p.provider] ?? p.provider} API)</li>
                  <li>Cada execução olha os últimos {st.window_days} dias e processa só as sessões novas ou alteradas</li>
                  <li>Hoje isso seriam {fmtInt(p.to_process)} sessões, de {fmtUsd(p.estimate_low_usd)} a {fmtUsd(p.estimate_high_usd)}</li>
                </ul>
                <p class="text-muted">Cada execução fica registrada com o seu nome e passa de novo pelo teto do pedido, pelo teto mensal de IA do worker sob demanda e pelo portão de IA. Pausar ou arquivar vale a partir do próximo horário.</p>
              </>
            ),
          }
        : {
            title: `Pedir execução: ${EXEC_KIND[kind]}`,
            okLabel: "Pedir execução",
            body: (
              <>
                <p class="mb-2">Você autoriza gastar até <strong>{fmtUsd(st.max_cost_usd)}</strong> em chamadas à IA nesta execução.</p>
                <ul class="mb-2 list-disc pl-5">
                  <li>Modelo: {p.model} ({API_LABEL[p.provider] ?? p.provider} API)</li>
                  <li>{fmtInt(p.to_process)} sessões a processar (de {fmtInt(p.sessions)} na janela)</li>
                  <li>Estimativa: {fmtUsd(p.estimate_low_usd)} a {fmtUsd(p.estimate_high_usd)}</li>
                </ul>
                <p class="text-muted">O pedido fica registrado com o seu nome. Quem executa confere o teto de novo antes de chamar a IA e para se ele for ultrapassado.</p>
              </>
            ),
          },
    );
    if (!yes) return;
    setBusy(true);
    try {
      if (repeat) {
        await api("schedules.create", { ...scheduleBody(), confirm: true });
        toast("Agenda criada.");
      } else {
        await api("executions.request", { ...requestBody(), confirm: true });
        toast("Execução pedida. Ela fica aguardando o worker sob demanda.");
      }
      setPreview(null);
      onClose();
      (repeat ? onScheduled : onRequested)();
    } catch (e) {
      toast(e instanceof Error ? e.message : repeat ? "Não foi possível criar a agenda." : "Não foi possível pedir a execução.", true);
    }
    setBusy(false);
  };

  const hours = Array.from({ length: 24 }, (_, k) => k);
  return (
    <Modal
      title="Nova execução"
      wide
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button disabled={!ready} onClick={estimate}>{busy ? "Calculando…" : "Estimar custo"}</Button>
          {canSubmit ? <Button variant="primary" disabled={busy} onClick={submit}>{repeat ? "Criar agenda…" : "Pedir execução…"}</Button> : null}
        </>
      }
    >
      <div>
        <div class="mb-3 flex flex-wrap items-center gap-3">
          <span class="text-xs font-medium text-muted">Quando</span>
          <div role="group" aria-label="Quando" class="flex overflow-hidden rounded-control border border-line">
            {WHEN.map(([w, label]) => (
              <button key={w} type="button" data-autofocus={when === w ? "" : undefined} aria-pressed={when === w} onClick={() => changeWhen(w)} class={cx("h-8 px-4 text-[13px] font-medium not-last:border-r not-last:border-line", when === w ? "bg-primary-soft text-on-primary-soft" : "bg-surface text-muted hover:bg-surface-2")}>{label}</button>
            ))}
          </div>
          <span class="text-xs text-muted">{repeat ? "Uma agenda pede a execução sozinha, no horário escolhido." : "Um pedido roda uma vez, quando o worker sob demanda o pegar."}</span>
        </div>
        <p class="mb-3 text-muted">
          {repeat
            ? "No horário escolhido, o worker sob demanda pede uma análise da rubrica sobre os últimos N dias. O conteúdo já analisado é pulado, então cada execução só paga as sessões novas ou alteradas. A agenda nunca gasta por conta própria: cada execução passa de novo pelo teto, pelo teto mensal de IA e pelo portão de IA."
            : EXEC_HELP[kind]}
        </p>
        <div class={grid}>
          {repeat ? <Field label="Nome"><Input maxLength={80} placeholder="ex.: Vendas, todo dia" value={st.name} onInput={(e) => change({ name: e.currentTarget.value })} /></Field> : null}
          <Field label="Tipo">
            <Select aria-label="Tipo de execução" disabled={repeat} title={repeat ? "Uma agenda só repete a análise por rubrica" : undefined} value={kind} onChange={(e) => change({ kind: e.currentTarget.value as Kind })}>
              {Object.keys(EXEC_KIND).map((k) => <option key={k} value={k} selected={k === kind}>{EXEC_KIND[k]}</option>)}
            </Select>
          </Field>
          {repeat ? (
            <>
              <Field label="Frequência">
                <Select aria-label="Frequência" value={st.frequency} onChange={(e) => change({ frequency: e.currentTarget.value })}>
                  <option value="DAILY" selected={st.frequency === "DAILY"}>Todo dia</option>
                  <option value="WEEKLY" selected={st.frequency === "WEEKLY"}>Toda semana</option>
                </Select>
              </Field>
              {st.frequency === "WEEKLY" ? (
                <Field label="Dia da semana">
                  <Select aria-label="Dia da semana" value={st.weekday} onChange={(e) => change({ weekday: Number(e.currentTarget.value) })}>
                    {WEEKDAYS.map((d, i) => <option key={d} value={i} selected={i === st.weekday}>{d}</option>)}
                  </Select>
                </Field>
              ) : null}
              <Field label="Hora (UTC)">
                <Select aria-label="Hora (UTC)" value={st.hour_utc} onChange={(e) => change({ hour_utc: Number(e.currentTarget.value) })}>
                  {hours.map((k) => <option key={k} value={k} selected={k === st.hour_utc}>{pad2(k)}</option>)}
                </Select>
              </Field>
              <Field label="Minuto">
                <Select aria-label="Minuto" value={st.minute_utc} onChange={(e) => change({ minute_utc: Number(e.currentTarget.value) })}>
                  {[0, 15, 30, 45].map((k) => <option key={k} value={k} selected={k === st.minute_utc}>{pad2(k)}</option>)}
                </Select>
              </Field>
            </>
          ) : null}
          {kind !== "ROUTING" ? <RubricSelect rubrics={published} value={st.rubric} onChange={(v) => change({ rubric: v })} /> : null}
          <ModelFields catalog={catalog} provider={st.provider} model={st.model} onChange={(provider, model) => change({ provider, model })} />
          {repeat ? (
            <>
              <NumField label="Janela (últimos N dias)" value={st.window_days} min={1} step={1} onChange={(n) => change({ window_days: n })} />
              <NumField label="Limite de sessões por execução" value={st.max_sessions} min={1} step={1} onChange={(n) => change({ max_sessions: n })} />
            </>
          ) : kind === "SESSION_ANALYSIS" ? (
            <Field label="ID da sessão"><Input maxLength={128} placeholder="ex.: s0151" value={st.session_id} onInput={(e) => change({ session_id: e.currentTarget.value })} /></Field>
          ) : (
            <>
              <NumField label="Limite de sessões" value={st.max_sessions} min={1} step={1} onChange={(n) => change({ max_sessions: n })} />
              <Field label="De"><Input type="date" value={st.start} onChange={(e) => change({ start: e.currentTarget.value })} /></Field>
              <Field label="Até"><Input type="date" value={st.end} onChange={(e) => change({ end: e.currentTarget.value })} /></Field>
            </>
          )}
          <NumField label={repeat ? "Teto de custo por execução (US$)" : "Teto de custo (US$)"} value={st.max_cost_usd} min={0.000001} step={0.01} onChange={(n) => change({ max_cost_usd: n })} />
        </div>
        <PriceNote catalog={catalog} provider={st.provider} model={st.model} />
        {repeat ? <p class="mt-3 text-xs text-muted">O horário é em UTC. Brasília é UTC−3: 02:00 UTC são 23:00 do dia anterior.</p> : null}
        {kind === "ANALYSIS" ? <div class="mt-3"><Switch label="Somente sessões roteadas para esta rubrica" checked={st.only_routed} onChange={(v) => change({ only_routed: v })} /></div> : null}
        {preview ? (
          <PreviewBox
            p={preview}
            okWhen={repeat ? preview.within_ceiling || preview.to_process === 0 : preview.within_ceiling && preview.to_process > 0}
            extra={repeat && preview.to_process === 0 ? <div class="text-xs text-muted">Hoje não há nada a processar nesta janela; as próximas execuções pagarão só o que chegar de novo.</div> : null}
          />
        ) : null}
      </div>
    </Modal>
  );
}
