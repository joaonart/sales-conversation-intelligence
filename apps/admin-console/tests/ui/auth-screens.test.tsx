// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoAccess, SignInError, Splash } from "../../src/ui/app/AuthScreens";
import { ApiError } from "../../src/ui/lib/api";
import type { Me } from "../../src/ui/lib/types";

const APP = "https://script.google.com/a/macros/j-nart.com/s/AKfycbyV-abc_123/exec";
const CHOOSER = `https://accounts.google.com/AccountChooser?continue=${encodeURIComponent(APP)}`;
const me = (o: Partial<Me> = {}): Me => ({ email: "ana.souza@j-nart.com", memberships: [], profile: { name: "Ana Souza", photo_url: null }, app_url: APP, access_contact: null, ...o });

let opened: Array<[string, string | undefined]>;
beforeEach(() => {
  opened = [];
  vi.stubGlobal("open", (url: string, target?: string) => void opened.push([url, target]));
  document.body.innerHTML = `<div id="app" data-app-url="${APP}"></div>`;
  document.body.dataset.version = "0.58.0";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Splash (while the console asks who the person is)", () => {
  it("is an announced status with the brand, so the wait is not a blank page", () => {
    render(<Splash />);
    const s = screen.getByRole("status");
    expect(within(s).getByText("Entrando…")).toBeTruthy();
    expect(screen.getByText("SCI Console")).toBeTruthy();
    expect(screen.getByText(/Confirmando sua conta Google e o seu acesso/)).toBeTruthy();
  });
});

describe("SignInError", () => {
  it("an account Google gave but the console does not recognise: says so, and the button opens the account chooser, coming back to the console", () => {
    render(<SignInError error={new ApiError("FORBIDDEN", "Conta fora do domínio autorizado.", [], "id-7")} />);
    expect(screen.getByRole("heading", { name: "Conta não reconhecida" })).toBeTruthy();
    expect(screen.getByText("Conta fora do domínio autorizado.")).toBeTruthy();
    expect(screen.getByText(/escolha a corporativa/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Escolher outra conta" }));
    expect(opened).toEqual([[CHOOSER, "_top"]]);
    expect(screen.getByText("Código id-7")).toBeTruthy();
  });

  it("an account Google could not identify at all is the same screen", () => {
    render(<SignInError error={new ApiError("UNAUTHENTICATED", "Não foi possível identificar o usuário.")} />);
    expect(screen.getByRole("heading", { name: "Conta não reconhecida" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Escolher outra conta" })).toBeTruthy();
  });

  it("any other failure is not blamed on the account: it offers to try again, never the account chooser", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(<SignInError error={new ApiError("UNAVAILABLE", "Falha ao consultar o BigQuery. Tente novamente.", [], "id-9")} />);
    expect(screen.getByRole("heading", { name: "Não foi possível entrar" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Escolher outra conta" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(reload).toHaveBeenCalled();
    expect(opened).toEqual([]);
  });

  it("without an address from the server the chooser still opens, just without a way back", () => {
    document.body.innerHTML = '<div id="app"></div>';
    render(<SignInError error={new ApiError("FORBIDDEN", "x")} />);
    fireEvent.click(screen.getByRole("button", { name: "Escolher outra conta" }));
    expect(opened).toEqual([["https://accounts.google.com/AccountChooser", "_top"]]);
  });

  it("an address in the page that is not a web app's is dropped (the page is data, not code)", () => {
    document.body.innerHTML = '<div id="app" data-app-url="https://evil.example/exec"></div>';
    render(<SignInError error={new ApiError("FORBIDDEN", "x")} />);
    fireEvent.click(screen.getByRole("button", { name: "Escolher outra conta" }));
    expect(opened).toEqual([["https://accounts.google.com/AccountChooser", "_top"]]);
  });
});

describe("NoAccess (signed in with Google, but no row of app_users gives the account a workspace)", () => {
  it("shows whose account it is (name and e-mail), says access is granted by an administrator, and offers another account", () => {
    render(<NoAccess me={me()} />);
    expect(screen.getByRole("heading", { name: "Você ainda não tem acesso" })).toBeTruthy();
    expect(screen.getByText("Ana Souza")).toBeTruthy();
    expect(screen.getByText("ana.souza@j-nart.com")).toBeTruthy();
    expect(screen.getByText(/O acesso é concedido por um administrador/)).toBeTruthy();
    expect(screen.getByText(/incluir este e-mail em Usuários e acesso/)).toBeTruthy(); // no contact configured: what to ask for
    expect(screen.queryByRole("link", { name: "Solicitar acesso" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Usar outra conta" }));
    expect(opened).toEqual([[CHOOSER, "_top"]]);
  });

  it("without a name in the directory the e-mail is the only line", () => {
    render(<NoAccess me={me({ profile: { name: null, photo_url: null } })} />);
    expect(screen.getAllByText("ana.souza@j-nart.com")).toHaveLength(1);
  });

  it("with a contact configured, 'Solicitar acesso' is a mail to it with the account in the message, and says where the request goes", () => {
    render(<NoAccess me={me({ access_contact: "acesso@j-nart.com" })} />);
    const link = screen.getByRole("link", { name: "Solicitar acesso" }) as HTMLAnchorElement;
    const href = link.getAttribute("href") ?? "";
    expect(href.startsWith("mailto:acesso@j-nart.com?subject=")).toBe(true);
    expect(decodeURIComponent(href.split("subject=")[1] ?? "")).toContain("Acesso ao SCI Console");
    expect(decodeURIComponent(href.split("body=")[1] ?? "")).toContain("ana.souza@j-nart.com");
    expect(screen.getByText("acesso@j-nart.com")).toBeTruthy();
    expect(screen.queryByText(/incluir este e-mail em Usuários e acesso/)).toBeNull();
    expect(screen.getByRole("button", { name: "Usar outra conta" })).toBeTruthy();
  });

  it("the chooser comes back to the address the server gave in `me`, or the page's own when `me` has none", () => {
    render(<NoAccess me={me({ app_url: null })} />);
    fireEvent.click(screen.getByRole("button", { name: "Usar outra conta" }));
    expect(opened[0]?.[0]).toBe(CHOOSER); // from the page
  });
});

describe("every sign-in screen", () => {
  it("says the access is restricted and shows the version", () => {
    render(<Splash />);
    expect(screen.getByText(/O acesso é restrito a contas Google autorizadas · v0\.58\.0/)).toBeTruthy();
  });

  it("is a page of its own: a main landmark with the brand, nothing of the console behind it", () => {
    render(<NoAccess me={me()} />);
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});
