// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PromptEstimate, PromptPreview, PromptSuggestionResult, SuggestionRequest } from "../../src/ui/lib/types";
import { PromptImprovementView } from "../../src/ui/views/PromptImprovementView";
import { installServer, Providers, type Call } from "./helpers";

afterEach(cleanup);
beforeEach(() => sessionStorage.clear());

const PROMPT = "Você é um agente de vendas de uma loja de calçados. Cumprimente o cliente pelo nome e descubra a necessidade.";
const PREVIEW: PromptPreview = {
  rubric: { rubric_id: "sales_quality", version: 5, name: "Qualidade comercial" }, period: { from: "2026-10-16", to: "2026-11-14" }, seller: null, weak_below: 60, min_sample: 30,
  sample: { analyses: 40, sessions: 38, avg_score: 61.2, approved: 20, rejected: 12, needs_review: 8 }, enough: true,
  criteria: [{ criterion_id: "needs", name: "Necessidade", weight: 25, required: true, minimum_score: 60, evaluations: 40, applicable: 36, avg_score: 44.4, weak_pct: 66.7, insufficient_pct: 5, not_applicable_pct: 5, below_minimum_pct: 66.7, points_lost: 15, answers: [{ answer: "none", n: 18 }], enough: true }],
};
const EST = (o: Partial<PromptEstimate> = {}): PromptEstimate => ({
  provider: "responses", model: "gpt-4o", validated: true, sample: { analyses: 40, sessions: 38 }, enough: true, prompt_chars: PROMPT.length, prompt_tokens: 28, aggregate_tokens: 600, system_tokens: 900,
  approx_input_tokens: 1528, approx_output_tokens: 850, estimate_low_usd: 0.00382, estimate_high_usd: 0.01232, max_cost_usd: 0.1, within_ceiling: true, notes: ["É uma única chamada à IA."], ...o,
});
const REQ = (o: Partial<SuggestionRequest> = {}): SuggestionRequest => ({
  request_id: "pir-1", status: "REQUESTED", rubric_id: "sales_quality", rubric_version: 5, period_from: "2026-10-16", period_to: "2026-11-14", seller_id: null, prompt_id: "pr-1", prompt_name: "Loja",
  retained: true, max_cost_usd: 0.1, estimate_low_usd: 0.004, estimate_high_usd: 0.012, actual_cost_usd: null, provider: "responses", model: "gpt-4o", requested_by: "ana@empresa.com",
  requested_at: "2026-11-16 12:00:00", changed_at: "2026-11-16 12:00:00", error: null, ...o,
});

const RESULT: PromptSuggestionResult = {
  request_id: "pir-2", status: "COMPLETED", requested_by: "ana@empresa.com", requested_at: "2026-11-16 12:00:00", model: "gpt-4o", version: "responses-suggestion-v1", input_tokens: 1700, output_tokens: 900,
  cost_usd: 0.01325, created_at: "2026-11-16 12:11:00", names: { needs: "Necessidade", greeting: "Saudação" },
  suggestions: {
    overall: "A necessidade do cliente é o ponto que mais custa pontos.", priorities: ["needs", "greeting"],
    criteria: [
      { criterion_id: "needs", diagnosis: "66,7% das avaliações são fracas.", changes: [{ kind: "ADD", text: "Pergunte o uso do calçado antes de oferecer." }, { kind: "CHANGE", text: "Troque 'Cumprimente' por 'Cumprimente e pergunte'." }, { kind: "REMOVE", text: "Apague 'ofereça o mais caro'." }] },
      { criterion_id: "greeting", diagnosis: "A saudação vai bem.", changes: [] },
    ],
  },
};

let calls: Call[];
const calledWith = (m: string) => calls.filter((c) => c.method === m);
/** What a call carried, without the workspace the client adds to every call. */
const sent = (m: string, k = 0): Record<string, unknown> => {
  const { tenant: _tenant, ...rest } = calledWith(m)[k]?.payload ?? {};
  return rest;
};
const server = (over: Record<string, (p: Record<string, unknown>) => unknown> = {}) =>
  installServer({
    "promptImprovement.rubrics": () => [{ rubric_id: "sales_quality", version: 5, name: "Qualidade comercial" }],
    "promptImprovement.sellers": () => [],
    "promptImprovement.preview": () => PREVIEW,
    "promptImprovement.models": () => ({
      models: [{ provider: "responses", model: "gpt-4o", label: "GPT-4o", validated: true, input_per_million: 2.5, output_per_million: 10, verified_on: "2026-10-31" }], default: "gpt-4o", min_chars: 20, max_chars: 20000, min_sample: 30, ceiling_usd: 1,
    }),
    "promptImprovement.prompts": () => [],
    "promptImprovement.requests": () => [],
    "promptImprovement.estimate": () => EST(),
    "promptImprovement.request": () => ({ request_id: "pir-9", status: "REQUESTED", prompt_id: "pr-9", prompt_version: 1, prompt_hash: "h", retained: false, estimate_high_usd: 0.012 }),
    "promptImprovement.cancel": () => ({ request_id: "pir-1", status: "CANCELLED", prompt_deleted: true }),
    "promptImprovement.result": () => RESULT,
    ...over,
  });
const mount = (role: "EDITOR" | "ADMIN" = "ADMIN") => render(<Providers role={role}><PromptImprovementView /></Providers>);
const box = () => screen.getByPlaceholderText("Cole aqui o prompt que o agente usa hoje") as HTMLTextAreaElement;
const nameField = () => screen.getByPlaceholderText("ex.: Agente de calçados") as HTMLInputElement;
const estimateButton = () => screen.getByRole("button", { name: "Estimar custo" }) as HTMLButtonElement;
const requestButton = () => screen.getByRole("button", { name: "Pedir sugestões..." }) as HTMLButtonElement;
const ready = async () => void (await screen.findByText("Pedir sugestões para o seu prompt", {}, { timeout: 5000 }));
const paste = (text = PROMPT) => fireEvent.input(box(), { target: { value: text } });
/** The estimate button waits for the list of models (the default one is the model of the call). */
const canEstimate = () => waitFor(() => expect(estimateButton().disabled).toBe(false));
const estimate = async () => {
  await canEstimate();
  fireEvent.click(estimateButton());
  await screen.findByText(/uma chamada · 40 análises na amostra/);
};

describe("the panel that asks for suggestions", () => {
  it("says what the AI receives (the prompt and the numbers, no conversation) and who writes the suggestions, and when", async () => {
    calls = server();
    mount();
    await ready();
    expect(screen.getByText(/Nenhum trecho de conversa é enviado\./)).toBeTruthy();
    expect(screen.getByText(/Quem as escreve é o worker sob demanda, que passa de tempos em tempos/)).toBeTruthy();
  });

  it("estimates only with a prompt of at least 20 characters, and shows the cost, the tokens and the notes; editing anything clears the estimate", async () => {
    calls = server();
    mount();
    await ready();
    expect(estimateButton().disabled).toBe(true);
    paste("curto");
    expect(estimateButton().disabled).toBe(true);
    expect(screen.getByText("Mínimo de 20 caracteres.")).toBeTruthy();
    paste();
    await canEstimate();
    await estimate();
    expect(sent("promptImprovement.estimate")).toEqual({ rubric_id: "sales_quality", version: 5, from: "2026-10-16", to: "2026-11-14", prompt: PROMPT, model: "gpt-4o", max_cost_usd: 0.1 });
    expect(document.body.textContent).toMatch(/Estimativa: de US\$\s0,00382 a US\$\s0,01232 \(máximo possível\) · teto US\$\s0,1/); // the amounts are in <strong>
    expect(screen.getByText(/cerca de 1\.528 tokens \(900 de regras fixas, 28 do seu prompt, 600 dos números\)/)).toBeTruthy();
    expect(screen.getByText("É uma única chamada à IA.")).toBeTruthy();
    paste(`${PROMPT} Nunca prometa prazo.`);
    expect(screen.queryByText(/uma chamada · 40 análises na amostra/)).toBeNull();
  });

  it("keeping the prompt needs a name; without keeping it the name is optional", async () => {
    calls = server();
    mount();
    await ready();
    paste();
    fireEvent.click(screen.getByRole("checkbox", { name: /Guardar este prompt para reutilizar/ }));
    expect(screen.getByText("Obrigatório para guardar.")).toBeTruthy();
    expect(estimateButton().disabled).toBe(true);
    fireEvent.input(nameField(), { target: { value: "Loja" } });
    expect(screen.queryByText("Obrigatório para guardar.")).toBeNull();
    await canEstimate();
  });

  it("an administrator asks after the estimate, confirms the ceiling, and the request goes with the confirmation; the list reloads", async () => {
    calls = server();
    mount();
    await ready();
    paste();
    expect(requestButton().disabled).toBe(true); // no estimate yet
    await estimate();
    expect(requestButton().disabled).toBe(false);
    fireEvent.click(requestButton());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Você autoriza gastar até/)).toBeTruthy();
    expect(within(dialog).getByText("US$ 0,10")).toBeTruthy();
    expect(within(dialog).getByText(/O prompt não fica guardado/)).toBeTruthy();
    expect(within(dialog).getByText(/escreve as sugestões na próxima passada/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Pedir sugestões" }));
    await waitFor(() => expect(calledWith("promptImprovement.request")).toHaveLength(1));
    expect(sent("promptImprovement.request")).toEqual({
      rubric_id: "sales_quality", version: 5, from: "2026-10-16", to: "2026-11-14", prompt: PROMPT, model: "gpt-4o", max_cost_usd: 0.1, retain: false, confirm: true,
    });
    await waitFor(() => expect(calledWith("promptImprovement.requests").length).toBeGreaterThan(1));
    await screen.findByText("Pedido registrado. O worker o pega na próxima passada.");
  });

  it("cancelling the dialog sends nothing", async () => {
    calls = server();
    mount();
    await ready();
    paste();
    await estimate();
    fireEvent.click(requestButton());
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calledWith("promptImprovement.request")).toHaveLength(0);
  });

  it("a kept prompt goes with its name, and the dialog says it is kept", async () => {
    calls = server();
    mount();
    await ready();
    paste();
    fireEvent.click(screen.getByRole("checkbox", { name: /Guardar este prompt para reutilizar/ }));
    fireEvent.input(nameField(), { target: { value: "  Loja de calçados " } });
    await estimate();
    fireEvent.click(requestButton());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/O prompt fica guardado como “ Loja de calçados ”/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Pedir sugestões" }));
    await waitFor(() => expect(calledWith("promptImprovement.request")).toHaveLength(1));
    expect(sent("promptImprovement.request")).toMatchObject({ retain: true, name: "Loja de calçados" });
  });

  it("a sample that is too thin, or a ceiling below the worst case, is said and the request stays closed", async () => {
    calls = server({ "promptImprovement.estimate": () => EST({ enough: false, sample: { analyses: 12, sessions: 12 } }) });
    mount();
    await ready();
    paste();
    await canEstimate();
    fireEvent.click(estimateButton());
    expect(await screen.findByText(/Só 12 análises neste recorte: o mínimo para sugerir mudanças é 30/)).toBeTruthy();
    expect(requestButton().disabled).toBe(true);
    cleanup();
    calls = server({ "promptImprovement.estimate": () => EST({ within_ceiling: false, estimate_high_usd: 0.35 }) });
    mount();
    await ready();
    paste();
    await estimate();
    expect(screen.getByText(/O teto de US\$ 0,10 é menor que a estimativa máxima de US\$ 0,35/)).toBeTruthy();
    expect(requestButton().disabled).toBe(true);
  });

  it("the server's refusal of the estimate or of the request is shown, never swallowed", async () => {
    calls = server({ "promptImprovement.estimate": () => { throw { code: "INVALID_INPUT", message: "O prompt precisa ter ao menos 20 caracteres." }; } });
    mount();
    await ready();
    paste();
    await canEstimate();
    fireEvent.click(estimateButton());
    expect(await screen.findByText("O prompt precisa ter ao menos 20 caracteres.")).toBeTruthy();
    cleanup();
    calls = server({ "promptImprovement.request": () => { throw { code: "CONFLICT", message: "Já existe um pedido igual aguardando." }; } });
    mount();
    await ready();
    paste();
    await estimate();
    fireEvent.click(requestButton());
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Pedir sugestões" }));
    expect(await screen.findByText("Já existe um pedido igual aguardando.")).toBeTruthy();
  });

  it("an editor can paste and estimate, but is told to ask an administrator; the list of requests is not even asked for", async () => {
    calls = server();
    mount("EDITOR");
    await ready();
    paste();
    await estimate();
    expect(screen.queryByRole("button", { name: "Pedir sugestões..." })).toBeNull();
    expect(screen.getByText(/Só um administrador autoriza o gasto/)).toBeTruthy();
    expect(calledWith("promptImprovement.requests")).toHaveLength(0);
  });

  it("opens a kept prompt: its text, its name and the 'kept' mark come from the server", async () => {
    calls = server({
      "promptImprovement.prompts": () => [{ prompt_id: "pr-1", name: "Loja", version: 3, versions: 3, created_by: "ana@empresa.com", created_at: "2026-11-10 14:00:00" }],
      "promptImprovement.prompt": () => ({ prompt_id: "pr-1", name: "Loja", version: 3, content: PROMPT }),
    });
    mount();
    await ready();
    const pickSaved = await screen.findByLabelText("Prompts guardados");
    fireEvent.click(pickSaved);
    fireEvent.click(document.querySelector<HTMLElement>('[role="option"][data-value="pr-1"]')!);
    await waitFor(() => expect(box().value).toBe(PROMPT));
    expect(sent("promptImprovement.prompt")).toEqual({ prompt_id: "pr-1" });
    expect(nameField().value).toBe("Loja");
    expect((screen.getByRole("checkbox", { name: /Guardar este prompt para reutilizar/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("the prompt being written survives a new search of the preview", async () => {
    calls = server();
    mount();
    await ready();
    paste();
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    await waitFor(() => expect(calledWith("promptImprovement.preview").length).toBeGreaterThan(1));
    await ready();
    expect(box().value).toBe(PROMPT);
  });
});

describe("the requests of an administrator", () => {
  it("lists them with status, ceiling, estimate and who asked; only a waiting one can be cancelled, after a confirmation", async () => {
    calls = server({ "promptImprovement.requests": () => [REQ(), REQ({ request_id: "pir-2", status: "COMPLETED", actual_cost_usd: 0.009 }), REQ({ request_id: "pir-3", status: "CANCELLED", prompt_name: null, retained: false })] });
    mount();
    const table = within(await screen.findByRole("table", { name: "Pedidos de sugestão para o prompt" }));
    const rows = table.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("sales_quality v5 · 2026-10-16 a 2026-11-14");
    expect(rows[0]!.textContent).toContain("ana@empresa.com");
    expect(within(rows[0]!).getByRole("button", { name: "Cancelar" })).toBeTruthy();
    expect(within(rows[1]!).queryByRole("button", { name: "Cancelar" })).toBeNull();
    expect(rows[1]!.textContent).toContain("US$ 0,009");
    expect(rows[2]!.textContent).toContain("(texto apagado)");
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Cancelar" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar o pedido" }));
    await waitFor(() => expect(calledWith("promptImprovement.cancel")).toHaveLength(1));
    expect(sent("promptImprovement.cancel")).toEqual({ request_id: "pir-1" });
    await screen.findByText("Pedido cancelado.");
  });

  it("says when there is none", async () => {
    calls = server();
    mount();
    expect(await screen.findByText("Nenhum pedido de sugestão ainda.")).toBeTruthy();
  });
});


describe("the suggestions a finished request produced", () => {
  const list = () => [REQ(), REQ({ request_id: "pir-2", status: "COMPLETED", actual_cost_usd: 0.01325 }), REQ({ request_id: "pir-3", status: "FAILED", error: "A IA não devolveu sugestões utilizáveis (Refusal). Se houve resposta, o custo foi registrado. Tente de novo." })];

  it("only a completed request can be opened, and a failed one says why in the list", async () => {
    calls = server({ "promptImprovement.requests": list });
    mount();
    const table = within(await screen.findByRole("table", { name: "Pedidos de sugestão para o prompt" }));
    const rows = table.getAllByRole("row").slice(1);
    expect(within(rows[0]!).queryByRole("button", { name: "Ver sugestões" })).toBeNull(); // still waiting
    expect(within(rows[1]!).getByRole("button", { name: "Ver sugestões" })).toBeTruthy();
    expect(within(rows[2]!).queryByRole("button", { name: "Ver sugestões" })).toBeNull();
    expect(rows[2]!.textContent).toContain("A IA não devolveu sugestões utilizáveis (Refusal)");
  });

  it("opens them: the overall point, the order of priority, the diagnosis and the changes of each criterion with their kind, the model, the tokens and the cost", async () => {
    calls = server({ "promptImprovement.requests": list });
    mount();
    const table = within(await screen.findByRole("table", { name: "Pedidos de sugestão para o prompt" }));
    fireEvent.click(table.getByRole("button", { name: "Ver sugestões" }));
    await screen.findByText("A necessidade do cliente é o ponto que mais custa pontos.");
    expect(sent("promptImprovement.result")).toEqual({ request_id: "pir-2" });
    expect(screen.getByText(/É correlação, não prova de causa/)).toBeTruthy();
    const priorities = within(screen.getByText("Ordem de prioridade").parentElement as HTMLElement);
    expect(priorities.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Necessidade", "Saudação"]); // names, not ids
    expect(screen.getByText("66,7% das avaliações são fracas.")).toBeTruthy();
    expect(screen.getByText("Pergunte o uso do calçado antes de oferecer.").previousElementSibling?.textContent).toBe("Adicionar");
    expect(screen.getByText("Troque 'Cumprimente' por 'Cumprimente e pergunte'.").previousElementSibling?.textContent).toBe("Trocar");
    expect(screen.getByText("Apague 'ofereça o mais caro'.").previousElementSibling?.textContent).toBe("Remover");
    expect(screen.getByText("Sem mudança sugerida para este critério.")).toBeTruthy();
    expect(document.body.textContent).toMatch(/gpt-4o · 1\.700 tokens de entrada e 900 de saída · US\$\s0,01325/);
    fireEvent.click(screen.getAllByRole("button", { name: "Fechar" }).find((b) => b.closest(".mb-4") && b.textContent === "Fechar")!);
  });

  it("closes them, and shows the server's refusal when they cannot be opened", async () => {
    calls = server({ "promptImprovement.requests": list, "promptImprovement.result": () => { throw { code: "NOT_FOUND", message: "Este pedido ainda não tem sugestões." }; } });
    mount();
    const table = within(await screen.findByRole("table", { name: "Pedidos de sugestão para o prompt" }));
    fireEvent.click(table.getByRole("button", { name: "Ver sugestões" }));
    expect(await screen.findByText("Este pedido ainda não tem sugestões.")).toBeTruthy();
    fireEvent.click(table.getByRole("button", { name: "Fechar" }));
    await waitFor(() => expect(screen.queryByText("Este pedido ainda não tem sugestões.")).toBeNull());
  });

  it("'Atualizar' asks for the list again (the worker passes every few minutes)", async () => {
    calls = server();
    mount();
    await screen.findByText("Nenhum pedido de sugestão ainda.");
    const before = calledWith("promptImprovement.requests").length;
    fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    await waitFor(() => expect(calledWith("promptImprovement.requests").length).toBe(before + 1));
  });

  it("an editor is not offered the list nor the suggestions", async () => {
    calls = server();
    mount("EDITOR");
    await ready();
    expect(screen.queryByRole("button", { name: "Atualizar" })).toBeNull();
    expect(calledWith("promptImprovement.result")).toHaveLength(0);
  });
});
