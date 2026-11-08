import { useEffect, useRef, useState } from "preact/hooks";
import { Avatar } from "../components/Avatar";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { useConfirm } from "../components/Modal";
import { Switch } from "../components/Switch";
import { CAPABILITIES } from "../lib/capabilities";
import { cx } from "../lib/cx";
import { setThemeMode, themeMode, type ThemeMode } from "../lib/theme";
import { ROLE_LABEL, ROLE_RANK, type Role } from "../lib/types";
import { useSession } from "../state/session";
import { go } from "./router";

/** Sign out like the Google Cloud Console: it ends the Google session in this browser and comes back, and the console asks to sign in again. */
const APP_URL = /^https:\/\/script\.google\.com\/(?:a\/macros\/[A-Za-z0-9.-]+|macros)\/s\/[A-Za-z0-9_-]+\/(?:exec|dev)$/;
export function logoutUrl(back: string | null): string {
  const base = "https://accounts.google.com/Logout";
  return typeof back === "string" && APP_URL.test(back) ? `${base}?continue=${encodeURIComponent(back)}` : base;
}

const ROLES: Role[] = ["VIEWER", "EDITOR", "ADMIN"];
const THEMES: Array<[ThemeMode, string]> = [["auto", "Automático"], ["light", "Claro"], ["dark", "Escuro"]];

function Capabilities() {
  const { role } = useSession();
  const [open, setOpen] = useState(false);
  const have = CAPABILITIES.filter((c) => ROLE_RANK[role] >= ROLE_RANK[c.min]).length;
  return (
    <div>
      <button type="button" aria-expanded={open} aria-controls="acct-caps" onClick={() => setOpen(!open)} class="flex min-h-10 w-full items-center gap-2 rounded-control border border-line bg-surface px-3 text-left text-[13px] hover:bg-surface-2">
        <span class="flex-1 font-medium">Funcionalidades disponíveis</span>
        <span class="text-xs text-muted">
          {have} de {CAPABILITIES.length}
        </span>
        <Icon name="chevron" size="sm" class={cx("text-muted transition-transform", open && "rotate-90")} />
      </button>
      <div id="acct-caps" role="region" aria-label="Funcionalidades disponíveis" hidden={!open} class="mt-2">
        {ROLES.map((r) => {
          const items = CAPABILITIES.filter((c) => c.min === r);
          if (!items.length) return null;
          const included = ROLE_RANK[role] >= ROLE_RANK[r];
          return (
            <section key={r} aria-label={`Funcionalidades do perfil ${ROLE_LABEL[r]}`} class="pt-2.5 pb-0.5">
              <div class="mb-2 flex items-center gap-2.5">
                <Badge>{ROLE_LABEL[r]}</Badge>
                <span class="text-xs text-muted">{included ? "Incluídas no seu perfil" : `Requerem o perfil ${ROLE_LABEL[r]}`}</span>
              </div>
              <ul class="flex flex-col gap-2.5">
                {items.map((c) => (
                  <li key={c.label} class="flex items-start gap-2.5">
                    <Icon name={included ? "ok" : "block"} size="sm" class={cx("mt-0.5", included ? "text-ok" : "text-faint")} />
                    <div>
                      <div class={cx("text-[13px] font-medium", !included && "text-muted")}>{c.label}</div>
                      <div class="text-xs text-muted">{c.info}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

interface AccountMenuProps {
  anchor: HTMLElement | null;
  onClose: (restoreFocus: boolean) => void;
}

/** The menu of the signed-in person: who they are, their profile and what it allows, the theme, a per-browser switch, the Google account and sign out. */
export function AccountMenu({ anchor, onClose }: AccountMenuProps) {
  const { me, role, showHow, setShowHow } = useSession();
  const confirm = useConfirm();
  const panel = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<ThemeMode>(themeMode());
  const domain = me.email.split("@")[1] ?? "";

  useEffect(() => {
    panel.current?.focus();
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current && !panel.current.contains(t) && !anchor?.contains(t)) onClose(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose(true);
      }
    };
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [anchor, onClose]);

  const signOut = async () => {
    onClose(false);
    const yes = await confirm({
      title: "Sair da conta Google?",
      okLabel: "Sair",
      body: (
        <>
          <p class="mb-2">Isso encerra a sessão das contas Google neste navegador, como no Google Cloud Console.</p>
          <p class="text-muted">Para voltar, abra o console e entre de novo.</p>
        </>
      ),
    });
    if (yes) window.open(logoutUrl(me.app_url), "_top");
  };

  return (
    <div ref={panel} role="dialog" aria-label="Conta e perfil" tabIndex={-1} class="fixed top-[3.25rem] right-3 z-40 max-h-[calc(100vh-4rem)] w-[min(400px,calc(100vw-1.5rem))] overflow-y-auto rounded-card border border-line bg-surface shadow-pop">
      <div class="flex items-center gap-4 rounded-t-card bg-primary-soft px-5 pt-5 pb-4">
        <Avatar email={me.email} profile={me.profile} large />
        <div class="min-w-0">
          <div class="font-semibold break-all">{me.profile.name || me.email}</div>
          {me.profile.name ? <div class="text-xs text-muted break-all">{me.email}</div> : null}
          <div class="text-xs text-muted">{domain ? `Conta Google do domínio ${domain}` : "Conta Google"}</div>
        </div>
      </div>
      <div class="border-t border-divider px-5 py-3.5">
        <div class="mb-2.5 flex items-center justify-between gap-2">
          <span class="text-xs font-medium tracking-wide text-muted uppercase">Perfil neste workspace</span>
          <Badge tone="primary">{ROLE_LABEL[role]}</Badge>
        </div>
        <Capabilities />
      </div>
      <div class="border-t border-divider px-5 py-3.5">
        <div class="mb-2.5 text-xs font-medium tracking-wide text-muted uppercase">Aparência</div>
        <div role="group" aria-label="Tema" class="flex overflow-hidden rounded-control border border-line">
          {THEMES.map(([m, label]) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => {
                setThemeMode(m);
                setMode(m);
              }}
              class={cx("h-9 flex-1 text-[13px] font-medium transition-colors not-last:border-r not-last:border-line", mode === m ? "bg-primary-soft text-on-primary-soft" : "bg-surface text-muted hover:bg-surface-2")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div class="border-t border-divider px-5 py-3.5">
        <Switch
          checked={showHow}
          label="Mostrar “Como funciona”"
          onChange={(on) => {
            setShowHow(on);
            if (!on && /^#\/?how(\/|$)/.test(location.hash)) go("#/dashboard");
          }}
        />
        <p class="mt-1.5 pl-12 text-xs text-muted">Página que explica o fluxo e a arquitetura. Vale só para este navegador.</p>
      </div>
      <div class="flex items-center gap-2 border-t border-divider px-5 py-3.5">
        <Button small icon="external" onClick={() => window.open("https://myaccount.google.com/", "_blank", "noopener")}>
          Gerenciar Conta Google
        </Button>
        <Button small variant="danger" icon="logout" class="ml-auto" onClick={signOut}>
          Sair
        </Button>
      </div>
    </div>
  );
}
