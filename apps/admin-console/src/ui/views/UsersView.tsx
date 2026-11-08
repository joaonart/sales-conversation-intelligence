import { useState } from "preact/hooks";
import { Alert } from "../components/Alert";
import { StatusBadge, STATUS } from "../components/Badge";
import { Button } from "../components/Button";
import { Field, Input, Select } from "../components/Field";
import { FilterBar } from "../components/FilterBar";
import { Modal } from "../components/Modal";
import { PagedTable } from "../components/PagedTable";
import { PageHead } from "../components/PageHead";
import { useToast } from "../components/Toasts";
import { fmtDt } from "../lib/format";
import { readPaging, usePagedList } from "../lib/usePagedList";
import { ROLE_LABEL, type Role, type UserFilters, type UserRow } from "../lib/types";
import { useSession } from "../state/session";

const ROLES: Role[] = ["VIEWER", "EDITOR", "ADMIN"];
const DEFAULTS: UserFilters = { query: "", role: "", status: "" };

/** Grants access in a dialog: e-mail and role. The server's refusal shows inside the dialog, which stays open until it works or is cancelled. */
function GrantAccessDialog({ onClose, onGranted }: { onClose: () => void; onGranted: () => void }) {
  const { api } = useSession();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("VIEWER");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("users.upsert", { email, role, status: "ACTIVE" });
      toast("Acesso concedido.");
      onClose();
      onGranted();
    } catch (ex) {
      setBusy(false);
      setError(ex instanceof Error ? ex.message : "Não foi possível conceder o acesso.");
    }
  };
  return (
    <Modal title="Conceder acesso" onClose={onClose}>
      <form onSubmit={submit} class="flex flex-col gap-4">
        <p class="text-muted">A pessoa entra com a conta corporativa. O papel define o que ela pode fazer e pode ser mudado depois.</p>
        <Field label="E-mail corporativo">
          <Input data-autofocus type="email" required autoComplete="off" aria-label="E-mail corporativo" placeholder="pessoa@empresa.com" maxLength={254} value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
        </Field>
        <Field label="Papel">
          <Select aria-label="Papel" value={role} onChange={(e) => setRole(e.currentTarget.value as Role)}>
            {ROLES.map((r) => <option key={r} value={r} selected={r === role}>{ROLE_LABEL[r]}</option>)}
          </Select>
        </Field>
        {error ? <Alert tone="bad">{error}</Alert> : null}
        <div class="mt-2 flex justify-end gap-2">
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" disabled={busy}>Conceder acesso</Button>
        </div>
      </form>
    </Modal>
  );
}

export function UsersView() {
  const { api, tenantKey } = useSession();
  const toast = useToast();
  const [initial] = useState(() => readPaging<UserFilters>("users", tenantKey));
  const [draft, setDraft] = useState<UserFilters>({ ...DEFAULTS, ...(initial?.filters ?? {}) });
  const [applied, setApplied] = useState<UserFilters>(draft);
  const [granting, setGranting] = useState(false);
  const list = usePagedList<UserRow, UserFilters>({
    key: "users",
    tenantKey,
    filters: applied,
    size: 25,
    restore: initial,
    load: (cursor, limit) => api("users.list", { ...applied, limit, cursor }),
    count: () => api("users.count", applied),
    onCountError: (e) => toast(e instanceof Error ? e.message : "Não foi possível contar.", true),
  });
  const change = async (r: UserRow, role: string, status: string) => {
    try {
      await api("users.upsert", { email: r.email, role, status });
      toast("Acesso atualizado.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Não foi possível atualizar.", true);
    }
    list.reload();
  };
  const dirty = (f: UserFilters) => f.query !== "" || f.role !== "" || f.status !== "";
  return (
    <>
      <PageHead title="Usuários e acesso" subtitle="Quem pode acessar este workspace e com qual papel" actions={<Button variant="primary" icon="add" onClick={() => setGranting(true)}>Conceder acesso</Button>} />
      {granting ? <GrantAccessDialog onClose={() => setGranting(false)} onGranted={list.reload} /> : null}
      <FilterBar dirty={dirty(draft)} onSubmit={() => setApplied(draft)} onClear={() => { setDraft(DEFAULTS); setApplied(DEFAULTS); }}>
        <Field label="E-mail"><Input type="search" placeholder="contém…" maxLength={64} value={draft.query} onInput={(e) => setDraft({ ...draft, query: e.currentTarget.value.trim().toLowerCase() })} /></Field>
        <Field label="Papel">
          <Select aria-label="Papel" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.currentTarget.value })}>
            <option value="">Todos</option>
            {ROLES.map((r) => <option key={r} value={r} selected={r === draft.role}>{ROLE_LABEL[r]}</option>)}
          </Select>
        </Field>
        <Field label="Status">
          <Select aria-label="Status" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.currentTarget.value })}>
            <option value="">Todos</option>
            {(["ACTIVE", "DISABLED"] as const).map((x) => <option key={x} value={x} selected={x === draft.status}>{STATUS[x]?.[0] ?? x}</option>)}
          </Select>
        </Field>
      </FilterBar>
      <PagedTable
        list={list}
        unit="usuários"
        caption="Usuários do workspace"
        emptyIcon="users"
        empty={dirty(applied) ? "Nenhum usuário com estes filtros." : "Nenhum usuário neste workspace."}
        rowKey={(r) => r.email}
        columns={[
          { header: "E-mail", cell: (r) => r.email },
          { header: "Papel", cell: (r) => ROLE_LABEL[r.role] ?? r.role },
          { header: "Status", cell: (r) => <StatusBadge code={r.status} /> },
          { header: "Alterado em", cell: (r) => fmtDt(r.changed_at) },
          { header: "Por", cell: (r) => r.changed_by ?? "—" },
          {
            header: "Ações",
            cell: (r) => (
              <div class="flex items-center gap-2">
                <Select class="!h-8 !w-36" aria-label={`Papel de ${r.email}`} value={r.role} onChange={(e) => change(r, e.currentTarget.value, r.status)}>
                  {ROLES.map((x) => <option key={x} value={x} selected={x === r.role}>{ROLE_LABEL[x]}</option>)}
                </Select>
                <Button small variant={r.status === "ACTIVE" ? "danger" : "secondary"} onClick={() => change(r, r.role, r.status === "ACTIVE" ? "DISABLED" : "ACTIVE")}>
                  {r.status === "ACTIVE" ? "Desativar" : "Reativar"}
                </Button>
              </div>
            ),
          },
        ]}
      />
    </>
  );
}
