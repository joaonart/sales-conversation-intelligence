// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardView } from "../../src/ui/views/DashboardView";
import { HowView } from "../../src/ui/views/HowView";
import { RES_GROUPS } from "../../src/ui/lib/howData";
import type { Role } from "../../src/ui/lib/types";
import { installServer, Providers, type Call } from "./helpers";

let calls: Call[];
const count = (m: string) => calls.filter((c) => c.method === m).length;
const mount = (role: Role, ui: preact.ComponentChildren) => render(<Providers role={role}>{ui}</Providers>);

const detail = {
  session: { session_id: "s1" },
  messages: [{ message_id: "m1", sender_type: "customer", content: "Olá, quero comprar", created_at: "2026-10-28T12:00:00Z", sequence_number: 1 }],
  analyses: [{ analysis_id: "a1", rubric_id: "q", rubric_version: 1, analysis_status: "COMPLETED", approval_status: "APPROVED", approval_reason: null, overall_score: 80, model: "m1", prompt_version: "v1", estimated_cost_usd: 0.001, completed_at: null }],
  criteria: [{ analysis_id: "a1", criterion_id: "greet", applicability_status: "APPLICABLE", normalized_score: 80, criterion_weight: 10, evaluation_result: JSON.stringify({ answer: "good" }), evidence_message_ids: ["m1"], confidence: 0.9 }],
  decisions: [],
};
const rubric = { header: {}, etag: "e", issues: [], draft: { name: "Q", description: "", summary_prompt: "", criteria: [{ criterion_id: "greet", criterion_name: "Saudação", evaluation_type: "SCORE", weight: 10, required: true, enabled: true, applicability_rule: null }], policy: { minimum_approval_score: 70, missing_evidence_policy: "NEEDS_REVIEW" } } };
const server = () =>
  installServer({
    "pipeline.overview": () => ({ source: [{ sessions: 5 }], execVisible: [{ visible: false }] }),
    "sessions.list": () => ({ rows: [{ session_id: "s1", analysis_status: "COMPLETED", approval_status: "APPROVED", overall_score: 80 }, { session_id: "s0", analysis_status: null, approval_status: null, overall_score: null }], nextCursor: null }),
    "sessions.get": () => detail,
    "rubrics.get": () => rubric,
  });

describe("HowView", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("replays the latest analysed session and lists only analysed sessions to pick from", async () => {
    calls = server();
    mount("VIEWER", <HowView />);
    await screen.findByText(/1\. A conversa/);
    expect(screen.getByText("Olá, quero comprar")).toBeTruthy();
    expect(screen.queryByRole("option", { name: /^s0/ })).toBeNull();
    expect(count("pipeline.overview")).toBe(1);
    expect(count("sessions.get")).toBe(1); // it re-reads what is stored: no AI call exists in this screen
  });

  it("steps through the replay and shows the stored answers and the calculation", async () => {
    calls = server();
    mount("VIEWER", <HowView />);
    await screen.findByText(/1\. A conversa/);
    fireEvent.click(screen.getByRole("button", { name: "Próximo passo" }));
    await screen.findByText(/2\. A rubrica/);
    expect(screen.getByText("Saudação")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /A resposta da IA/ }));
    await screen.findByText(/3\. A resposta da IA/);
    expect(screen.getByText("good")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /O cálculo/ }));
    await screen.findByText(/Σ pesos aplicáveis/);
    expect(screen.getByText("ok")).toBeTruthy(); // the required criterion is above the minimum
    expect((screen.getByRole("button", { name: "Passo anterior" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("plays one step at a time and stops at the last one", async () => {
    calls = server();
    mount("VIEWER", <HowView />);
    await screen.findByText(/1\. A conversa/);
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Reproduzir" }));
    expect(screen.getByRole("button", { name: "Pausar" })).toBeTruthy();
    for (let i = 0; i < 5; i++) await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(screen.getByText(/6\. A revisão humana/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reproduzir de novo" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Próximo passo" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says so when a session has no analysis, instead of a blank replay", async () => {
    calls = installServer({ "pipeline.overview": () => ({}), "sessions.list": () => ({ rows: [{ session_id: "s1", analysis_status: "COMPLETED", approval_status: null, overall_score: null }], nextCursor: null }), "sessions.get": () => ({ ...detail, analyses: [] }) });
    mount("VIEWER", <HowView />);
    await screen.findByText("Esta sessão ainda não foi analisada.");
  });

  it("filters the resources, counts the lines on each tab and moves off a tab with no match", async () => {
    calls = server();
    mount("VIEWER", <HowView />);
    fireEvent.click(await screen.findByRole("tab", { name: "Recursos" }));
    const total = RES_GROUPS.reduce((n, g) => n + g.items.length, 0);
    await screen.findByText(new RegExp(`São ${total} recursos`));
    const tables = screen.getByRole("tab", { name: /Tabelas \(\d+\)/ });
    expect(tables.getAttribute("aria-selected")).toBe("true");
    fireEvent.input(screen.getByLabelText("Filtrar recursos"), { target: { value: "latest_session_analyses" } });
    await waitFor(() => expect(screen.getByRole("tab", { name: /Views \(1 de \d+\)/ }).getAttribute("aria-selected")).toBe("true"));
    expect(screen.getByRole("tab", { name: /Tabelas \(0 de \d+\)/ })).toBeTruthy();
    fireEvent.input(screen.getByLabelText("Filtrar recursos"), { target: { value: "zzzz-nada" } });
    await screen.findByText("Nenhum recurso corresponde ao filtro.");
  });

  it("lights up the component of the replay step and lists what a component receives and sends", async () => {
    calls = server();
    mount("VIEWER", <HowView />);
    await screen.findByText(/1\. A conversa/);
    fireEvent.click(screen.getByRole("tab", { name: "Arquitetura" }));
    const node = await screen.findByRole("button", { name: /Motor de avaliação/ });
    fireEvent.click(node);
    const info = await screen.findByText(/Recebe de:/);
    expect(info.parentElement?.textContent).toContain("Processamento histórico");
    expect(screen.getByText(/Envia para:/).parentElement?.textContent).toContain("Teto de custo");
  });
});

describe("DashboardView", () => {
  const summary = {
    quality: [{ sessions: 4, scored_sessions: 4, avg_score: 60, approved: 2, rejected: 1, needs_review: 1, not_evaluable: 0 }],
    cost: [], runs: [], coverage: [{ analysed: 3, sessions: 6 }],
    models: [{ provider: "decisions", model: "m1", analyses: 4, current_analyses: 4, cost_usd: 0.4, completed: 3 }],
  };
  beforeEach(() => sessionStorage.clear());
  afterEach(cleanup);

  it("shows reconciled numbers and reloads for another period keeping the chosen tab", async () => {
    calls = installServer({ "dashboard.summary": () => summary, "dashboard.score": () => ({ rows: [{ bucket: "2026-11-01", avg_score: 60 }] }) });
    mount("VIEWER", <DashboardView />);
    await screen.findByText("Nota média");
    expect(screen.getByText("de 6 sessões do workspace (50%)")).toBeTruthy();
    expect(screen.getByText("67%")).toBeTruthy(); // 2 approved of 3 decided
    fireEvent.click(screen.getByRole("tab", { name: "Custo por dia e modelo" }));
    fireEvent.change(screen.getByLabelText("Período"), { target: { value: "90" } });
    await waitFor(() => expect((calls.filter((c) => c.method === "dashboard.summary").at(-1)?.payload as { days: number }).days).toBe(90));
    await screen.findByText("Sem custo registrado.");
    expect(screen.getByRole("tab", { name: "Custo por dia e modelo" }).getAttribute("aria-selected")).toBe("true");
  });

  it("a number that is a doorway opens the list already filtered by the same period", async () => {
    calls = installServer({ "dashboard.summary": () => summary, "dashboard.score": () => ({ rows: [] }) });
    mount("VIEWER", <DashboardView />);
    fireEvent.click(await screen.findByRole("link", { name: /Em revisão/ }));
    expect(location.hash).toBe("#/review");
    const saved = JSON.parse(sessionStorage.getItem("sci.page.review") ?? "{}") as { page: number; filters: Record<string, string> };
    expect(saved.page).toBe(0);
    expect(saved.filters).toMatchObject({ filter: "all", reason: "", decision: "" });
    expect(saved.filters.from).toBeTruthy();
  });

  it("changing the grain asks the server for that grain", async () => {
    calls = installServer({ "dashboard.summary": () => summary, "dashboard.score": () => ({ rows: [] }) });
    mount("VIEWER", <DashboardView />);
    await screen.findByText("Nota média");
    fireEvent.click(screen.getByRole("button", { name: "Mês" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "dashboard.score").at(-1)?.payload).toMatchObject({ granularity: "month" }));
    await screen.findByText("Sem análises no período.");
  });
});
