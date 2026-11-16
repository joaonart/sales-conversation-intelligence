import { useEffect, useState } from "preact/hooks";
import { Alert, EmptyState } from "../components/Alert";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { StatusBadge } from "../components/Badge";
import { DataTable } from "../components/DataTable";
import { Checkbox, Textarea } from "../components/Controls";
import { Field, Input, NumberInput, Select } from "../components/Field";
import { useConfirm } from "../components/Modal";
import { SkeletonRegion, TextSkeleton } from "../components/Skeleton";
import { useToast } from "../components/Toasts";
import { ErrorAlert } from "../components/Bits";
import { Badge } from "../components/Badge";
import { fmtDt, fmtInt, fmtUsd } from "../lib/format";
import type { PromptEstimate, PromptModels, PromptPreview, PromptSuggestionResult, SavedPrompt, SuggestionRequest } from "../lib/types";
import { useSession } from "../state/session";

/** What the person typed. It lives in the page (not here), so the pasted prompt survives a new search of the preview above. */
export interface PromptForm {
  text: string;
  name: string;
  retain: boolean;
  model: string;
  cap: number;
}
export const emptyPromptForm = (): PromptForm => ({ text: "", name: "", retain: false, model: "", cap: 0.1 });

type Async<T> = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

const scopeOf = (p: PromptPreview) => ({ rubric_id: p.rubric.rubric_id, version: p.rubric.version, from: p.period.from, to: p.period.to, ...(p.seller ? { seller: p.seller } : {}) });

/**
 * Improve an agent's prompt, stage 2 (the request side): paste the prompt, see what the call would cost and, for an ADMIN, leave the request registered
 * with the ceiling approved. The AI receives the prompt and the NUMBERS of the preview above (never a piece of conversation). The suggestions are written
 * by the on-demand worker (it polls every few minutes); a finished request opens them below.
 */
export function PromptRequestPanel({ p, form, patch }: { p: PromptPreview; form: PromptForm; patch: (changes: Partial<PromptForm>) => void }) {
  const { api, can } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const admin = can("ADMIN");
  const [cfg, setCfg] = useState<PromptModels | null>(null);
  const [saved, setSaved] = useState<SavedPrompt[]>([]);
  const [requests, setRequests] = useState<SuggestionRequest[] | null>(null);
  const [est, setEst] = useState<Async<PromptEstimate>>({ status: "idle" });
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const scope = scopeOf(p);
  const scopeKey = JSON.stringify(scope);

  const loadRequests = () => void (admin ? api("promptImprovement.requests").then(setRequests, () => setRequests([])) : Promise.resolve());
  const loadSaved = () => void api("promptImprovement.prompts").then(setSaved, () => setSaved([]));
  useEffect(() => {
    void api("promptImprovement.models").then(setCfg, () => setCfg(null));
    loadSaved();
    loadRequests();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // a number that was shown is only valid for the sample it was computed on
  useEffect(() => setEst({ status: "idle" }), [scopeKey]);

  const edit = (changes: Partial<PromptForm>) => {
    patch(changes);
    setEst({ status: "idle" });
  };
  // the model the call uses: the one chosen, else the catalog's default (never written into the form, so it cannot overwrite what is being typed)
  const model = form.model || cfg?.default || "";
  const min = cfg?.min_chars ?? 20;
  const max = cfg?.max_chars ?? 20_000;
  const tooShort = form.text.trim().length < min;
  const call = { ...scope, prompt: form.text, model: model || undefined, max_cost_usd: form.cap };

  const estimate = async () => {
    setEst({ status: "loading" });
    try {
      setEst({ status: "ready", data: await api("promptImprovement.estimate", call) });
    } catch (e) {
      setEst({ status: "error", message: e instanceof Error ? e.message : "Não foi possível estimar." });
    }
  };

  const open = async (promptId: string) => {
    if (!promptId) return;
    try {
      const x = await api("promptImprovement.prompt", { prompt_id: promptId });
      edit({ text: x.content, name: x.name, retain: true });
      toast(`Prompt “${x.name}” (versão ${x.version}) carregado.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Não foi possível abrir o prompt.", true);
    }
  };

  const submit = async () => {
    if (est.status !== "ready") return;
    const e = est.data;
    const yes = await confirm({
      title: "Pedir sugestões para o prompt",
      okLabel: "Pedir sugestões",
      body: (
        <>
          <p class="mb-2">Você autoriza gastar até <strong>{fmtUsd(form.cap)}</strong> em uma chamada à IA.</p>
          <ul class="mb-2 list-disc pl-5">
            <li>Modelo: {e.model} (Responses API)</li>
            <li>{fmtInt(e.sample.analyses)} análises de {p.rubric.rubric_id} v{p.rubric.version}, de {p.period.from} a {p.period.to}{p.seller ? ` (vendedor ${p.seller})` : ""}</li>
            <li>Estimativa: de {fmtUsd(e.estimate_low_usd)} a {fmtUsd(e.estimate_high_usd)}</li>
            <li>{form.retain ? `O prompt fica guardado como “${form.name}”.` : "O prompt não fica guardado: o texto é apagado quando o pedido terminar ou for cancelado."}</li>
          </ul>
          <p class="text-muted">
            A IA recebe o seu prompt e os números da prévia, nenhum trecho de conversa. O pedido fica registrado com o seu nome. O worker sob demanda confere o teto de novo,
            escreve as sugestões na próxima passada (cerca de 10 minutos) e o pedido pode ser cancelado enquanto aguarda.
          </p>
        </>
      ),
    });
    if (!yes) return;
    setBusy(true);
    try {
      await api("promptImprovement.request", { ...call, retain: form.retain, ...(form.name.trim() ? { name: form.name.trim() } : {}), confirm: true });
      toast("Pedido registrado. O worker o pega na próxima passada.");
      setEst({ status: "idle" });
      loadSaved();
      loadRequests();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Não foi possível registrar o pedido.", true);
    }
    setBusy(false);
  };

  const cancel = async (r: SuggestionRequest) => {
    const yes = await confirm({
      title: "Cancelar o pedido",
      okLabel: "Cancelar o pedido",
      danger: true,
      body: <p>O pedido {r.request_id} deixa de existir para o executor.{r.retained === false ? " O texto do prompt, que não foi guardado, é apagado." : ""}</p>,
    });
    if (!yes) return;
    try {
      await api("promptImprovement.cancel", { request_id: r.request_id });
      toast("Pedido cancelado.");
      loadRequests();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Não foi possível cancelar.", true);
    }
  };

  const canRequest = admin && est.status === "ready" && est.data.enough && est.data.within_ceiling && !busy;
  return (
    <>
      <Card title="Pedir sugestões para o seu prompt" class="mb-4">
        <Alert class="mb-4">
          <div>
            A IA recebe o seu prompt e os <strong>números</strong> da prévia acima (notas, percentuais e as respostas de cada critério). <strong>Nenhum trecho de conversa é enviado.</strong>{" "}
            Você cola o prompt, vê o custo e, sendo administrador, pede as sugestões. Quem as escreve é o worker sob demanda, que passa de tempos em tempos (cerca de 10
            minutos), confere o teto de novo e só chama a IA se estiver habilitada: depois, abra o pedido concluído na lista abaixo.
          </div>
        </Alert>
        {saved.length ? (
          <Field label="Prompts guardados" class="mb-3 !w-80">
            <Select aria-label="Prompts guardados" value="" onChange={(e) => void open(e.currentTarget.value)}>
              <option value="">Colar um novo</option>
              {saved.map((x) => (
                <option key={x.prompt_id} value={x.prompt_id}>{`${x.name} · v${x.version}`}</option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label="Prompt do agente" hint={tooShort && form.text ? `Mínimo de ${min} caracteres.` : `${fmtInt(form.text.length)} de ${fmtInt(max)} caracteres`}>
          <Textarea rows={8} maxLength={max} value={form.text} placeholder="Cole aqui o prompt que o agente usa hoje" onInput={(e) => edit({ text: e.currentTarget.value })} />
        </Field>
        <div class="mt-3 flex flex-wrap items-start gap-4">
          <Field label="Nome do prompt" class="!w-72" hint={form.retain && !form.name.trim() ? "Obrigatório para guardar." : undefined}>
            <Input maxLength={80} value={form.name} placeholder="ex.: Agente de calçados" onInput={(e) => edit({ name: e.currentTarget.value })} />
          </Field>
          <Field label="Modelo" class="!w-52">
            <Select aria-label="Modelo" value={model} onChange={(e) => edit({ model: e.currentTarget.value })}>
              {(cfg?.models ?? []).map((m) => (
                <option key={m.model} value={m.model}>{m.validated ? m.model : `${m.model} (não validado)`}</option>
              ))}
            </Select>
          </Field>
          <Field label="Teto de custo (US$)" class="!w-40">
            <NumberInput min={0.000001} max={cfg?.ceiling_usd} step={0.01} value={form.cap} onValue={(n) => edit({ cap: n ?? 0 })} />
          </Field>
        </div>
        <div class="mt-3">
          <Checkbox
            checked={form.retain}
            onChange={(v) => edit({ retain: v })}
            label="Guardar este prompt para reutilizar"
            hint="Sem guardar, o texto é apagado quando o pedido terminar ou for cancelado. Guardado, qualquer editor do workspace pode abri-lo (a abertura é registrada na auditoria)."
          />
        </div>
        <div class="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={() => void estimate()} disabled={tooShort || !model || est.status === "loading" || (form.retain && !form.name.trim())}>
            {est.status === "loading" ? "Calculando..." : "Estimar custo"}
          </Button>
          {admin ? (
            <Button variant="primary" disabled={!canRequest} onClick={() => void submit()}>Pedir sugestões...</Button>
          ) : (
            <span class="text-xs text-muted">Só um administrador autoriza o gasto: peça a um administrador para registrar o pedido.</span>
          )}
        </div>
        {est.status === "loading" ? <SkeletonRegion class="mt-4"><TextSkeleton lines={3} /></SkeletonRegion> : null}
        {est.status === "error" ? <div class="mt-4"><ErrorAlert message={est.message} /></div> : null}
        {est.status === "ready" ? <Estimate e={est.data} cap={form.cap} ceiling={cfg?.ceiling_usd ?? null} /> : null}
      </Card>
      {admin ? <Requests list={requests} onCancel={cancel} onReload={loadRequests} onOpen={(id) => setOpenId((now) => (now === id ? null : id))} openId={openId} /> : null}
      {admin && openId ? <Suggestions key={openId} id={openId} onClose={() => setOpenId(null)} /> : null}
    </>
  );
}

function Estimate({ e, cap, ceiling }: { e: PromptEstimate; cap: number; ceiling: number | null }) {
  return (
    <div class="mt-4" aria-live="polite">
      {!e.enough ? (
        <Alert tone="warn" class="mb-3">
          Só {fmtInt(e.sample.analyses)} análises neste recorte: o mínimo para sugerir mudanças é 30. Amplie o período ou escolha outra versão da rubrica antes de pedir.
        </Alert>
      ) : null}
      {!e.within_ceiling ? (
        <Alert tone="warn" class="mb-3">
          O teto de {fmtUsd(cap)} é menor que a estimativa máxima de {fmtUsd(e.estimate_high_usd)}. Aumente o teto{ceiling !== null ? ` (até ${fmtUsd(ceiling)})` : ""} ou encurte o prompt.
        </Alert>
      ) : null}
      <div class="rounded-control border border-line p-4 text-sm">
        <div class="mb-1 font-medium">{e.model} · uma chamada · {fmtInt(e.sample.analyses)} análises na amostra</div>
        <div>Estimativa: de <strong>{fmtUsd(e.estimate_low_usd)}</strong> a <strong>{fmtUsd(e.estimate_high_usd)}</strong> (máximo possível) · teto {fmtUsd(cap)}</div>
        <ul class="mt-2 list-disc pl-5 text-muted">
          <li>Entrada: cerca de {fmtInt(e.approx_input_tokens)} tokens ({fmtInt(e.system_tokens)} de regras fixas, {fmtInt(e.prompt_tokens)} do seu prompt, {fmtInt(e.aggregate_tokens)} dos números)</li>
          <li>Saída: até {fmtInt(e.approx_output_tokens)} tokens (um bloco por critério)</li>
        </ul>
        {e.notes.map((n) => (
          <p key={n} class="mt-2 text-xs text-muted">{n}</p>
        ))}
      </div>
    </div>
  );
}

function Requests({ list, onCancel, onReload, onOpen, openId }: { list: SuggestionRequest[] | null; onCancel: (r: SuggestionRequest) => void; onReload: () => void; onOpen: (id: string) => void; openId: string | null }) {
  return (
    <Card flush title="Pedidos de sugestão" aside={<Button small variant="text" onClick={onReload}>Atualizar</Button>} class="mb-4">
      {list === null ? (
        <SkeletonRegion class="p-5"><TextSkeleton lines={3} /></SkeletonRegion>
      ) : !list.length ? (
        <EmptyState icon="runs">Nenhum pedido de sugestão ainda.</EmptyState>
      ) : (
        <DataTable
          caption="Pedidos de sugestão para o prompt"
          rows={list}
          rowKey={(r) => r.request_id}
          columns={[
            { header: "Pedido", cell: (r) => <span class="font-mono text-xs">{r.request_id}</span> },
            { header: "Prompt", cell: (r) => <span class="whitespace-normal">{r.prompt_name ?? "(texto apagado)"}{r.retained === false ? <span class="text-muted"> · não guardado</span> : null}</span> },
            { header: "Recorte", cell: (r) => <span class="whitespace-normal">{`${r.rubric_id} v${r.rubric_version} · ${r.period_from} a ${r.period_to}${r.seller_id ? ` · ${r.seller_id}` : ""}`}</span> },
            {
              header: "Status",
              cell: (r) => (
                <div class="whitespace-normal">
                  <StatusBadge code={r.status} />
                  {r.status === "FAILED" && r.error ? <div class="mt-1 max-w-xs text-xs text-muted">{r.error}</div> : null}
                </div>
              ),
            },
            { header: "Teto", align: "right", cell: (r) => fmtUsd(r.max_cost_usd) },
            { header: "Estimativa", align: "right", cell: (r) => (r.estimate_high_usd === null ? "—" : fmtUsd(r.estimate_high_usd)) },
            { header: "Gasto", align: "right", cell: (r) => (r.actual_cost_usd === null ? "—" : fmtUsd(r.actual_cost_usd)) },
            { header: "Pedido por", cell: (r) => <span>{r.requested_by} <span class="text-muted">{fmtDt(r.requested_at)}</span></span> },
            {
              header: "Ação",
              cell: (r) =>
                r.status === "REQUESTED" ? (
                  <Button small variant="danger" onClick={() => onCancel(r)}>Cancelar</Button>
                ) : r.status === "COMPLETED" ? (
                  <Button small variant="text" aria-expanded={openId === r.request_id} onClick={() => onOpen(r.request_id)}>{openId === r.request_id ? "Fechar" : "Ver sugestões"}</Button>
                ) : null,
            },
          ]}
        />
      )}
    </Card>
  );
}

const CHANGE: Record<string, [string, "ok" | "info" | "warn"]> = { ADD: ["Adicionar", "ok"], CHANGE: ["Trocar", "info"], REMOVE: ["Remover", "warn"] };

/** What a finished request produced: written by the AI from the prompt and from numbers (never conversation text), shown as hypotheses to test. */
function Suggestions({ id, onClose }: { id: string; onClose: () => void }) {
  const { api } = useSession();
  const [res, setRes] = useState<Async<PromptSuggestionResult>>({ status: "loading" });
  useEffect(() => {
    let current = true;
    setRes({ status: "loading" });
    api("promptImprovement.result", { request_id: id }).then(
      (data) => current && setRes({ status: "ready", data }),
      (e: unknown) => current && setRes({ status: "error", message: e instanceof Error ? e.message : "Não foi possível abrir as sugestões." }),
    );
    return () => {
      current = false;
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (data: PromptSuggestionResult, cid: string): string => data.names[cid] ?? cid;
  return (
    <Card title="Sugestões para o prompt" aside={<Button small variant="text" onClick={onClose}>Fechar</Button>} class="mb-4">
      {res.status === "loading" ? <SkeletonRegion><TextSkeleton lines={4} /></SkeletonRegion> : null}
      {res.status === "error" ? <ErrorAlert message={res.message} /> : null}
      {res.status === "ready" ? (
        <>
          <Alert class="mb-4">
            Escritas por IA a partir do seu prompt e dos números das análises. É correlação, não prova de causa: trate como hipóteses para testar e revise antes de usar.
          </Alert>
          <p class="mb-1 text-xs text-muted">
            {res.data.model} · {fmtInt(res.data.input_tokens)} tokens de entrada e {fmtInt(res.data.output_tokens)} de saída · {fmtUsd(res.data.cost_usd)} · gerado em {fmtDt(res.data.created_at)}
          </p>
          <p class="mb-4 text-sm">{res.data.suggestions.overall}</p>
          {res.data.suggestions.priorities.length ? (
            <div class="mb-4">
              <div class="mb-1 text-xs font-medium text-muted">Ordem de prioridade</div>
              <ol class="list-decimal pl-5 text-sm">
                {res.data.suggestions.priorities.map((cid) => (
                  <li key={cid}>{name(res.data, cid)}</li>
                ))}
              </ol>
            </div>
          ) : null}
          {res.data.suggestions.criteria.map((c) => (
            <div key={c.criterion_id} class="mb-4 rounded-control border border-line p-3 last:mb-0">
              <div class="mb-1 flex flex-wrap items-center gap-2">
                <strong>{name(res.data, c.criterion_id)}</strong>
                <span class="font-mono text-xs text-muted">{c.criterion_id}</span>
              </div>
              <p class="mb-2 text-sm">{c.diagnosis}</p>
              {c.changes.length ? (
                <ul class="flex flex-col gap-2">
                  {c.changes.map((ch, i) => (
                    <li key={i} class="flex items-start gap-2 text-sm">
                      <Badge tone={CHANGE[ch.kind]?.[1] ?? "neutral"}>{CHANGE[ch.kind]?.[0] ?? ch.kind}</Badge>
                      <span class="whitespace-pre-wrap">{ch.text}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="text-sm text-muted">Sem mudança sugerida para este critério.</p>
              )}
            </div>
          ))}
        </>
      ) : null}
    </Card>
  );
}
