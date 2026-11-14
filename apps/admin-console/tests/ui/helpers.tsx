import { fireEvent } from "@testing-library/preact";
import { render } from "preact";
import type { ComponentChildren } from "preact";
import { ConfirmProvider } from "../../src/ui/components/Modal";
import { ToastProvider } from "../../src/ui/components/Toasts";
import { SessionProvider } from "../../src/ui/state/session";
import type { Me, Role } from "../../src/ui/lib/types";

export const meAs = (role: Role): Me => ({ email: "ana@empresa.com", memberships: [{ organization_id: "o", workspace_id: "w", role }], profile: { name: null, photo_url: null }, app_url: null });

export interface Call {
  method: string;
  payload: Record<string, unknown>;
}
type Handler = (payload: Record<string, unknown>) => unknown;

/** A fake `google.script.run`: each rpc method answers from `handlers` (a thrown `{code,message}` becomes the error envelope). Returns the log of calls. */
export function installServer(handlers: Record<string, Handler>): Call[] {
  const calls: Call[] = [];
  (globalThis as unknown as { google: unknown }).google = {
    script: {
      run: {
        ok: null as null | ((t: string) => void),
        withSuccessHandler(fn: (t: string) => void) {
          this.ok = fn;
          return this;
        },
        withFailureHandler() {
          return this;
        },
        rpc(json: string) {
          const { method, payload } = JSON.parse(json) as Call;
          calls.push({ method, payload });
          const h = handlers[method];
          let body: unknown;
          try {
            body = { ok: true, data: h ? h(payload) : {} };
          } catch (e) {
            const err = e as { code?: string; message?: string };
            body = { ok: false, error: { code: err.code ?? "INTERNAL", message: err.message ?? "erro" } };
          }
          this.ok?.(JSON.stringify(body));
        },
      },
    },
  };
  return calls;
}

export function Providers({ role, children }: { role: Role; children?: ComponentChildren }) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <SessionProvider me={meAs(role)}>{children}</SessionProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
export { render };

/** An in-memory `localStorage` (the test environment's own is not usable): the app reads and writes it through guarded calls. */
export function installLocalStorage(): Storage {
  const map = new Map<string, string>();
  const store: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  };
  Object.defineProperty(window, "localStorage", { value: store, configurable: true });
  return store;
}

/** Chooses an option of a combo of the console: opens it and clicks the option with that value (the combo is not a native select, so there is no change to fire). */
export function pick(combo: HTMLElement, value: string): void {
  fireEvent.click(combo);
  const option = document.querySelector<HTMLElement>(`[role="option"][data-value="${value}"]`);
  if (!option) throw new Error(`no option with value "${value}"`);
  fireEvent.click(option);
}

/** The labels of the options of a combo of the console, in order (it opens the combo to read them and closes it again). */
export function options(combo: HTMLElement): string[] {
  fireEvent.click(combo);
  const labels = Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent ?? "");
  fireEvent.click(combo);
  return labels;
}

/** Waits (by polling, outside waitFor: reading the options opens the combo, and that change would wake a waitFor again and again) until the combo offers a label. */
export async function untilOffers(combo: () => HTMLElement, label: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (options(combo()).includes(label)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the combo never offered "${label}"`);
}
