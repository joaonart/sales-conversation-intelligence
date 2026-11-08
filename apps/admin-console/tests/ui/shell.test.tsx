// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/ui/app/App";
import { logoutUrl } from "../../src/ui/app/AccountMenu";
import { Shell } from "../../src/ui/app/Shell";
import { Avatar } from "../../src/ui/components/Avatar";
import { ConfirmProvider } from "../../src/ui/components/Modal";
import { ToastProvider } from "../../src/ui/components/Toasts";
import { CAPABILITIES } from "../../src/ui/lib/capabilities";
import { SessionProvider, useSession } from "../../src/ui/state/session";
import type { Me, Role } from "../../src/ui/lib/types";
import { installLocalStorage, installServer, Providers, meAs } from "./helpers";

const route = (name: string, parts: string[] = []) => ({ name, parts });
const mountShell = (role: Role, name = "dashboard") => render(<Providers role={role}><Shell route={route(name)}><p>conteúdo</p></Shell></Providers>);

beforeEach(() => {
  sessionStorage.clear();
  installLocalStorage();
  document.documentElement.removeAttribute("data-theme");
  location.hash = "";
  installServer({});
});
afterEach(cleanup);

describe("navigation follows the profile", () => {
  it("a viewer sees no Usuários nor Auditoria; an administrator sees both, under their group", () => {
    mountShell("VIEWER");
    const nav = screen.getByRole("navigation", { name: "Principal" });
    expect(within(nav).queryByText("Usuários e acesso")).toBeNull();
    expect(within(nav).queryByText("Auditoria")).toBeNull();
    expect(within(nav).getByText("Sessões")).toBeTruthy();
    cleanup();
    mountShell("ADMIN");
    const admin = screen.getByRole("navigation", { name: "Principal" });
    expect(within(admin).getByText("Administração")).toBeTruthy();
    expect(within(admin).getByText("Auditoria")).toBeTruthy();
  });

  it("marks the current page and hides 'Como funciona' when the person switched it off (per browser)", () => {
    window.localStorage.setItem("sci.how", "off");
    mountShell("VIEWER", "sessions");
    const nav = screen.getByRole("navigation", { name: "Principal" });
    expect(within(nav).getByRole("link", { name: "Sessões" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).queryByText("Como funciona")).toBeNull();
  });

  it("a page the profile cannot open goes back to the dashboard (the server refuses it as well)", async () => {
    installServer({ "dashboard.summary": () => ({ quality: [], cost: [], runs: [], coverage: [], models: [] }), "dashboard.score": () => ({ rows: [] }) });
    location.hash = "#/users";
    render(<Providers role="VIEWER"><App /></Providers>);
    await waitFor(() => expect(location.hash).toBe("#/dashboard"));
    await screen.findByText("Painel", { selector: "h1" });
  });

  it("a screen that throws says so instead of leaving a blank page", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    installServer({ "dashboard.summary": () => ({}) }); // not the shape the screen needs
    location.hash = "#/dashboard";
    render(<Providers role="VIEWER"><App /></Providers>);
    await screen.findByText("Não foi possível exibir esta tela.");
    err.mockRestore();
  });
});

describe("workspace picker", () => {
  const two: Me = { ...meAs("VIEWER"), memberships: [{ organization_id: "o1", workspace_id: "w1", role: "VIEWER" }, { organization_id: "o2", workspace_id: "w2", role: "ADMIN" }] };
  function Probe() {
    const { tenant, role } = useSession();
    return <p data-testid="who">{`${tenant.organization_id}/${tenant.workspace_id}/${role}`}</p>;
  }
  const mountTwo = () =>
    render(
      <ToastProvider><ConfirmProvider><SessionProvider me={two}><Shell route={route("dashboard")}><Probe /></Shell></SessionProvider></ConfirmProvider></ToastProvider>,
    );

  it("with a single workspace there is no menu, only a label that says so", () => {
    mountShell("VIEWER");
    expect(screen.queryByRole("combobox", { name: "Workspace" })).toBeNull();
    expect(screen.getByLabelText("Workspace o / w (único com acesso)")).toBeTruthy();
  });

  it("with several, switching takes the tenant and the role of that membership and remembers the choice for the tab", async () => {
    mountTwo();
    expect(screen.getByTestId("who").textContent).toBe("o1/w1/VIEWER");
    fireEvent.change(screen.getByRole("combobox", { name: "Workspace" }), { target: { value: "1" } });
    await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("o2/w2/ADMIN"));
    expect(sessionStorage.getItem("sci.tenant")).toBe("1");
    expect(within(screen.getByRole("navigation", { name: "Principal" })).getByText("Auditoria")).toBeTruthy(); // the menu follows the new role
  });

  it("a remembered index that no longer exists falls back to the first workspace", () => {
    sessionStorage.setItem("sci.tenant", "7");
    mountTwo();
    expect(screen.getByTestId("who").textContent).toBe("o1/w1/VIEWER");
  });
});

describe("header search", () => {
  it("refuses an id that is not a session id and opens the session otherwise (clearing the field)", async () => {
    mountShell("VIEWER");
    const box = screen.getByLabelText("Buscar sessão por ID") as HTMLInputElement;
    box.value = "../etc";
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByText(/Informe um ID de sessão válido/);
    expect(location.hash).toBe("");
    box.value = " exemplo-001:t9 ";
    fireEvent.keyDown(box, { key: "Enter" });
    expect(location.hash).toBe("#/sessions/exemplo-001%3At9");
    expect(box.value).toBe("");
  });
});

describe("account menu", () => {
  const open = () => {
    const btn = screen.getByRole("button", { name: /Conta e perfil/ });
    fireEvent.click(btn);
    return { btn, dialog: screen.getByRole("dialog", { name: "Conta e perfil" }) };
  };

  it("is a dialog showing who is signed in, the role in this workspace and the domain, and closes with Escape giving the focus back", async () => {
    mountShell("EDITOR");
    const { btn, dialog } = open();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(within(dialog).getByText("ana@empresa.com")).toBeTruthy();
    expect(within(dialog).getByText("Conta Google do domínio empresa.com")).toBeTruthy();
    expect(within(dialog).getByText("Perfil neste workspace").parentElement?.textContent).toContain("Editor"); // the role sits beside the title
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(btn);
  });

  it("closes on a click outside it, but not on a click inside", async () => {
    mountShell("VIEWER");
    const { dialog } = open();
    fireEvent.mouseDown(dialog);
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("lists the capabilities in the menu itself: collapsed, with how many the profile has, ticking what it includes", () => {
    mountShell("EDITOR");
    const { dialog } = open();
    const toggle = within(dialog).getByRole("button", { name: /Funcionalidades disponíveis/ });
    const have = CAPABILITIES.filter((c) => c.min !== "ADMIN").length;
    expect(toggle.textContent).toContain(`${have} de ${CAPABILITIES.length}`);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const region = within(dialog).getByRole("region", { name: "Funcionalidades disponíveis" });
    expect(within(region).getAllByText("Incluídas no seu perfil")).toHaveLength(2); // Leitor and Editor groups
    expect(within(region).getByText("Requerem o perfil Administrador")).toBeTruthy();
  });

  it("the theme buttons pin the theme on the page and remember it; Automático lets the system decide again", () => {
    mountShell("VIEWER");
    const { dialog } = open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Escuro" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem("sci.theme")).toBe("dark");
    expect(within(dialog).getByRole("button", { name: "Escuro" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Automático" }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem("sci.theme")).toBeNull();
  });

  it("the 'Como funciona' switch hides the entry and leaves the page if it was open", async () => {
    location.hash = "#/how";
    mountShell("VIEWER", "how");
    const { dialog } = open();
    fireEvent.click(within(dialog).getByRole("switch", { name: "Mostrar “Como funciona”" }));
    await waitFor(() => expect(window.localStorage.getItem("sci.how")).toBe("off"));
    expect(location.hash).toBe("#/dashboard");
    expect(within(screen.getByRole("navigation", { name: "Principal" })).queryByText("Como funciona")).toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeNull(); // the menu stays open while an entry is toggled
  });

  it("signing out asks first and then ends the Google session, coming back to the console only at a real Apps Script address", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const url = "https://script.google.com/a/macros/j-nart.com/s/AKfy_1/exec";
    render(<Providers role="VIEWER"><Shell route={route("dashboard")}>x</Shell></Providers>);
    cleanup();
    render(
      <ToastProvider><ConfirmProvider><SessionProvider me={{ ...meAs("VIEWER"), app_url: url }}><Shell route={route("dashboard")}>x</Shell></SessionProvider></ConfirmProvider></ToastProvider>,
    );
    const { dialog } = open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Sair" }));
    const ask = await screen.findByRole("dialog", { name: "Sair da conta Google?" });
    expect(opened).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole("button", { name: "Sair" }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith(`https://accounts.google.com/Logout?continue=${encodeURIComponent(url)}`, "_top"));
    expect(logoutUrl("javascript:alert(1)")).toBe("https://accounts.google.com/Logout");
    opened.mockRestore();
  });

  it("the Google account page opens in a new tab without access to this one", () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    mountShell("VIEWER");
    const { dialog } = open();
    fireEvent.click(within(dialog).getByRole("button", { name: /Gerenciar Conta Google/ }));
    expect(opened).toHaveBeenCalledWith("https://myaccount.google.com/", "_blank", "noopener");
    opened.mockRestore();
  });
});

describe("avatar", () => {
  const GOOD = "https://lh3.googleusercontent.com/a/abc=s64-c";
  it("shows the initials, and the photo only from a Google host, never sending a referrer", () => {
    const { container } = render(<Avatar email="ana.souza@x.com" profile={{ name: null, photo_url: GOOD }} />);
    expect(container.textContent).toBe("AS");
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe(GOOD);
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });
  it("ignores a photo from any other host, or a script address", () => {
    for (const url of ["https://evil.example.com/a.png", "javascript:alert(1)", "http://lh3.googleusercontent.com/a.png"]) {
      const { container, unmount } = render(<Avatar email="ana@x.com" profile={{ name: null, photo_url: url }} />);
      expect(container.querySelector("img")).toBeNull();
      unmount();
    }
  });
  it("falls back to the initials when the image fails to load", async () => {
    const { container } = render(<Avatar email="ana@x.com" profile={{ name: null, photo_url: GOOD }} />);
    await act(async () => { fireEvent.error(container.querySelector("img") as HTMLImageElement); });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("A");
  });
});

describe("router", () => {
  it("catches a hash that changed between the first render and the subscription (a redirect on load)", async () => {
    const { render: plain } = await import("preact");
    const { useRoute } = await import("../../src/ui/app/router");
    const host = document.createElement("div");
    document.body.appendChild(host);
    function Probe() {
      return <p data-testid="route">{useRoute().name}</p>;
    }
    location.hash = "#/users";
    plain(<Probe />, host); // effects are deferred: not yet subscribed
    history.replaceState(null, "", "#/dashboard"); // changes the hash without a hashchange event, like one already fired
    await waitFor(() => expect(host.textContent).toBe("dashboard"));
    plain(null, host);
    host.remove();
  });

  it("opening a page the profile cannot see ends on the dashboard, not on a blank page", async () => {
    installServer({ "dashboard.summary": () => ({ quality: [], cost: [], runs: [], coverage: [], models: [] }), "dashboard.score": () => ({ rows: [] }) });
    location.hash = "#/audit";
    render(<Providers role="VIEWER"><App /></Providers>);
    await screen.findByText("Painel", { selector: "h1" });
    expect(location.hash).toBe("#/dashboard");
    location.hash = "#/nao-existe";
    await waitFor(() => expect(location.hash).toBe("#/dashboard"));
  });
});
