import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { Avatar } from "../components/Avatar";
import { IconButton } from "../components/Button";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toasts";
import { cx } from "../lib/cx";
import { NAV } from "../lib/nav";
import { readStore, writeStore } from "../lib/storage";
import { toggleTheme } from "../lib/theme";
import { ROLE_LABEL } from "../lib/types";
import { useSession } from "../state/session";
import { AccountMenu } from "./AccountMenu";
import { go, type Route } from "./router";

export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const NARROW = 960;
const NAV_KEY = "sci.nav";

function SessionSearch() {
  const toast = useToast();
  return (
    <div class="relative hidden max-w-sm min-w-0 flex-1 sm:block">
      <Icon name="search" size="sm" class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
      <input
        type="search"
        placeholder="Buscar sessão por ID"
        aria-label="Buscar sessão por ID"
        maxLength={128}
        class="h-9 w-full rounded-full border border-line bg-surface-2 pr-3 pl-9 text-sm placeholder:text-faint"
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          const input = e.currentTarget;
          const id = input.value.trim();
          if (!SESSION_ID.test(id)) {
            toast("Informe um ID de sessão válido (letras, números, _ . : -).", true);
            return;
          }
          input.value = "";
          go(`#/sessions/${encodeURIComponent(id)}`);
        }}
      />
    </div>
  );
}

function WorkspacePicker() {
  const { me, tenant, switchTo } = useSession();
  const label = (m: { organization_id: string; workspace_id: string }) => `${m.organization_id} / ${m.workspace_id}`;
  const list = me.memberships;
  // With a single workspace there is nothing to switch to: a fixed label says so instead of a menu that seems broken.
  if (list.length === 1 && list[0]) {
    return (
      <span tabIndex={0} title="Você tem acesso a apenas 1 workspace" aria-label={`Workspace ${label(list[0])} (único com acesso)`} class="hidden h-8 items-center rounded-full bg-surface-2 px-3 text-xs text-muted md:inline-flex">
        {label(list[0])}
      </span>
    );
  }
  const current = list.findIndex((m) => m.organization_id === tenant.organization_id && m.workspace_id === tenant.workspace_id);
  return (
    <select aria-label="Workspace" value={current} onChange={(e) => switchTo(Number(e.currentTarget.value))} class="hidden h-8 max-w-60 rounded-full border border-line bg-surface-2 px-3 text-xs md:block">
      {list.map((m, i) => (
        <option key={label(m)} value={i} selected={i === current}>
          {label(m)}
        </option>
      ))}
    </select>
  );
}

export function Shell({ route, children }: { route: Route; children?: ComponentChildren }) {
  const { me, role, can, showHow } = useSession();
  const [narrow, setNarrow] = useState(() => window.innerWidth <= NARROW);
  const [collapsed, setCollapsed] = useState(() => window.innerWidth > NARROW && readStore("local", NAV_KEY) === "collapsed");
  const [drawer, setDrawer] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const avatarBtn = useRef<HTMLButtonElement>(null);
  const main = useRef<HTMLElement>(null);

  useEffect(() => {
    const on = () => {
      const n = window.innerWidth <= NARROW;
      setNarrow(n);
      if (!n) setDrawer(false);
    };
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  // A new page starts at the top and moves keyboard focus to it (what a page load would do).
  useEffect(() => {
    setDrawer(false);
    main.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [route.name, route.parts.join("/")]);

  const closeMenu = useCallback((restore: boolean) => {
    setMenuOpen(false);
    if (restore) avatarBtn.current?.focus();
  }, []);
  const toggleNav = () => {
    if (narrow) {
      setDrawer((d) => !d);
      return;
    }
    const next = !collapsed;
    setCollapsed(next);
    writeStore("local", NAV_KEY, next ? "collapsed" : null);
  };

  const items = NAV.filter((n) => can(n.min) && (n.route !== "how" || showHow));
  const name = me.profile.name || me.email;
  const showNav = narrow ? drawer : !collapsed;
  let lastGroup = "";
  return (
    <div class="min-h-screen">
      <header class="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface px-3">
        <IconButton icon="menu" label="Menu de navegação" onClick={toggleNav} />
        <div class="flex items-center gap-2 font-semibold tracking-tight">
          <span aria-hidden="true" class="inline-flex size-7 items-center justify-center rounded-lg bg-primary text-sm text-on-primary">S</span>
          SCI Console
          <small class="font-normal text-faint">v{document.body.dataset.version}</small>
        </div>
        <WorkspacePicker />
        <SessionSearch />
        <span class="flex-1" />
        <IconButton icon="theme" label="Alternar tema claro/escuro" onClick={toggleTheme} />
        <button
          ref={avatarBtn}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          aria-label={`Conta e perfil: ${name} (${ROLE_LABEL[role]})`}
          title={`${name} · ${me.email} · ${ROLE_LABEL[role]}`}
          onClick={() => (menuOpen ? closeMenu(true) : setMenuOpen(true))}
          class="rounded-full p-0.5 hover:bg-surface-2"
        >
          <Avatar email={me.email} profile={me.profile} />
        </button>
      </header>
      {menuOpen ? <AccountMenu anchor={avatarBtn.current} onClose={closeMenu} /> : null}
      {narrow && drawer ? <div class="fixed inset-0 top-14 z-20 bg-scrim" onClick={() => setDrawer(false)} aria-hidden="true" /> : null}
      <nav
        aria-label="Principal"
        class={cx("fixed top-14 bottom-0 left-0 z-20 w-60 overflow-y-auto border-r border-line bg-surface px-2 py-3 transition-transform", showNav ? "translate-x-0" : "-translate-x-full")}
        {...(showNav ? {} : { inert: true })}
      >
        {items.map((n) => {
          const head = n.group !== lastGroup;
          lastGroup = n.group;
          return (
            <div key={n.route}>
              {head ? <div class="px-3 pt-4 pb-1 text-[11px] font-semibold tracking-wider text-faint uppercase">{n.group}</div> : null}
              <a
                href={`#/${n.route}`}
                aria-current={route.name === n.route ? "page" : undefined}
                class={cx("flex h-10 items-center gap-3 rounded-control px-3 text-sm font-medium hover:no-underline", route.name === n.route ? "bg-primary-soft text-on-primary-soft" : "text-muted hover:bg-surface-2 hover:text-fg")}
              >
                <Icon name={n.icon} />
                {n.label}
              </a>
            </div>
          );
        })}
      </nav>
      <main ref={main} id="main" tabIndex={-1} class={cx("mx-auto max-w-[1400px] p-4 outline-none sm:p-6", !narrow && !collapsed && "ml-60 max-w-none")}>
        {children}
      </main>
    </div>
  );
}
