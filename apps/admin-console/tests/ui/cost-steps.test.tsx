// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CostLines } from "../../src/ui/components/CostLines";
import { addsUp, sortLines, stepLabel, totalOf } from "../../src/ui/lib/costSteps";
import type { CostLineRow } from "../../src/ui/lib/types";
import { DashboardView } from "../../src/ui/views/DashboardView";
import { Providers, installServer } from "./helpers";

afterEach(cleanup);

const line = (kind: string, model: string | null, cost: number, o: Partial<CostLineRow> = {}): CostLineRow => ({ kind, model, calls: 10, input_tokens: 1000, output_tokens: 100, cost_usd: cost, ...o });
const LINES = [line("SUMMARY", "gpt-4o-mini", 0.0005), line("ANALYSIS", "gpt-6-luna", 0.0003), line("EVIDENCE", "gpt-4o-mini", 0.0002)];

describe("cost steps (the words and the sums)", () => {
  it("names every step the ledger knows, and an unknown one by its own name", () => {
    expect(["ROUTING", "ANALYSIS", "EVIDENCE", "SUMMARY", "OTHER"].map(stepLabel)).toEqual(["Roteamento", "Análise", "Evidência", "Avaliação geral", "OTHER"]);
  });

  it("orders the steps as they happen, then by model; an unknown step goes last", () => {
    const sorted = sortLines([line("SUMMARY", "b", 1), line("OTHER", "a", 1), line("EVIDENCE", "x", 1), line("ANALYSIS", "z", 1), line("ANALYSIS", "a", 1), line("ROUTING", "r", 1)]);
    expect(sorted.map((l) => `${l.kind}:${l.model}`)).toEqual(["ROUTING:r", "ANALYSIS:a", "ANALYSIS:z", "EVIDENCE:x", "SUMMARY:b", "OTHER:a"]);
  });

  it("adds the lines up and says whether they match the recorded total (within a millionth of a dollar)", () => {
    expect(totalOf(LINES)).toBeCloseTo(0.001, 8);
    expect(totalOf([{ cost_usd: null }, { cost_usd: 0.5 }])).toBe(0.5);
    expect(addsUp(LINES, 0.001)).toBe(true);
    expect(addsUp(LINES, 0.0010004)).toBe(true);
    expect(addsUp(LINES, 0.0015)).toBe(false);
    expect(addsUp(LINES, null)).toBe(true); // nothing recorded to compare with
  });
});

describe("CostLines", () => {
  it("shows one line per step with its model, calls and tokens, in order, and a total", () => {
    render(<CostLines lines={LINES} recorded={0.001} />);
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    const text = rows.map((r) => r.textContent);
    expect(text[1]).toContain("Análise");
    expect(text[1]).toContain("gpt-6-luna");
    expect(text[2]).toContain("Evidência");
    expect(text[2]).toContain("gpt-4o-mini");
    expect(text[3]).toContain("Avaliação geral");
    expect(text[4]).toContain("Total");
    expect(text[4]).toContain("0,001"); // the sum of the three lines
    expect(screen.queryByText(/O total registrado na análise/)).toBeNull();
  });

  it("says so when the lines do not add up to the recorded total, instead of hiding the difference", () => {
    render(<CostLines lines={LINES} recorded={0.0015} />);
    expect(screen.getByText(/O total registrado na análise é/)).toBeTruthy();
  });

  it("with no lines it says why (an analysis from before the cost was recorded by step), or says nothing", () => {
    const { container, rerender } = render(<CostLines lines={[]} emptyNote="Sem detalhe" />);
    expect(container.textContent).toBe("Sem detalhe");
    rerender(<CostLines lines={[]} />);
    expect(container.textContent).toBe("");
  });

  it("explains each step in a tooltip", () => {
    render(<CostLines lines={LINES} />);
    expect(screen.getByText("Avaliação geral").getAttribute("title")).toMatch(/pontos fortes/);
    expect(screen.getByText("Evidência").getAttribute("title")).toMatch(/cita as mensagens/);
  });
});

describe("the Painel tab 'Custo por etapa'", () => {
  const summary = {
    quality: [{ sessions: 4, scored_sessions: 4, avg_score: 60, approved: 2, rejected: 1, needs_review: 1, not_evaluable: 0 }],
    cost: [], runs: [], coverage: [{ analysed: 3, sessions: 6 }],
    models: [{ provider: "decisions", model: "gpt-6-luna", analyses: 4, current_analyses: 4, cost_usd: 0.4, completed: 3 }],
    steps: [line("ANALYSIS", "gpt-6-luna", 0.0003, { calls: 40 }), line("EVIDENCE", "gpt-4o-mini", 0.0002, { calls: 40 }), line("SUMMARY", "gpt-4o-mini", 0.0005, { calls: 40 })],
  };
  beforeEach(() => sessionStorage.clear());

  it("lists what was paid by step and model (the evidence and the general evaluation to gpt-4o-mini), with each share and the total", async () => {
    installServer({ "dashboard.summary": () => summary, "dashboard.score": () => ({ rows: [] }) });
    render(<Providers role="VIEWER"><DashboardView /></Providers>);
    fireEvent.click(await screen.findByRole("tab", { name: "Custo por etapa" }));
    const table = await screen.findByRole("table", { name: "Custo por etapa e modelo" });
    const rows = within(table).getAllByRole("row").map((r) => r.textContent ?? "");
    expect(rows[1]).toContain("Análise");
    expect(rows[1]).toContain("gpt-6-luna");
    expect(rows[1]).toContain("30%"); // 0.0003 of 0.001 = 30% of the total
    expect(rows[2]).toContain("Evidência");
    expect(rows[2]).toContain("gpt-4o-mini");
    expect(rows[3]).toContain("Avaliação geral");
    expect(rows[3]).toContain("50%");
    expect(rows.at(-1)).toContain("Total");
    expect(screen.getByText(/antes de 16\/11\/2026 a evidência/)).toBeTruthy();
  });

  it("says there was no paid call when the ledger has none for the period", async () => {
    installServer({ "dashboard.summary": () => ({ ...summary, steps: [] }), "dashboard.score": () => ({ rows: [] }) });
    render(<Providers role="VIEWER"><DashboardView /></Providers>);
    fireEvent.click(await screen.findByRole("tab", { name: "Custo por etapa" }));
    await waitFor(() => expect(screen.getByText("Nenhuma chamada paga neste período.")).toBeTruthy());
  });
});
