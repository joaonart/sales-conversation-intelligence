import { useState } from "preact/hooks";
import { go } from "../app/router";
import { EmptyState } from "../components/Alert";
import { Badge, StatusBadge, STATUS } from "../components/Badge";
import { ErrorAlert, Loading } from "../components/Bits";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { DataTable } from "../components/DataTable";
import { Field, Input, Select } from "../components/Field";
import { FilterBar } from "../components/FilterBar";
import { Icon } from "../components/Icon";
import { Modal, useConfirm } from "../components/Modal";
import { PageHead } from "../components/PageHead";
import { Pager } from "../components/Pager";
import { useToast } from "../components/Toasts";
import { cx } from "../lib/cx";
import { fmtDt } from "../lib/format";
import { readPaging, usePagedList } from "../lib/usePagedList";
import type { RubricFilters, RubricRow } from "../lib/types";
import { useSession } from "../state/session";
import { RubricEditor } from "./RubricEditor";

const DEFAULTS: RubricFilters = { query: "", status: "" };
const SIZES = [5, 10, 25];
const editorHash = (rid: string, version: number) => `#/rubrics/${encodeURIComponent(rid)}/${version}`;

function NewRubricDialog({ onClose }: { onClose: () => void }) {
  const { api } = useSession();
  const toast = useToast();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const rid = id.trim();
      const r = await api("rubrics.createDraft", { rubric_id: rid, name: name.trim() });
      onClose();
      go(editorHash(rid, r.version));
    } catch (err) {
      setBusy(false);
      toast(err instanceof Error ? err.message : "Não foi possível criar a rubrica.", true);
    }
  };
  return (
    <Modal title="Nova rubrica" onClose={onClose}>
      <form onSubmit={submit} class="flex flex-col gap-4">
        <Field label="Identificador (letras, números, _ . : -)">
          <Input data-autofocus placeholder="ex.: qualidade_comercial" maxLength={64} value={id} onInput={(e) => setId(e.currentTarget.value)} />
        </Field>
        <Field label="Nome">
          <Input placeholder="Nome" maxLength={120} value={name} onInput={(e) => setName(e.currentTarget.value)} />
        </Field>
        <div class="mt-2 flex justify-end gap-2">
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" disabled={busy}>
            Criar rascunho
          </Button>
        </div>
      </form>
    </Modal>
  );
}

interface GroupProps {
  rid: string;
  versions: RubricRow[];
  open: boolean;
  onToggle: () => void;
  canEdit: boolean;
  onRevise: (rid: string, version: number, name: string) => void;
}

/** One rubric with all its versions. A rubric with many versions is long, so it is a collapsible section. */
function RubricGroup({ rid, versions, open, onToggle, canEdit, onRevise }: GroupProps) {
  const draft = versions.find((v) => v.status === "DRAFT");
  const latestPub = versions.find((v) => v.status === "PUBLISHED");
  // The name people know it by: the newest published version, or the newest one when nothing is published yet.
  const current = latestPub ?? versions[0];
  const bodyId = `rub-body-${rid}`;
  return (
    <Card flush class={cx("mb-3", open && "border-primary/40")}>
      <div class="flex flex-wrap items-center gap-2 pr-3">
        <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={onToggle} class="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-surface-2">
          <Icon name="chevron" size="sm" class={cx("text-muted transition-transform", open && "rotate-90")} />
          <span class="flex min-w-0 flex-col">
            <span class="truncate font-medium">{current?.name || rid}</span>
            <span class="truncate font-mono text-xs text-muted" title="Identificador">{rid}</span>
          </span>
          <span class="ml-auto flex flex-wrap items-center justify-end gap-2 text-xs text-muted">
            {versions.length} {versions.length === 1 ? "versão" : "versões"}
            {latestPub ? <Badge tone="ok">v{latestPub.version} publicada</Badge> : <Badge>nenhuma publicada</Badge>}
            {draft ? <Badge tone="warn">rascunho v{draft.version}</Badge> : null}
          </span>
        </button>
        {canEdit && latestPub && !draft ? (
          <Button small onClick={() => onRevise(rid, latestPub.version, latestPub.name)}>
            Nova revisão a partir da v{latestPub.version}
          </Button>
        ) : null}
      </div>
      <div id={bodyId} hidden={!open} class="border-t border-divider">
        <DataTable
          caption={`Versões de ${rid}`}
          rows={versions}
          rowKey={(r) => `${r.rubric_id}@${r.version}`}
          onRowClick={(r) => go(editorHash(rid, r.version))}
          columns={[
            { header: "Versão", cell: (r) => `v${r.version}` },
            { header: "Nome", cell: (r) => r.name },
            { header: "Status", cell: (r) => <StatusBadge code={r.status} /> },
            { header: "Publicada em", cell: (r) => fmtDt(r.published_at) },
            { header: "Criada em", cell: (r) => fmtDt(r.created_at) },
          ]}
        />
      </div>
    </Card>
  );
}

function RubricList() {
  const { api, tenantKey, can } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const canEdit = can("EDITOR");
  const [initial] = useState(() => readPaging<RubricFilters>("rubrics", tenantKey, SIZES));
  const [draft, setDraft] = useState<RubricFilters>({ ...DEFAULTS, ...(initial?.filters ?? {}) });
  const [applied, setApplied] = useState<RubricFilters>(draft);
  // Which rubrics are expanded (by id). Never saved: kept while the page is open so paging and filtering do not collapse what you opened.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useState(false);

  const list = usePagedList<RubricRow, RubricFilters>({
    key: "rubrics",
    tenantKey,
    filters: applied,
    sizes: SIZES,
    size: 10,
    restore: initial,
    load: (cursor, limit) => api("rubrics.list", { ...applied, limit, cursor }),
    count: () => api("rubrics.count", applied),
    unitsOf: (rows) => new Set(rows.map((r) => r.rubric_id)).size,
    onCountError: (e) => toast(e instanceof Error ? e.message : "Não foi possível contar.", true),
  });

  const order: string[] = [];
  const groups = new Map<string, RubricRow[]>();
  for (const r of list.rows) {
    if (!groups.has(r.rubric_id)) {
      groups.set(r.rubric_id, []);
      order.push(r.rubric_id);
    }
    groups.get(r.rubric_id)?.push(r);
  }
  const isOpen = (rid: string) => opened[rid] ?? order.length === 1;
  const setAll = (on: boolean) => setOpened(Object.fromEntries(order.map((rid) => [rid, on])));
  const filtered = applied.query !== "" || applied.status !== "";

  const revise = async (rid: string, version: number, name: string) => {
    const yes = await confirm({ title: "Nova revisão", okLabel: "Criar rascunho", body: <p>Será criado um rascunho copiando a v{version} (critérios e política). A versão publicada não muda.</p> });
    if (!yes) return;
    try {
      const r = await api("rubrics.createDraft", { rubric_id: rid, name: name || rid, cloneFromVersion: version });
      go(editorHash(rid, r.version));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Não foi possível criar a revisão.", true);
    }
  };

  return (
    <>
      <PageHead
        title="Rubricas"
        subtitle="Rubricas publicadas são imutáveis: para mudar, crie uma nova revisão"
        actions={canEdit ? <Button variant="primary" icon="add" onClick={() => setCreating(true)}>Nova rubrica</Button> : null}
      />
      {creating ? <NewRubricDialog onClose={() => setCreating(false)} /> : null}
      <FilterBar
        dirty={draft.query !== "" || draft.status !== ""}
        onSubmit={() => setApplied(draft)}
        onClear={() => {
          setDraft(DEFAULTS);
          setApplied(DEFAULTS);
        }}
      >
        <Field label="Rubrica">
          <Input type="search" placeholder="identificador ou nome" maxLength={64} value={draft.query} onInput={(e) => setDraft({ ...draft, query: e.currentTarget.value.trim() })} />
        </Field>
        <Field label="Tem versão">
          <Select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.currentTarget.value })}>
            <option value="">Qualquer</option>
            {(["PUBLISHED", "DRAFT"] as const).map((x) => (
              <option key={x} value={x} selected={x === draft.status}>
                {STATUS[x]?.[0] ?? x}
              </option>
            ))}
          </Select>
        </Field>
      </FilterBar>
      {list.status === "error" ? <ErrorAlert message={list.error ?? ""} /> : null}
      {list.status === "loading" && !list.rows.length ? <Loading /> : null}
      {list.status === "ready" && !order.length ? (
        <Card>
          <EmptyState icon="rubrics">{filtered ? "Nenhuma rubrica com estes filtros." : "Nenhuma rubrica ainda."}</EmptyState>
        </Card>
      ) : null}
      {order.length > 1 ? (
        <div class="mb-3 flex items-center gap-2">
          <span class="text-xs text-muted">{order.length} rubricas nesta página</span>
          <span class="flex-1" />
          <Button small onClick={() => setAll(true)}>Expandir todas</Button>
          <Button small onClick={() => setAll(false)}>Recolher todas</Button>
        </div>
      ) : null}
      {order.map((rid) => (
        <RubricGroup key={rid} rid={rid} versions={groups.get(rid) ?? []} open={isOpen(rid)} onToggle={() => setOpened({ ...opened, [rid]: !isOpen(rid) })} canEdit={canEdit} onRevise={revise} />
      ))}
      <Pager list={list} unit="rubricas" noun="Rubricas por página" bare />
    </>
  );
}

export function RubricsView({ parts }: { parts: string[] }) {
  const [rid, ver] = parts;
  return rid && ver ? <RubricEditor rubricId={decodeURIComponent(rid)} version={Number(ver)} /> : <RubricList />;
}
