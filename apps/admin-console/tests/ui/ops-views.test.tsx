// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReviewView } from "../../src/ui/views/ReviewView";
import { RunsView } from "../../src/ui/views/RunsView";
import { UsersView } from "../../src/ui/views/UsersView";
import type { Role } from "../../src/ui/lib/types";
import { installServer, Providers, type Call } from "./helpers";

let calls: Call[];
const count = (m: string) => calls.filter((c) => c.method === m).length;
const last = (m: string) => calls.filter((c) => c.method === m).at(-1)?.payload as Record<string, unknown>;
const page = (rows: unknown[]) => ({ rows, nextCursor: null });
const mount = (role: Role, ui: preact.ComponentChildren) => render(<Providers role={role}>{ui}</Providers>);

describe("UsersView", () => {
  const users = [
    { email: "a@x.com", role: "ADMIN", status: "ACTIVE", changed_at: null, changed_by: null },
    { email: "b@x.com", role: "VIEWER", status: "DISABLED", changed_at: null, changed_by: "a@x.com" },
  ];
  beforeEach(() => sessionStorage.clear());
  afterEach(cleanup);

  it("lists users and changes a role or the status with the whole row", async () => {
    calls = installServer({ "users.list": () => page(users), "users.count": () => ({ total: 2 }), "users.upsert": () => ({}) });
    mount("ADMIN", <UsersView />);
    await screen.findByText("b@x.com");
    fireEvent.change(screen.getByLabelText("Papel de b@x.com"), { target: { value: "EDITOR" } });
    await waitFor(() => expect(count("users.upsert")).toBe(1));
    expect(last("users.upsert")).toMatchObject({ email: "b@x.com", role: "EDITOR", status: "DISABLED" });
    fireEvent.click(screen.getByRole("button", { name: "Reativar" }));
    await waitFor(() => expect(count("users.upsert")).toBe(2));
    expect(last("users.upsert")).toMatchObject({ email: "b@x.com", role: "VIEWER", status: "ACTIVE" });
    await waitFor(() => expect(count("users.list")).toBeGreaterThan(2)); // reloaded after each change
  });

  it("the grant dialog keeps itself open and shows the server's refusal", async () => {
    calls = installServer({ "users.list": () => page(users), "users.count": () => ({ total: 2 }), "users.upsert": () => { throw { code: "INVALID_INPUT", message: "Use o e-mail corporativo." }; } });
    mount("ADMIN", <UsersView />);
    await screen.findByText("b@x.com");
    fireEvent.click(screen.getByRole("button", { name: /Conceder acesso/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.input(within(dialog).getByLabelText("E-mail corporativo"), { target: { value: "x@gmail.com" } });
    fireEvent.submit(within(dialog).getByRole("button", { name: "Conceder acesso" }).closest("form")!);
    await within(dialog).findByText("Use o e-mail corporativo.");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(last("users.upsert")).toMatchObject({ email: "x@gmail.com", role: "VIEWER", status: "ACTIVE" });
  });
});

describe("ReviewView", () => {
  const rows = [
    { session_id: "s1", rubric_id: "q", rubric_version: 1, completed_at: null, decision: null, reviewer_email: null, decided_at: null, insufficient: 2, criteria: 5 },
    { session_id: "s2", rubric_id: "q", rubric_version: 1, completed_at: null, decision: "CONFIRMED", reviewer_email: "r@x.com", decided_at: null, insufficient: 0, criteria: 5 },
  ];
  const server = () => installServer({ "review.list": () => page(rows), "review.count": () => ({ total: 2 }), "review.facets": () => ({ rubrics: ["q"], reviewers: ["r@x.com"] }) });
  beforeEach(() => sessionStorage.clear());
  afterEach(cleanup);

  it("an editor sees Revisar on a pending item and Abrir on a decided one", async () => {
    calls = server();
    mount("EDITOR", <ReviewView />);
    await screen.findByText("s1");
    expect(screen.getByRole("link", { name: "Revisar" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Abrir" })).toBeTruthy();
    expect(last("review.list")).toMatchObject({ filter: "pending" });
  });

  it("a viewer can open but is told they cannot decide", async () => {
    calls = server();
    mount("VIEWER", <ReviewView />);
    await screen.findByText("s1");
    expect(screen.queryByRole("link", { name: "Revisar" })).toBeNull();
    expect(screen.getByText(/só Editor ou Administrador registra decisões/)).toBeTruthy();
  });

  it("choosing a decision moves the view to Decididas, and Buscar applies it", async () => {
    calls = server();
    mount("EDITOR", <ReviewView />);
    await screen.findByText("s1");
    const before = count("review.list");
    fireEvent.change(screen.getByLabelText("Decisão"), { target: { value: "DISAGREED" } });
    expect((screen.getByLabelText("Situação") as HTMLSelectElement).value).toBe("decided");
    expect(count("review.list")).toBe(before); // nothing is fetched until Buscar
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    await waitFor(() => expect(last("review.list")).toMatchObject({ filter: "decided", decision: "DISAGREED" }));
  });
});

describe("RunsView", () => {
  const runs = [{ run_id: "r1", processing_mode: "historical", run_status: "COMPLETED_WITH_FAILURES", rubric_id: "q", rubric_version: 1, sessions_total: 10, sessions_processed: 8, sessions_failed: 2, sessions_skipped: 0, actual_cost_usd: 0.1, estimated_cost_usd: 0.2, created_at: null, finished_at: null }];
  const reqs = [
    { request_id: "q1", kind: "ANALYSIS", status: "REQUESTED", params: null, result: null, error: null, max_cost_usd: 1, estimate_high_usd: 0.5, requested_by: "a@x.com", requested_at: null },
    { request_id: "q2", kind: "ANALYSIS", status: "COMPLETED", params: JSON.stringify({ schedule_id: "sc1" }), result: null, error: null, max_cost_usd: 1, estimate_high_usd: 0.5, requested_by: "a@x.com", requested_at: null },
  ];
  const base = {
    "runs.list": () => page(runs), "runs.count": () => ({ total: 1 }), "runs.facets": () => ({ statuses: ["COMPLETED"], modes: ["live"], rubrics: ["q"] }),
    "executions.list": () => page(reqs), "executions.facets": () => ({ statuses: [], kinds: [], rubrics: [], requesters: [] }), "executions.cancel": () => ({}),
    "executions.models": () => ({ models: [{ provider: "decisions", model: "m1", validated: true, input_per_million: 1, output_per_million: 2, verified_on: "" }], default: { provider: "decisions", model: "m1" } }),
    "rubrics.list": () => page([{ rubric_id: "q", version: 1, name: "Q", status: "PUBLISHED", published_at: null, created_at: null, description: null }]),
    "schedules.list": () => ({ rows: [{ schedule_id: "sc1", name: "Diária", status: "ACTIVE", frequency: "DAILY", weekday: null, hour_utc: 2, minute_utc: 0, rubric_id: "q", rubric_version: 1, window_days: 7, max_sessions: 100, only_routed: false, provider: "decisions", model: "m1", max_cost_usd: 0.1, next_run: null, last_request_id: null, last_status: null, last_requested_at: null }] }),
    "schedules.setStatus": () => ({}),
  };
  beforeEach(() => sessionStorage.clear());
  afterEach(cleanup);

  it("only administrators have requests and schedules: others see the history alone", async () => {
    calls = installServer(base);
    mount("EDITOR", <RunsView parts={[]} />);
    await screen.findByText("r1");
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("button", { name: /Nova execução/ })).toBeNull();
    expect(count("executions.list")).toBe(0);
    expect(count("schedules.list")).toBe(0);
  });

  it("an administrator cancels a request only after confirming, and only a waiting one has the button", async () => {
    calls = installServer(base);
    mount("ADMIN", <RunsView parts={[]} />);
    await screen.findByText("q1");
    expect(screen.getAllByRole("button", { name: "Cancelar" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    const dialog = await screen.findByRole("dialog");
    expect(count("executions.cancel")).toBe(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar execução" }));
    await waitFor(() => expect(count("executions.cancel")).toBe(1));
    expect(last("executions.cancel")).toMatchObject({ request_id: "q1" });
  });

  it("pausing a schedule asks first and sends the action", async () => {
    calls = installServer(base);
    mount("ADMIN", <RunsView parts={[]} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Agendas de execução" }));
    await screen.findByText("Diária");
    fireEvent.click(screen.getByRole("button", { name: "Pausar" }));
    const dialog = await screen.findByRole("dialog");
    expect(count("schedules.setStatus")).toBe(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Pausar" }));
    await waitFor(() => expect(count("schedules.setStatus")).toBe(1));
    expect(last("schedules.setStatus")).toMatchObject({ schedule_id: "sc1", action: "pause" });
  });

  it("the new-execution form estimates first and only then offers to request, never without confirming", async () => {
    const preview = { model: "m1", provider: "decisions", to_process: 3, sessions: 10, already: 7, approx_input_tokens: 100, estimate_low_usd: 0.01, estimate_high_usd: 0.02, max_cost_usd: 0.05, within_ceiling: true, notes: [] };
    calls = installServer({ ...base, "executions.preview": () => preview, "executions.request": () => ({}) });
    mount("ADMIN", <RunsView parts={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: /Nova execução/ }));
    await screen.findByText("Nova execução", { selector: "h2" });
    expect(screen.queryByRole("button", { name: /Pedir execução…/ })).toBeNull();
    await waitFor(() => expect((screen.getByRole("button", { name: "Estimar custo" }) as HTMLButtonElement).disabled).toBe(false)); // the default model arrived
    fireEvent.click(screen.getByRole("button", { name: "Estimar custo" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pedir execução…" }));
    const dialog = await screen.findByRole("dialog", { name: /Pedir execução: / });
    expect(count("executions.request")).toBe(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Pedir execução" }));
    await waitFor(() => expect(count("executions.request")).toBe(1));
    expect(last("executions.request")).toMatchObject({ kind: "ROUTING", model: "m1", provider: "decisions", confirm: true });
  });

  it("changing the request throws the old estimate away", async () => {
    const preview = { model: "m1", provider: "decisions", to_process: 3, sessions: 10, already: 7, approx_input_tokens: 100, estimate_low_usd: 0.01, estimate_high_usd: 0.02, max_cost_usd: 0.05, within_ceiling: true, notes: [] };
    calls = installServer({ ...base, "executions.preview": () => preview });
    mount("ADMIN", <RunsView parts={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: /Nova execução/ }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Estimar custo" }) as HTMLButtonElement).disabled).toBe(false)); // the default model arrived
    fireEvent.click(screen.getByRole("button", { name: "Estimar custo" }));
    await screen.findByRole("button", { name: "Pedir execução…" });
    fireEvent.input(screen.getByLabelText("Teto de custo (US$)"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Teto de custo (US$)"), { target: { value: "1" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Pedir execução…" })).toBeNull());
  });

  const preview = { model: "m1", provider: "decisions", to_process: 3, sessions: 10, already: 7, approx_input_tokens: 100, estimate_low_usd: 0.01, estimate_high_usd: 0.02, max_cost_usd: 0.05, within_ceiling: true, notes: [] };
  const modelReady = () => waitFor(() => expect((screen.getByRole("button", { name: "Estimar custo" }) as HTMLButtonElement).disabled).toBe(false)); // the default model arrived

  it("says where each request came from and filters by origin: manual, or one schedule", async () => {
    calls = installServer(base);
    mount("ADMIN", <RunsView parts={[]} />);
    await screen.findByText("q1");
    const table = () => within(screen.getAllByRole("table")[0] as HTMLElement);
    await waitFor(() => expect(table().getByText("Agenda: Diária")).toBeTruthy()); // q2 was made by schedule sc1, named from the schedules list
    expect(table().getByText("Manual")).toBeTruthy(); // q1 was asked for by a person
    const before = count("executions.list");
    expect(within(screen.getByLabelText("Origem")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Todas", "Manual", "Agenda: Diária"]);
    fireEvent.change(screen.getByLabelText("Origem"), { target: { value: "sc1" } });
    expect(count("executions.list")).toBe(before); // applied with Buscar, like every filter
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    await waitFor(() => expect(last("executions.list")).toMatchObject({ origin: "sc1" }));
  });

  it("one form makes a request ('Agora') or a schedule ('Repetir'): repeating fixes the type, asks for when and for the last N days", async () => {
    calls = installServer(base);
    mount("ADMIN", <RunsView parts={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: /Nova execução/ }));
    const form = within(await screen.findByRole("dialog", { name: "Nova execução" }));
    expect(form.getByRole("button", { name: "Agora" }).getAttribute("aria-pressed")).toBe("true");
    expect(form.queryByLabelText("Frequência")).toBeNull();
    expect(form.getByLabelText("De")).toBeTruthy();
    fireEvent.click(form.getByRole("button", { name: "Repetir" }));
    const kind = form.getByLabelText("Tipo de execução") as HTMLSelectElement;
    expect(kind.disabled).toBe(true);
    expect(kind.value).toBe("ANALYSIS");
    for (const l of ["Nome", "Frequência", "Hora (UTC)", "Minuto", "Janela (últimos N dias)", "Limite de sessões por execução", "Teto de custo por execução (US$)"]) expect(form.getByLabelText(l), l).toBeTruthy();
    expect(form.queryByLabelText("De")).toBeNull();
    fireEvent.change(form.getByLabelText("Frequência"), { target: { value: "WEEKLY" } });
    expect(form.getByLabelText("Dia da semana")).toBeTruthy();
    fireEvent.click(form.getByRole("button", { name: "Agora" }));
    expect((form.getByLabelText("Tipo de execução") as HTMLSelectElement).disabled).toBe(false); // back to a one-off request: every type is allowed
  });

  it("a schedule needs a name, is estimated over the window, and is only created after confirming (and goes to the Agendas tab)", async () => {
    calls = installServer({ ...base, "executions.preview": () => preview, "schedules.create": () => ({}) });
    mount("ADMIN", <RunsView parts={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: /Nova execução/ }));
    fireEvent.click(screen.getByRole("button", { name: "Repetir" }));
    expect((screen.getByRole("button", { name: "Estimar custo" }) as HTMLButtonElement).disabled).toBe(true); // no name yet
    fireEvent.input(screen.getByPlaceholderText("ex.: Vendas, todo dia"), { target: { value: "  Noturna " } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Estimar custo" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole("button", { name: "Criar agenda…" })).toBeNull(); // not before an estimate
    fireEvent.click(screen.getByRole("button", { name: "Estimar custo" }));
    fireEvent.click(await screen.findByRole("button", { name: "Criar agenda…" }));
    expect(last("executions.preview")).toMatchObject({ kind: "ANALYSIS", rubric_id: "q", rubric_version: 1 }); // the estimate is that of a request over the window as of today
    const dialog = await screen.findByRole("dialog", { name: "Criar agenda" });
    expect(dialog.textContent).toContain("em cada execução");
    expect(count("schedules.create")).toBe(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Criar agenda" }));
    await waitFor(() => expect(count("schedules.create")).toBe(1));
    expect(count("executions.request")).toBe(0); // a schedule is not a request: it makes them later, at the hour
    expect(last("schedules.create")).toMatchObject({ name: "Noturna", frequency: "DAILY", hour_utc: 2, minute_utc: 0, window_days: 7, rubric_id: "q", rubric_version: 1, model: "m1", provider: "decisions", confirm: true });
    await screen.findByRole("tab", { name: "Agendas de execução", selected: true });
  });

  it("'Nova execução' sits in the Execuções sob demanda tab, like 'Nova agenda' in the Agendas de execução tab, and opens a standard dialog", async () => {
    calls = installServer(base);
    mount("ADMIN", <RunsView parts={[]} />);
    const header = (await screen.findByRole("heading", { level: 1, name: "Execuções" })).parentElement as HTMLElement;
    expect(within(header).queryByRole("button", { name: /Nova execução/ })).toBeNull(); // not in the page header
    expect(header.textContent).toContain("Peça uma execução agora, agende execuções recorrentes e acompanhe o que já rodou"); // says what the three tabs do
    const panel = screen.getByRole("tabpanel", { name: "Execuções sob demanda" });
    const open = within(panel).getByRole("button", { name: /Nova execução/ });
    expect(screen.getAllByRole("tab").map((x) => x.textContent)).toEqual(["Execuções sob demanda", "Agendas de execução", "Histórico de execução"]);
    open.focus();
    fireEvent.click(open);
    const dialog = await screen.findByRole("dialog", { name: "Nova execução" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.body.classList.contains("overflow-hidden")).toBe(true); // the page behind does not scroll
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.classList.contains("overflow-hidden")).toBe(false);
    expect(document.activeElement).toBe(open); // the focus comes back to the button that opened it
    fireEvent.click(screen.getByRole("tab", { name: "Agendas de execução" }));
    expect(screen.queryByRole("button", { name: "Nova execução" })).toBeNull(); // the button belongs to the Pedidos tab only
    expect(screen.getByRole("button", { name: /Nova agenda/ })).toBeTruthy();
  });

  it("the confirmation opens on top of the form, and the page stays locked until both are closed", async () => {
    calls = installServer({ ...base, "executions.preview": () => preview });
    mount("ADMIN", <RunsView parts={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: /Nova execução/ }));
    await modelReady();
    fireEvent.click(screen.getByRole("button", { name: "Estimar custo" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pedir execução…" }));
    const ask = await screen.findByRole("dialog", { name: /Pedir execução: / });
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    fireEvent.keyDown(ask, { key: "Escape" }); // closes only the confirmation
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
    expect(document.body.classList.contains("overflow-hidden")).toBe(true);
    expect(screen.getByRole("dialog", { name: "Nova execução" })).toBeTruthy();
    expect(count("executions.request")).toBe(0);
  });

  it("the Agendas de execução tab filters by name, status, rubric, frequency and last run only on Buscar, says how many match, and clears", async () => {
    const sched = (o: Record<string, unknown>) => ({ schedule_id: "x", name: "Vendas", status: "ACTIVE", frequency: "DAILY", weekday: null, hour_utc: 2, minute_utc: 0, rubric_id: "q", rubric_version: 1, window_days: 7, max_sessions: 100, only_routed: false, provider: "decisions", model: "m1", max_cost_usd: 0.1, next_run: null, last_request_id: null, last_status: null, last_requested_at: null, ...o });
    const all = [
      sched({ schedule_id: "a", name: "Vendas, todo dia" }),
      sched({ schedule_id: "b", name: "Pós-venda semanal", status: "PAUSED", frequency: "WEEKLY", weekday: 0, rubric_id: "after", last_request_id: "r1", last_status: "FAILED" }),
    ];
    const archived = sched({ schedule_id: "c", name: "Antiga", status: "ARCHIVED" });
    calls = installServer({ ...base, "schedules.list": (p) => ({ rows: p.include_archived === true ? [...all, archived] : all }) });
    mount("ADMIN", <RunsView parts={[]} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Agendas de execução" }));
    const panel = () => within(screen.getByRole("tabpanel", { name: "Agendas de execução" }));
    await panel().findByText("Vendas, todo dia");
    expect(panel().getByText("Pós-venda semanal")).toBeTruthy();
    expect((panel().getByRole("button", { name: "Limpar filtros" }) as HTMLButtonElement).disabled).toBe(true);
    expect(panel().queryByText(/ de \d+ agendas/)).toBeNull();
    const apply = () => fireEvent.click(panel().getByRole("button", { name: "Buscar" }));
    // nothing is fetched again for a filter that only narrows what is loaded
    const fetched = count("schedules.list");
    fireEvent.input(panel().getByPlaceholderText("nome contém…"), { target: { value: "pós" } });
    expect(panel().getByText("Vendas, todo dia")).toBeTruthy(); // typing alone changes nothing
    expect((panel().getByRole("button", { name: "Limpar filtros" }) as HTMLButtonElement).disabled).toBe(false);
    apply();
    await waitFor(() => expect(panel().queryByText("Vendas, todo dia")).toBeNull());
    expect(panel().getByText("1 de 2 agendas")).toBeTruthy();
    fireEvent.input(panel().getByPlaceholderText("nome contém…"), { target: { value: "" } });
    fireEvent.change(panel().getByLabelText("Frequência"), { target: { value: "DAILY" } });
    apply();
    await waitFor(() => expect(panel().queryByText("Pós-venda semanal")).toBeNull());
    fireEvent.change(panel().getByLabelText("Frequência"), { target: { value: "" } });
    apply();
    fireEvent.change(panel().getByLabelText("Rubrica"), { target: { value: "after" } });
    apply();
    await waitFor(() => expect(panel().queryByText("Vendas, todo dia")).toBeNull());
    fireEvent.change(panel().getByLabelText("Rubrica"), { target: { value: "" } });
    apply();
    fireEvent.change(panel().getByLabelText("Última execução"), { target: { value: "NEVER" } });
    apply();
    await waitFor(() => expect(panel().queryByText("Pós-venda semanal")).toBeNull());
    fireEvent.change(panel().getByLabelText("Última execução"), { target: { value: "FAILED" } });
    apply();
    await waitFor(() => expect(panel().queryByText("Vendas, todo dia")).toBeNull());
    fireEvent.change(panel().getByLabelText("Frequência"), { target: { value: "DAILY" } });
    apply();
    await panel().findByText("Nenhuma agenda com estes filtros.");
    expect(count("schedules.list")).toBe(fetched);
    fireEvent.click(panel().getByRole("button", { name: "Limpar filtros" }));
    await panel().findByText("Vendas, todo dia");
    expect(panel().getByText("Pós-venda semanal")).toBeTruthy();
    // the archived ones are only fetched when asked for, and offer no action
    fireEvent.change(panel().getByLabelText("Status"), { target: { value: "ARCHIVED" } });
    apply();
    await panel().findByText("Antiga");
    expect(last("schedules.list")).toMatchObject({ include_archived: true });
    expect(panel().queryByText("Vendas, todo dia")).toBeNull();
    expect(panel().queryByRole("button", { name: /Pausar|Retomar|Arquivar/ })).toBeNull();
  });

  it("changing between Agora and Repetir throws the old estimate away", async () => {
    calls = installServer({ ...base, "executions.preview": () => preview });
    mount("ADMIN", <RunsView parts={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: /Nova execução/ }));
    await modelReady();
    fireEvent.click(screen.getByRole("button", { name: "Estimar custo" }));
    await screen.findByRole("button", { name: "Pedir execução…" });
    fireEvent.click(screen.getByRole("button", { name: "Repetir" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Pedir execução…" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Criar agenda…" })).toBeNull();
  });

  it("'Nova agenda' in the Agendas tab opens the same dialog already on Repetir", async () => {
    calls = installServer(base);
    mount("ADMIN", <RunsView parts={[]} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Agendas de execução" }));
    fireEvent.click(await screen.findByRole("button", { name: /Nova agenda/ }));
    const form = within(await screen.findByRole("dialog", { name: "Nova execução" }));
    expect(form.getByRole("button", { name: "Repetir" }).getAttribute("aria-pressed")).toBe("true");
    expect(form.getByLabelText("Frequência")).toBeTruthy();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("a run's page shows why sessions failed, with what to do", async () => {
    calls = installServer({
      "runs.get": () => ({ run: runs[0], failures: { available: true, total: 2, by_code: [{ error_code: "PROVIDER_QUOTA", n: 2 }] } }),
      "runs.sessions": () => ({ ...page([]), basis: "inferred" }),
      "runs.failures": () => page([{ session_id: "s9", stage: "EVALUATION", error_code: "PROVIDER_QUOTA", error_type: null, http_status: 429, provider_code: null, occurred_at: null }]),
    });
    mount("VIEWER", <RunsView parts={["r1"]} />);
    await screen.findByText("Por que falhou");
    expect(screen.getAllByText(/sem saldo/).length).toBeGreaterThan(0);
    await screen.findByText(/anterior ao registro da execução/);
    await screen.findByText("s9");
    expect(screen.getByText(/HTTP 429/)).toBeTruthy();
  });
});
