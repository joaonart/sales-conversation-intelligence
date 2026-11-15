import { useEffect, useMemo, useState } from "preact/hooks";
import { Alert, EmptyState } from "../components/Alert";
import { Badge } from "../components/Badge";
import { Button, ToggleGroup } from "../components/Button";
import { Card } from "../components/Card";
import { DataTable } from "../components/DataTable";
import { DatePicker } from "../components/DatePicker";
import { Field, Select } from "../components/Field";
import { FilterBar } from "../components/FilterBar";
import { PageHead } from "../components/PageHead";
import { DetailSkeleton, SkeletonRegion, TableSkeleton, TextSkeleton } from "../components/Skeleton";
import { ErrorAlert } from "../components/Bits";
import { fmtInt, fmtNum, isoDay } from "../lib/format";
import type { PromptCriterionStats, PromptExample, PromptPreview } from "../lib/types";
import { useSession } from "../state/session";

interface Filters {
  /** "rubric_id@version". */
  rubric: string;
  from: string;
  to: string;
  seller: string;
}
type Async<T> = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

const defaults = (): Filters => ({ rubric: "", from: isoDay(29), to: isoDay(0), seller: "" });
const scopeOf = (f: Filters) => {
  const [rubric_id = "", version = "0"] = f.rubric.split("@");
  return { rubric_id, version: Number(version), from: f.from, to: f.to, ...(f.seller ? { seller: f.seller } : {}) };
};
const SENDER: Record<string, string> = { customer: "Cliente", seller: "Vendedor", bot: "Bot", system: "Sistema" };
const pctText = (n: number | null): string => (n === null ? "—" : `${fmtNum(n)}%`);

/**
 * Improve an agent's prompt, stage 1: the FREE preview. From the analyses that already exist it shows, per criterion of a published rubric version,
 * where the agent loses points, with real (masked) examples. Every number is counted in BigQuery; nothing here calls the AI or spends anything.
 * The next stage turns this into suggested changes to the prompt.
 */
export function PromptImprovementView() {
  const { api } = useSession();
  const [rubrics, setRubrics] = useState<Array<{ rubric_id: string; version: number; name: string }>>([]);
  const [rubricsLoaded, setRubricsLoaded] = useState(false);
  const [sellers, setSellers] = useState<Array<{ seller_id: string; sessions: number }>>([]);
  const [draft, setDraft] = useState<Filters>(defaults());
  const [applied, setApplied] = useState<Filters | null>(null);
  const [preview, setPreview] = useState<Async<PromptPreview>>({ status: "idle" });
  const [open, setOpen] = useState<string | null>(null);
  const set = (patch: Partial<Filters>) => setDraft((d) => ({ ...d, ...patch }));

  // The published versions to choose from; the first one is looked at right away.
  useEffect(() => {
    void api("promptImprovement.rubrics").then(
      (list) => {
        setRubrics(list);
        setRubricsLoaded(true);
        const first = list[0];
        if (first) {
          const f = { ...defaults(), rubric: `${first.rubric_id}@${first.version}` };
          setDraft(f);
          setApplied(f);
        }
      },
      (e: unknown) => setPreview({ status: "error", message: e instanceof Error ? e.message : "Não foi possível carregar as rubricas." }),
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadSellers = (from: string, to: string) => void api("promptImprovement.sellers", { from, to }).then(setSellers, () => setSellers([]));
  useEffect(() => {
    if (applied) loadSellers(applied.from, applied.to);
  }, [applied?.from, applied?.to]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!applied) return;
    let current = true;
    setPreview({ status: "loading" });
    setOpen(null);
    api("promptImprovement.preview", scopeOf(applied)).then(
      (data) => current && setPreview({ status: "ready", data }),
      (e: unknown) => current && setPreview({ status: "error", message: e instanceof Error ? e.message : "Não foi possível calcular a prévia." }),
    );
    return () => {
      current = false;
    };
  }, [applied]); // eslint-disable-line react-hooks/exhaustive-deps

  const rubricOptions = useMemo(() => rubrics.map((r) => [`${r.rubric_id}@${r.version}`, `${r.rubric_id} v${r.version} · ${r.name}`] as const), [rubrics]);
  const noRubric = rubricsLoaded && !rubrics.length;

  return (
    <>
      <PageHead
        title="Melhorar prompt do agente"
        subtitle="Onde o atendimento perde pontos nos critérios da rubrica, a partir das análises que já existem"
      />
      <Alert class="mb-4">
        <div>
          <strong>Prévia gratuita.</strong> Os números vêm direto das análises já feitas e não chamam a IA nem geram custo. Os exemplos mostram mensagens reais, com CPF, CNPJ,
          e-mail e telefone mascarados; abrir exemplos fica registrado na auditoria. A geração de sugestões de ajuste do prompt é a próxima etapa.
        </div>
      </Alert>
      {rubrics.length ? (
        <FilterBar
          dirty={JSON.stringify(draft) !== JSON.stringify(applied ?? draft)}
          onSubmit={() => setApplied({ ...draft })} // a new object each time: Buscar looks again even with the same filters
          onClear={() => {
            const f = { ...defaults(), rubric: draft.rubric };
            setDraft(f);
            setApplied(f);
          }}
        >
          <Field label="Rubrica" class="!w-80">
            <Select aria-label="Rubrica" value={draft.rubric} onChange={(e) => set({ rubric: e.currentTarget.value })}>
              {rubricOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="De"><DatePicker value={draft.from} onChange={(e) => set({ from: e.currentTarget.value })} /></Field>
          <Field label="Até"><DatePicker value={draft.to} onChange={(e) => set({ to: e.currentTarget.value })} /></Field>
          <Field label="Vendedor">
            <Select aria-label="Vendedor" value={draft.seller} onChange={(e) => set({ seller: e.currentTarget.value })}>
              <option value="">Todos</option>
              {sellers.map((x) => (
                <option key={x.seller_id} value={x.seller_id}>
                  {x.seller_id} ({fmtInt(x.sessions)})
                </option>
              ))}
              {draft.seller && !sellers.some((x) => x.seller_id === draft.seller) ? <option value={draft.seller}>{draft.seller}</option> : null}
            </Select>
          </Field>
        </FilterBar>
      ) : null}
      {!noRubric && (preview.status === "loading" || preview.status === "idle") ? (
        <>
          <SkeletonRegion class="mb-4">
            <TextSkeleton lines={2} />
          </SkeletonRegion>
          <Card flush>
            <TableSkeleton headers={["Critério", "Peso", "Nota média", "Pontos perdidos", "Fracas", "Sem evidência", "Respostas"]} rows={5} />
          </Card>
        </>
      ) : null}
      {preview.status === "error" ? <ErrorAlert message={preview.message} /> : null}
      {noRubric ? (
        <Card>
          <EmptyState icon="rubrics">Nenhuma rubrica publicada neste workspace. Publique uma rubrica para ver onde o atendimento perde pontos.</EmptyState>
        </Card>
      ) : null}
      {preview.status === "ready" ? <Body p={preview.data} open={open} setOpen={setOpen} /> : null}
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div class="rounded-card border border-line bg-surface p-4 shadow-card">
      <div class="text-xs font-medium text-muted">{label}</div>
      <div class="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {sub ? <div class="mt-0.5 text-xs text-faint">{sub}</div> : null}
    </div>
  );
}

function Body({ p, open, setOpen }: { p: PromptPreview; open: string | null; setOpen: (id: string | null) => void }) {
  const { sample } = p;
  const decided = sample.approved + sample.rejected;
  if (sample.analyses === 0) {
    return (
      <Card>
        <EmptyState icon="sessions">
          Nenhuma análise concluída de {p.rubric.rubric_id} v{p.rubric.version} neste período{p.seller ? ` para o vendedor ${p.seller}` : ""}. Amplie o período ou escolha outra versão.
        </EmptyState>
      </Card>
    );
  }
  const columns = [
    {
      header: "Critério",
      cell: (c: PromptCriterionStats) => (
        <div>
          <div class="flex flex-wrap items-center gap-2">
            <strong>{c.name}</strong>
            {c.weight === 0 ? <Badge tone="neutral">portão</Badge> : null}
            {c.required ? <Badge tone="warn">{c.minimum_score !== null ? `obrigatório · mín. ${fmtNum(c.minimum_score)}` : "obrigatório"}</Badge> : null}
            {!c.enough && c.weight > 0 ? <Badge tone="neutral">amostra pequena</Badge> : null}
          </div>
          <div class="font-mono text-xs text-muted">{c.criterion_id}</div>
        </div>
      ),
    },
    { header: "Peso", align: "right" as const, cell: (c: PromptCriterionStats) => fmtNum(c.weight) },
    { header: "Nota média", align: "right" as const, cell: (c: PromptCriterionStats) => (c.avg_score === null ? "—" : fmtNum(c.avg_score)) },
    { header: "Pontos perdidos", align: "right" as const, cell: (c: PromptCriterionStats) => <strong class="tabular-nums">{c.weight > 0 ? fmtNum(c.points_lost) : "—"}</strong> },
    { header: `Fracas (< ${p.weak_below})`, align: "right" as const, cell: (c: PromptCriterionStats) => (c.weight > 0 ? pctText(c.weak_pct) : "—") },
    { header: "Sem evidência", align: "right" as const, cell: (c: PromptCriterionStats) => pctText(c.insufficient_pct) },
    { header: "Abaixo do mínimo", align: "right" as const, cell: (c: PromptCriterionStats) => pctText(c.below_minimum_pct) },
    {
      header: "Respostas",
      cell: (c: PromptCriterionStats) => {
        const total = c.answers.reduce((n, a) => n + a.n, 0);
        return total ? <span class="text-xs">{c.answers.map((a) => `${a.answer} ${fmtNum((100 * a.n) / total, 0)}%`).join(" · ")}</span> : "—";
      },
    },
    {
      header: "",
      cell: (c: PromptCriterionStats) =>
        c.weight > 0 ? (
          <Button variant="text" small aria-expanded={open === c.criterion_id} onClick={() => setOpen(open === c.criterion_id ? null : c.criterion_id)}>
            {open === c.criterion_id ? "Fechar" : "Ver exemplos"}
          </Button>
        ) : null,
    },
  ];
  const picked = p.criteria.find((c) => c.criterion_id === open);
  return (
    <>
      <div class="mb-4 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
        <Stat label="Análises" value={fmtInt(sample.analyses)} sub={`${fmtInt(sample.sessions)} sessões · a mais recente de cada sessão`} />
        <Stat label="Nota média" value={sample.avg_score === null ? "—" : fmtNum(sample.avg_score)} sub="de 0 a 100" />
        <Stat label="Aprovação" value={decided ? `${fmtNum((100 * sample.approved) / decided, 0)}%` : "—"} sub={`${fmtInt(sample.approved)} aprovadas · ${fmtInt(sample.rejected)} reprovadas`} />
        <Stat label="Em revisão" value={fmtInt(sample.needs_review)} sub="sem evidência suficiente" />
      </div>
      {!p.enough ? (
        <Alert tone="warn" class="mb-4">
          Só {fmtInt(sample.analyses)} análises neste recorte (o mínimo recomendado é {p.min_sample}). Com poucas conversas os números de cada critério variam muito: amplie o
          período antes de mudar o prompt com base neles.
        </Alert>
      ) : null}
      <Card flush title="Onde se perdem pontos" aside={`${p.rubric.rubric_id} v${p.rubric.version} · ${p.period.from} a ${p.period.to}${p.seller ? ` · ${p.seller}` : ""}`} class="mb-4">
        <DataTable caption="Critérios da rubrica, do que mais tira pontos para o que menos tira" columns={columns} rows={p.criteria} rowKey={(c) => c.criterion_id} />
        <p class="px-5 py-3 text-xs text-muted">
          “Pontos perdidos” é quanto o critério custou, em média, na nota geral (0 a 100) de cada análise: peso × (100 − nota) dividido pelo peso do que se aplicou naquela
          análise. A lista vem do critério que mais tira pontos para o que menos tira; os critérios de portão (peso 0) não medem qualidade.
        </p>
      </Card>
      {picked ? <Examples key={picked.criterion_id} p={p} c={picked} /> : null}
    </>
  );
}

function Examples({ p, c }: { p: PromptPreview; c: PromptCriterionStats }) {
  const { api } = useSession();
  const [kind, setKind] = useState<"weak" | "good">("weak");
  const [res, setRes] = useState<Async<{ examples: PromptExample[]; maskedNote: string }>>({ status: "loading" });
  useEffect(() => {
    let current = true;
    setRes({ status: "loading" });
    api("promptImprovement.examples", { rubric_id: p.rubric.rubric_id, version: p.rubric.version, from: p.period.from, to: p.period.to, ...(p.seller ? { seller: p.seller } : {}), criterion_id: c.criterion_id, kind }).then(
      (data) => current && setRes({ status: "ready", data }),
      (e: unknown) => current && setRes({ status: "error", message: e instanceof Error ? e.message : "Não foi possível carregar os exemplos." }),
    );
    return () => {
      current = false;
    };
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Card title={`Exemplos de “${c.name}”`} aside={<ToggleGroup label="Tipo de exemplo" options={[["weak", "Piores"], ["good", "Melhores"]]} value={kind} onChange={setKind} />}>
      {res.status === "loading" ? <DetailSkeleton cards={1} /> : null}
      {res.status === "error" ? <ErrorAlert message={res.message} /> : null}
      {res.status === "ready" && !res.data.examples.length ? <EmptyState icon="sessions">{kind === "weak" ? "Nenhum caso abaixo de " + p.weak_below + " neste recorte." : "Nenhum caso com nota alta neste recorte."}</EmptyState> : null}
      {res.status === "ready"
        ? res.data.examples.map((x) => (
            <div key={x.analysis_id} class="mb-4 rounded-control border border-line p-3 last:mb-0">
              <div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <a href={`#/sessions/${encodeURIComponent(x.session_id)}`} class="font-mono">{x.session_id}</a>
                <span>nota {x.score === null ? "—" : fmtNum(x.score)}</span>
                {x.answer ? <span>resposta: <strong class="text-fg">{x.answer}</strong></span> : null}
              </div>
              {x.evidence.length ? (
                <ul class="flex flex-col gap-1.5">
                  {x.evidence.map((m) => (
                    <li key={m.message_id} class="text-sm">
                      <span class="mr-2 text-xs font-medium text-muted">{SENDER[m.sender_type] ?? m.sender_type}</span>
                      {m.excerpt}
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="text-sm text-muted">A análise não apontou mensagens como evidência deste critério.</p>
              )}
            </div>
          ))
        : null}
      {res.status === "ready" ? <p class="mt-3 text-xs text-muted">{res.data.maskedNote}</p> : null}
    </Card>
  );
}
