import { createContext, type ComponentChildren } from "preact";
import { useCallback, useContext, useMemo, useState } from "preact/hooks";
import { tenantApi, type TenantApi } from "../lib/api";
import { readStore, writeStore } from "../lib/storage";
import { ROLE_RANK, type Me, type Role, type Tenant } from "../lib/types";

interface SessionValue {
  me: Me;
  tenant: Tenant;
  role: Role;
  /** Every call a screen makes goes through this one: it carries the workspace, so a screen cannot forget it or send another. */
  api: TenantApi;
  /** A stable key for "this person in this workspace" (what remembered pages are filed under). */
  tenantKey: string;
  switchTo: (index: number) => void;
  can: (min: Role) => boolean;
  /** Per-browser preference: the "Como funciona" entry in the menu (on by default). */
  showHow: boolean;
  setShowHow: (on: boolean) => void;
}

const Ctx = createContext<SessionValue | null>(null);

const TENANT_KEY = "sci.tenant";
const HOW_KEY = "sci.how";

export function SessionProvider({ me, children }: { me: Me; children?: ComponentChildren }) {
  const [index, setIndex] = useState(() => {
    const saved = Number(readStore("session", TENANT_KEY) ?? 0);
    return Number.isInteger(saved) && saved >= 0 && saved < me.memberships.length ? saved : 0;
  });
  const [showHow, setShow] = useState(() => readStore("local", HOW_KEY) !== "off");
  const switchTo = useCallback((i: number) => {
    setIndex(i);
    writeStore("session", TENANT_KEY, String(i));
  }, []);
  const setShowHow = useCallback((on: boolean) => {
    setShow(on);
    writeStore("local", HOW_KEY, on ? null : "off");
  }, []);

  const value = useMemo<SessionValue>(() => {
    const m = me.memberships[index] ?? me.memberships[0];
    if (!m) throw new Error("a session needs at least one membership");
    const tenant: Tenant = { organization_id: m.organization_id, workspace_id: m.workspace_id };
    return {
      me,
      tenant,
      role: m.role,
      api: tenantApi(tenant),
      tenantKey: `${me.email}|${tenant.organization_id}|${tenant.workspace_id}`,
      switchTo,
      can: (min) => ROLE_RANK[m.role] >= ROLE_RANK[min],
      showHow,
      setShowHow,
    };
  }, [me, index, switchTo, showHow, setShowHow]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside a SessionProvider");
  return v;
}
