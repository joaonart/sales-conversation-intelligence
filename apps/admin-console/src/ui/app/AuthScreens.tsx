import type { ComponentChildren } from "preact";
import { accountChooserUrl } from "../../server/appUrl";
import { Avatar } from "../components/Avatar";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import type { IconName } from "../components/icons";
import type { ApiError } from "../lib/api";
import type { Me } from "../lib/types";

/**
 * The screens of signing in. Google is what authenticates (the web app only opens for a signed-in account of the company), and the table `app_users` is what
 * authorises (the server decides, on every call). These screens only tell the person where they stand and how to get unstuck: another account, a retry, or
 * who to ask. They never decide anything.
 */
const version = (): string => document.body?.dataset.version ?? "";
/** The web app's own address, given by the server in the page (null when it could not be read: the account chooser then opens without a way back). */
const appUrl = (): string | null => document.getElementById("app")?.dataset.appUrl || null;
/** Goes to Google's account chooser, which comes back to the console with the account that was picked. */
const chooseAccount = (back: string | null): void => void window.open(accountChooserUrl(back), "_top");

/** The page every sign-in screen sits on: the brand, a card, and one line about what the access is. */
function Frame({ children }: { children?: ComponentChildren }) {
  return (
    <main class="relative flex min-h-screen items-center justify-center overflow-hidden bg-bg px-4 py-10">
      <div class="pointer-events-none absolute -top-32 -left-24 size-96 rounded-full bg-primary-soft blur-3xl" aria-hidden="true" />
      <div class="pointer-events-none absolute -right-28 -bottom-36 size-[22rem] rounded-full bg-primary-soft opacity-70 blur-3xl" aria-hidden="true" />
      <section class="relative w-full max-w-md rounded-card border border-line bg-surface p-8 shadow-pop">
        <div class="mb-7 flex items-center gap-3 font-semibold">
          <span aria-hidden="true" class="inline-flex size-8 items-center justify-center rounded-lg bg-primary font-bold text-on-primary">S</span>
          <span class="text-base">SCI Console</span>
        </div>
        {children}
        <p class="mt-6 border-t border-divider pt-4 text-xs text-muted">O acesso é restrito a contas Google autorizadas{version() ? ` · v${version()}` : ""}</p>
      </section>
    </main>
  );
}

function Medallion({ icon, tone = "primary" }: { icon: IconName; tone?: "primary" | "warn" }) {
  return (
    <div class={tone === "warn" ? "mb-4 flex size-12 items-center justify-center rounded-full bg-warn-soft text-warn" : "mb-4 flex size-12 items-center justify-center rounded-full bg-primary-soft text-primary"}>
      <Icon name={icon} size="lg" />
    </div>
  );
}

/** While the console asks who the person is and what they may open. */
export function Splash() {
  return (
    <Frame>
      <div role="status" aria-live="polite">
        <div class="mb-4 size-12 animate-pulse rounded-full bg-primary-soft" aria-hidden="true" />
        <h1 class="mb-1 text-2xl font-semibold tracking-tight">Entrando…</h1>
        <p class="text-muted">Confirmando sua conta Google e o seu acesso.</p>
      </div>
    </Frame>
  );
}

/** The person's account, as Google gave it: the face of "this is who you are signed in as". */
function Account({ me }: { me: Pick<Me, "email" | "profile"> }) {
  return (
    <div class="mb-5 flex items-center gap-3 rounded-control border border-line bg-surface-2 px-3 py-2.5">
      <Avatar email={me.email} profile={me.profile} />
      <div class="min-w-0">
        <div class="truncate font-medium">{me.profile.name || me.email}</div>
        {me.profile.name ? <div class="truncate text-xs text-muted">{me.email}</div> : null}
      </div>
    </div>
  );
}

/** The account is a Google one but not one the console can use, or the console could not tell who it is. */
export function SignInError({ error }: { error: ApiError }) {
  const account = error.code === "UNAUTHENTICATED" || error.code === "FORBIDDEN";
  return (
    <Frame>
      <Medallion icon={account ? "lock" : "warn"} tone={account ? "primary" : "warn"} />
      <h1 class="mb-2 text-2xl font-semibold tracking-tight">{account ? "Conta não reconhecida" : "Não foi possível entrar"}</h1>
      <p class="mb-5 text-muted">{error.message}</p>
      {account ? <p class="mb-5 text-xs text-muted">Se você usa várias contas Google neste navegador, escolha a corporativa.</p> : null}
      <div class="flex flex-wrap gap-2">
        {account ? (
          <Button variant="primary" onClick={() => chooseAccount(appUrl())}>Escolher outra conta</Button>
        ) : (
          <Button variant="primary" onClick={() => window.location.reload()}>Tentar de novo</Button>
        )}
      </div>
      {error.requestId ? <p class="mt-4 font-mono text-xs text-muted">Código {error.requestId}</p> : null}
    </Frame>
  );
}

/** Signed in with Google, but no row of `app_users` gives this account a workspace: access is granted by an administrator. */
export function NoAccess({ me }: { me: Me }) {
  const contact = me.access_contact;
  const mail = contact
    ? `mailto:${contact}?subject=${encodeURIComponent("Acesso ao SCI Console")}&body=${encodeURIComponent(`Olá! Peço acesso ao SCI Console para a conta ${me.email}.`)}`
    : null;
  return (
    <Frame>
      <Medallion icon="lock" />
      <h1 class="mb-2 text-2xl font-semibold tracking-tight">Você ainda não tem acesso</h1>
      <Account me={me} />
      <p class="mb-5 text-muted">
        Sua conta Google foi reconhecida, mas ela ainda não foi liberada para nenhum workspace deste console. O acesso é concedido por um administrador.
        {contact ? "" : " Peça a ele para incluir este e-mail em Usuários e acesso."}
      </p>
      <div class="flex flex-wrap gap-2">
        {mail ? (
          <a href={mail} class="inline-flex h-9 items-center justify-center gap-2 rounded-control border border-transparent bg-primary px-4 font-medium whitespace-nowrap text-on-primary transition-colors hover:bg-primary-hover">
            Solicitar acesso
          </a>
        ) : null}
        <Button variant={mail ? "secondary" : "primary"} onClick={() => chooseAccount(me.app_url ?? appUrl())}>Usar outra conta</Button>
      </div>
      {contact ? <p class="mt-4 text-xs text-muted">A solicitação é enviada para <span class="font-medium">{contact}</span>.</p> : null}
    </Frame>
  );
}
