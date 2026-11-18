// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NAV } from "../../src/ui/lib/nav";
import type { PromptPreview } from "../../src/ui/lib/types";
import { PromptImprovementView } from "../../src/ui/views/PromptImprovementView";
import { installServer, Providers, pick, untilOffers, type Call } from "./helpers";

afterEach(cleanup);
beforeEach(() => sessionStorage.clear());

const criterion = (o: Partial<PromptPreview["criteria"][number]>): PromptPreview["criteria"][number] => ({
  criterion_id: "needs", name: "Necessidade", weight: 25, required: true, minimum_score: 60, evaluations: 40, applicable: 36, avg_score: 44.4, weak_pct: 66.7,
  insufficient_pct: 5, not_applicable_pct: 5, below_minimum_pct: 66.7, points_lost: 15, answers: [{ answer: "none", n: 18 }, { answer: "complete", n: 18 }], enough: true, ...o,
});
const PREVIEW = (o: Partial<PromptPreview> = {}): PromptPreview => ({
  rubric: { rubric_id: "sales_quality", version: 5, name: "Qualidade comercial" }, period: { from: "2026-10-16", to: "2026-11-14" }, seller: null, weak_below: 60, min_sample: 30,
  sample: { analyses: 40, sessions: 38, avg_score: 61.2, approved: 20, rejected: 12, needs_review: 8 }, enough: true,
  criteria: [criterion({}), criterion({ criterion_id: "greeting", name: "Saudação", weight: 10, required: false, minimum_score: null, applicable: 20, avg_score: 85, weak_pct: 5, below_minimum_pct: null, points_lost: 2, enough: false, answers: [] }), criterion({ criterion_id: "is_sales", name: "É uma conversa de venda?", weight: 0, required: false, minimum_score: null, weak_pct: null, below_minimum_pct: null, points_lost: 0, avg_score: 90 })],
  ...o,
});
const EXAMPLES = { kind: "weak", examples: [{ session_id: "s1", analysis_id: "a1", score: 20, answer: "none", evidence: [{ message_id: "m1", sender_type: "customer", excerpt: "Quanto custa? Meu e-mail é [EMAIL]" }] }], maskedNote: "CPF, CNPJ, e-mail e telefone são mascarados antes de aparecer aqui." };

let calls: Call[];
const calledWith = (m: string) => calls.filter((c) => c.method === m);
const server = (over: Record<string, (p: Record<string, unknown>) => unknown> = {}) =>
  installServer({
    "promptImprovement.rubrics": () => [{ rubric_id: "sales_quality", version: 5, name: "Qualidade comercial" }, { rubric_id: "sales_quality", version: 4, name: "Qualidade comercial" }],
    "promptImprovement.sellers": () => [{ seller_id: "v1", sessions: 12 }, { seller_id: "v2", sessions: 3 }],
    "promptImprovement.preview": () => PREVIEW(),
    "promptImprovement.examples": () => EXAMPLES,
    ...over,
  });
const mount = (role: "EDITOR" | "VIEWER" | "ADMIN" = "EDITOR") => render(<Providers role={role}><PromptImprovementView /></Providers>);

describe("the page is for EDITOR and ADMIN, in the Análise group", () => {
  it("is in the menu for an editor and above", () => {
    const item = NAV.find((n) => n.route === "prompt");
    expect(item).toMatchObject({ label: "Melhorar prompt", min: "EDITOR", group: "Análise" });
  });
});

describe("PromptImprovementView", () => {
  it("opens on the newest published version and shows its numbers, with a free-preview notice", async () => {
    calls = server();
    mount();
    await screen.findByText("Onde se perdem pontos");
    expect(calledWith("promptImprovement.preview")[0]?.payload).toMatchObject({ rubric_id: "sales_quality", version: 5 });
    expect(screen.getByText(/Os números vêm direto das análises já feitas/)).toBeTruthy();
    expect(screen.getByText(/não chamam a IA nem geram custo/)).toBeTruthy();
    expect(screen.getByText("Análises").nextElementSibling?.textContent).toBe("40");
  });

  it("lists the criteria in the order the server gives (most points lost first), with the gate marked and no quality numbers for it", async () => {
    calls = server();
    mount();
    const table = within(await screen.findByRole("table"));
    const names = table.getAllByRole("row").slice(1).map((r) => r.querySelector("strong")?.textContent);
    expect(names).toEqual(["(needs) Necessidade", "(greeting) Saudação", "(is_sales) É uma conversa de venda?"]); // the identifier comes first, in parentheses
    expect(table.getByText("não entra na nota")).toBeTruthy();
    expect(table.getByText("obrigatório · mín. 60")).toBeTruthy();
    expect(table.getAllByText("amostra pequena")).toHaveLength(1); // only the criterion with fewer than 30 applicable evaluations
    const needs = table.getAllByRole("row")[1] as HTMLElement;
    expect(needs.textContent).toContain("66,7%");
    expect(needs.textContent).toContain("none 50% · complete 50%");
    expect(within(table.getAllByRole("row")[3] as HTMLElement).getAllByText("—").length).toBeGreaterThan(2); // the gate
  });

  it("warns when the whole sample is small, and says it is empty (no table) when there is nothing in the period", async () => {
    calls = server({ "promptImprovement.preview": () => PREVIEW({ enough: false, sample: { analyses: 12, sessions: 12, avg_score: 50, approved: 5, rejected: 5, needs_review: 2 } }) });
    mount();
    expect(await screen.findByText(/Só 12 análises neste recorte/)).toBeTruthy();
    cleanup();
    calls = server({ "promptImprovement.preview": () => PREVIEW({ sample: { analyses: 0, sessions: 0, avg_score: null, approved: 0, rejected: 0, needs_review: 0 }, criteria: [] }) });
    mount();
    expect(await screen.findByText(/Nenhuma análise concluída de sales_quality v5 neste período/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says so when the workspace has no published rubric, without asking for a preview", async () => {
    calls = server({ "promptImprovement.rubrics": () => [] });
    mount();
    expect(await screen.findByText(/Nenhuma rubrica publicada neste workspace/)).toBeTruthy();
    expect(calledWith("promptImprovement.preview")).toHaveLength(0);
  });

  it("shows the error of the server instead of numbers", async () => {
    calls = server({ "promptImprovement.preview": () => { throw { code: "NOT_FOUND", message: "Rubrica publicada não encontrada neste workspace." }; } });
    mount();
    expect(await screen.findByText("Rubrica publicada não encontrada neste workspace.")).toBeTruthy();
  });

  it("changing the filters only fetches on Buscar, with the version, the period and the seller chosen", async () => {
    calls = server();
    mount();
    await screen.findByText("Onde se perdem pontos");
    const before = calledWith("promptImprovement.preview").length;
    await untilOffers(() => screen.getByLabelText("Vendedor"), "v1 (12)");
    pick(screen.getByLabelText("Rubrica"), "sales_quality@4");
    pick(screen.getByLabelText("Vendedor"), "v1");
    expect(calledWith("promptImprovement.preview")).toHaveLength(before); // nothing yet
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    await waitFor(() => expect(calledWith("promptImprovement.preview")).toHaveLength(before + 1));
    expect(calledWith("promptImprovement.preview").at(-1)?.payload).toMatchObject({ rubric_id: "sales_quality", version: 4, seller: "v1" });
  });

  it("Buscar with the same filters calculates again and shows the skeleton while it waits", async () => {
    calls = server();
    mount();
    await screen.findByText("Onde se perdem pontos");
    const before = calledWith("promptImprovement.preview").length;
    fireEvent.click(screen.getByRole("button", { name: "Buscar" })); // no filter was touched
    expect(screen.getAllByRole("status").some((r) => r.getAttribute("aria-busy") === "true")).toBe(true);
    await waitFor(() => expect(calledWith("promptImprovement.preview")).toHaveLength(before + 1));
    await screen.findByText("Onde se perdem pontos");
  });

  it("opens the examples of a criterion (worst first), masked, and switches to the best ones", async () => {
    calls = server();
    mount();
    const table = within(await screen.findByRole("table"));
    fireEvent.click(table.getAllByRole("button", { name: "Ver exemplos" })[0] as HTMLElement);
    expect(await screen.findByText("Exemplos de “Necessidade”")).toBeTruthy();
    await screen.findByText(/Meu e-mail é \[EMAIL\]/);
    expect(calledWith("promptImprovement.examples")[0]?.payload).toMatchObject({ criterion_id: "needs", kind: "weak", rubric_id: "sales_quality", version: 5 });
    expect(screen.getByText(/mascarados antes de aparecer aqui/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "s1" }).getAttribute("href")).toBe("#/sessions/s1");
    fireEvent.click(screen.getByRole("button", { name: "Melhores" }));
    await waitFor(() => expect(calledWith("promptImprovement.examples").at(-1)?.payload).toMatchObject({ kind: "good" }));
    expect(screen.getByRole("dialog", { name: "Exemplos de “Necessidade”" })).toBeTruthy(); // a window over the page, not a card below the table
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Fechar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Exemplos de “Necessidade”")).toBeNull();
    fireEvent.click(table.getAllByRole("button", { name: "Ver exemplos" })[0] as HTMLElement); // Escape closes it too
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a gate has no examples button (it measures no quality)", async () => {
    calls = server();
    mount();
    const rows = within(await screen.findByRole("table")).getAllByRole("row");
    expect(within(rows[3] as HTMLElement).queryByRole("button")).toBeNull();
  });

  it("an empty list of examples says why", async () => {
    calls = server({ "promptImprovement.examples": () => ({ kind: "weak", examples: [], maskedNote: "n" }) });
    mount();
    fireEvent.click((await screen.findAllByRole("button", { name: "Ver exemplos" }))[0] as HTMLElement);
    expect(await screen.findByText(/Nenhum caso abaixo de 60 neste recorte/)).toBeTruthy();
  });

  it("shows the skeleton while the numbers are fetched", async () => {
    calls = server();
    mount();
    // the first render, before any answer, is the skeleton: a busy status region
    expect(screen.getAllByRole("status").some((r) => r.getAttribute("aria-busy") === "true")).toBe(true);
    await screen.findByText("Onde se perdem pontos");
    expect(screen.queryByText("Carregando…")).toBeNull();
  });
});
