// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "../../src/ui/components/Modal";
import { ToastProvider } from "../../src/ui/components/Toasts";
import { SessionProvider } from "../../src/ui/state/session";
import { AuditView } from "../../src/ui/views/AuditView";
import type { Me } from "../../src/ui/lib/types";

const me: Me = { email: "ana@empresa.com", memberships: [{ organization_id: "o", workspace_id: "w", role: "ADMIN" }], profile: { name: null, photo_url: null }, app_url: null };
const event = (i: number) => ({ event_id: `e${i}`, occurred_at: "2026-10-28T17:00:00Z", actor_email: "ana@empresa.com", action: "session.view", entity_type: "session", entity_id: `s${i}`, outcome: "SUCCESS", details: null, request_id: null });

let calls: Array<{ method: string; payload: Record<string, unknown> }>;
function installServer(rows: ReturnType<typeof event>[]) {
  calls = [];
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
          const { method, payload } = JSON.parse(json) as { method: string; payload: Record<string, unknown> };
          calls.push({ method, payload });
          const data = method === "audit.list" ? { rows, nextCursor: null } : method === "audit.count" ? { total: rows.length } : { actors: ["ana@empresa.com"], actions: ["session.view"], outcomes: ["SUCCESS"] };
          this.ok?.(JSON.stringify({ ok: true, data }));
        },
      },
    },
  };
}

const mount = (parts: string[] = []) =>
  render(
    <ToastProvider>
      <ConfirmProvider>
        <SessionProvider me={me}>
          <AuditView parts={parts} />
        </SessionProvider>
      </ConfirmProvider>
    </ToastProvider>,
  );

describe("AuditView", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(cleanup);

  it("lists events, sends the tenant on every call and shows the range and total", async () => {
    installServer([event(1), event(2)]);
    mount();
    await screen.findByText("s1", { exact: false });
    expect(calls.every((c) => (c.payload.tenant as { organization_id: string }).organization_id === "o")).toBe(true);
    await waitFor(() => expect(screen.getByLabelText("Mostrando 1 a 2 de 2 eventos. Página 1 de 1.")).toBeTruthy());
  });

  it("only reloads the list when Buscar is pressed, and Limpar starts disabled", async () => {
    installServer([event(1)]);
    mount();
    await screen.findByText("s1", { exact: false });
    const clear = screen.getByRole("button", { name: "Limpar filtros" }) as HTMLButtonElement;
    expect(clear.disabled).toBe(true);
    const before = calls.filter((c) => c.method === "audit.list").length;
    fireEvent.input(screen.getByPlaceholderText("ID exato"), { target: { value: "s9" } });
    expect(calls.filter((c) => c.method === "audit.list").length).toBe(before);
    expect(clear.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "audit.list").length).toBe(before + 1));
    expect(calls.filter((c) => c.method === "audit.list").at(-1)?.payload.entity).toBe("s9");
  });

  it("says so when nothing matches", async () => {
    installServer([]);
    mount();
    await screen.findByText("Sem eventos no período.");
  });
});
