// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RubricsView } from "../../src/ui/views/RubricsView";
import { blankCriterion } from "../../src/ui/lib/rubricModel";
import type { Role, RubricDraftInput } from "../../src/ui/lib/types";
import { installServer, Providers, type Call } from "./helpers";

const policy = { minimum_approval_score: 70, missing_evidence_policy: "NEEDS_REVIEW" as const, max_analyses_per_session: null, max_input_tokens: null, monthly_budget_usd: null, min_messages: 0, min_customer_messages: 0, min_seller_messages: 0 };
const draftBody = (): RubricDraftInput => ({ name: "Qualidade", description: "", summary_prompt: "", policy, criteria: [{ ...blankCriterion(1).c, criterion_id: "greet", criterion_name: "Saudação" }] });
const header = (status: "DRAFT" | "PUBLISHED") => ({ rubric_id: "q", version: 2, name: "Qualidade", status, published_at: null, created_at: null, description: null });

let calls: Call[];
const mountEditor = (role: Role, status: "DRAFT" | "PUBLISHED", issues: Array<{ path: string; message: string }> = [], extra: Record<string, (p: Record<string, unknown>) => unknown> = {}) => {
  calls = installServer({
    "rubrics.get": () => ({ header: header(status), draft: draftBody(), etag: "e1", issues }),
    "rubrics.saveDraft": () => ({ etag: "e2", issues }),
    ...extra,
  });
  return render(
    <Providers role={role}>
      <RubricsView parts={["q", "2"]} />
    </Providers>,
  );
};
const count = (m: string) => calls.filter((c) => c.method === m).length;

describe("RubricEditor", () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.__sciDirty = null;
  });
  afterEach(cleanup);

  it("a published version is read-only and offers no actions", async () => {
    mountEditor("ADMIN", "PUBLISHED");
    await screen.findByText(/está publicada e é imutável/);
    expect((screen.getByDisplayValue("Qualidade") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Salvar rascunho/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Adicionar critério/ })).toBeNull();
  });

  it("a viewer cannot edit a draft either (the server also refuses)", async () => {
    mountEditor("VIEWER", "DRAFT");
    await screen.findByDisplayValue("Qualidade");
    expect((screen.getByDisplayValue("Qualidade") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Salvar rascunho/ })).toBeNull();
  });

  it("an editor can save but only an admin sees Publicar", async () => {
    mountEditor("EDITOR", "DRAFT");
    await screen.findByRole("button", { name: /Salvar rascunho/ });
    expect(screen.queryByRole("button", { name: /Publicar/ })).toBeNull();
    expect(screen.getByText("Somente administradores publicam.")).toBeTruthy();
  });

  it("editing marks the page dirty, saving sends the etag and the edited draft and clears it", async () => {
    mountEditor("ADMIN", "DRAFT");
    const name = (await screen.findByDisplayValue("Qualidade")) as HTMLInputElement;
    expect(window.__sciDirty?.()).toBe(false);
    fireEvent.input(name, { target: { value: "Qualidade 2" } });
    await waitFor(() => expect(window.__sciDirty?.()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /Salvar rascunho/ }));
    await waitFor(() => expect(count("rubrics.saveDraft")).toBe(1));
    const sent = calls.find((c) => c.method === "rubrics.saveDraft")!.payload as { etag: string; draft: RubricDraftInput };
    expect(sent.etag).toBe("e1");
    expect(sent.draft.name).toBe("Qualidade 2");
    await waitFor(() => expect(window.__sciDirty?.()).toBe(false));
  });

  it("publishing with pending issues never asks to confirm and never publishes", async () => {
    mountEditor("ADMIN", "DRAFT", [{ path: "criteria[0]", message: "Informe a pergunta" }]);
    await screen.findByText(/Pendências antes de publicar/);
    fireEvent.click(screen.getByRole("button", { name: /Publicar…/ }));
    await waitFor(() => expect(count("rubrics.saveDraft")).toBe(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(count("rubrics.publish")).toBe(0);
  });

  it("publishing asks first, then publishes with the saved etag and reloads", async () => {
    mountEditor("ADMIN", "DRAFT", [], { "rubrics.publish": () => ({ version: 2, criteria: 1 }) });
    await screen.findByDisplayValue("Qualidade");
    fireEvent.click(screen.getByRole("button", { name: /Publicar…/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("imutável");
    expect(count("rubrics.publish")).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Publicar" }));
    await waitFor(() => expect(count("rubrics.publish")).toBe(1));
    expect((calls.find((c) => c.method === "rubrics.publish")!.payload as { etag: string }).etag).toBe("e2");
    await waitFor(() => expect(count("rubrics.get")).toBe(2));
  });

  it("cancelling the publish dialog publishes nothing", async () => {
    mountEditor("ADMIN", "DRAFT");
    await screen.findByDisplayValue("Qualidade");
    fireEvent.click(screen.getByRole("button", { name: /Publicar…/ }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(count("rubrics.publish")).toBe(0);
  });

  it("a save conflict reloads the draft from the server", async () => {
    mountEditor("ADMIN", "DRAFT", [], { "rubrics.saveDraft": () => { throw { code: "CONFLICT", message: "alterado por outra pessoa" }; } });
    await screen.findByDisplayValue("Qualidade");
    fireEvent.click(screen.getByRole("button", { name: /Salvar rascunho/ }));
    await waitFor(() => expect(count("rubrics.get")).toBe(2));
    await screen.findByText("alterado por outra pessoa");
  });

  it("a required criterion can carry its own minimum: the field exists only while it is required, and turning 'Obrigatório' off clears it", async () => {
    mountEditor("ADMIN", "DRAFT");
    await screen.findByDisplayValue("Qualidade");
    expect(screen.queryByLabelText(/Nota mínima do critério/)).toBeNull(); // an optional criterion has no minimum to set
    const required = screen.getByRole("switch", { name: "Obrigatório", hidden: true });
    fireEvent.click(required);
    const field = (await screen.findByLabelText(/Nota mínima do critério/)) as HTMLInputElement;
    expect(field.value).toBe(""); // none until someone sets one: a low score does not reject by itself
    expect(screen.getByText(/Em branco, uma nota baixa neste critério não reprova por si só/)).toBeTruthy();
    fireEvent.change(field, { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar rascunho/ }));
    await waitFor(() => expect(count("rubrics.saveDraft")).toBe(1));
    const first = calls.find((c) => c.method === "rubrics.saveDraft")!.payload as { draft: RubricDraftInput };
    expect(first.draft.criteria[0]).toMatchObject({ required: true, minimum_score: 60 });
    expect(screen.getByText(/Obrigatório · mín\. 60/)).toBeTruthy(); // the card says it too
    fireEvent.click(screen.getByRole("switch", { name: "Obrigatório", hidden: true })); // no longer required: the minimum goes with it
    await waitFor(() => expect(screen.queryByLabelText(/Nota mínima do critério/)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Salvar rascunho/ }));
    await waitFor(() => expect(count("rubrics.saveDraft")).toBe(2));
    const second = calls.filter((c) => c.method === "rubrics.saveDraft")[1]!.payload as { draft: RubricDraftInput };
    expect(second.draft.criteria[0]).toMatchObject({ required: false, minimum_score: null });
  });

  it("emptying the field removes the minimum (none), and zero is kept as a real minimum", async () => {
    mountEditor("ADMIN", "DRAFT");
    await screen.findByDisplayValue("Qualidade");
    fireEvent.click(screen.getByRole("switch", { name: "Obrigatório", hidden: true }));
    const field = (await screen.findByLabelText(/Nota mínima do critério/)) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar rascunho/ }));
    await waitFor(() => expect(count("rubrics.saveDraft")).toBe(1));
    expect((calls[calls.length - 1]!.payload as { draft: RubricDraftInput }).draft.criteria[0]?.minimum_score).toBe(0);
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar rascunho/ }));
    await waitFor(() => expect(count("rubrics.saveDraft")).toBe(2));
    expect((calls[calls.length - 1]!.payload as { draft: RubricDraftInput }).draft.criteria[0]?.minimum_score).toBeNull();
  });

  it("a published version shows its minimum but cannot change it", async () => {
    const body = draftBody();
    calls = installServer({ "rubrics.get": () => ({ header: header("PUBLISHED"), draft: { ...body, criteria: [{ ...body.criteria[0]!, required: true, minimum_score: 60 }] }, etag: "e1", issues: [] }) });
    render(<Providers role="ADMIN"><RubricsView parts={["q", "2"]} /></Providers>);
    const field = (await screen.findByLabelText(/Nota mínima do critério/)) as HTMLInputElement;
    expect(field.value).toBe("60");
    expect(field.disabled).toBe(true);
  });

  it("adds and removes criteria, and the weight total follows the enabled ones", async () => {
    mountEditor("ADMIN", "DRAFT");
    await screen.findByText(/Soma dos pesos habilitados: 10/);
    fireEvent.click(screen.getByRole("button", { name: "Adicionar critério" }));
    await screen.findByText("Novo critério");
    await screen.findByText(/Soma dos pesos habilitados: 20/);
    fireEvent.click(screen.getByRole("button", { name: "Remover" }));
    await waitFor(() => expect(screen.queryByText("Novo critério")).toBeNull());
  });

  it("the general-evaluation prompt counts characters and fills the suggested text", async () => {
    mountEditor("ADMIN", "DRAFT");
    await screen.findByDisplayValue("Qualidade");
    fireEvent.click(screen.getByRole("tab", { name: "Avaliação geral" }));
    const area = screen.getByLabelText("Prompt da avaliação geral") as HTMLTextAreaElement;
    expect(screen.getByText(/0 \/ 4\.000 caracteres/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Usar o texto sugerido" }));
    await waitFor(() => expect(area.value).toContain("avaliação geral desta conversa"));
  });

  it("the tabs follow the arrow keys", async () => {
    mountEditor("ADMIN", "DRAFT");
    await screen.findByDisplayValue("Qualidade");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Critérios" }), { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Política" }).getAttribute("aria-selected")).toBe("true"));
  });
});

describe("RubricList", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(cleanup);
  const rows = [
    { rubric_id: "a", version: 2, name: "A", status: "DRAFT", published_at: null, created_at: null, description: null },
    { rubric_id: "a", version: 1, name: "A", status: "PUBLISHED", published_at: "2026-10-20T12:00:00Z", created_at: null, description: null },
    { rubric_id: "b", version: 1, name: "B", status: "PUBLISHED", published_at: null, created_at: null, description: null },
  ];
  const mount = (role: Role) => {
    calls = installServer({ "rubrics.list": () => ({ rows, nextCursor: null }), "rubrics.count": () => ({ total: 2 }) });
    return render(
      <Providers role={role}>
        <RubricsView parts={[]} />
      </Providers>,
    );
  };

  it("groups versions by rubric and counts rubrics, not versions", async () => {
    mount("ADMIN");
    await screen.findByText("rascunho v2");
    expect(screen.getAllByText("v1 publicada")).toHaveLength(2);
    await waitFor(() => expect(screen.getByLabelText(/Mostrando 1 a 2 de 2 rubricas/)).toBeTruthy());
  });

  it("offers a new revision only where there is a published version and no open draft", async () => {
    mount("EDITOR");
    await screen.findByText("rascunho v2");
    expect(screen.getAllByRole("button", { name: /Nova revisão a partir da v1/ })).toHaveLength(1); // rubric b only: a already has a draft
  });

  it("a viewer cannot create or revise", async () => {
    mount("VIEWER");
    await screen.findByText("rascunho v2");
    expect(screen.queryByRole("button", { name: /Nova rubrica/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Nova revisão/ })).toBeNull();
  });

  it("creating a draft sends the id and name and goes to the editor", async () => {
    mount("ADMIN");
    await screen.findByText("rascunho v2");
    calls = installServer({ "rubrics.list": () => ({ rows, nextCursor: null }), "rubrics.count": () => ({ total: 2 }), "rubrics.createDraft": () => ({ version: 1 }) });
    fireEvent.click(screen.getByRole("button", { name: /Nova rubrica/ }));
    fireEvent.input(await screen.findByPlaceholderText("ex.: qualidade_comercial"), { target: { value: " nova " } });
    fireEvent.input(screen.getByPlaceholderText("Nome"), { target: { value: "Nova" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar rascunho" }));
    await waitFor(() => expect(location.hash).toBe("#/rubrics/nova/1"));
    expect(calls.find((c) => c.method === "rubrics.createDraft")!.payload).toMatchObject({ rubric_id: "nova", name: "Nova" });
  });
});
