// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analysedOf, badgeText, decisionValid, highlightOf, noEvidenceNote, reviewWhy, reviewable, type Cited } from "../../src/ui/lib/evidence";
import { SessionsView } from "../../src/ui/views/SessionsView";
import type { Role, SessionDetail } from "../../src/ui/lib/types";
import { installLocalStorage, installServer, Providers, type Call } from "./helpers";

const crit = (o: Record<string, unknown>) => ({ analysis_id: "a1", criterion_id: "c", criterion_name: null, applicability_status: "APPLICABLE", normalized_score: 100, criterion_weight: 10, weighted_score: null, evaluation_result: null, evidence_message_ids: [] as string[], confidence: null, ...o });
const analysis = (o: Record<string, unknown> = {}) => ({ analysis_id: "a1", rubric_id: "q", rubric_version: 1, analysis_status: "COMPLETED", approval_status: "APPROVED", approval_reason: null, overall_score: 100, model: "m", prompt_version: "v1", estimated_cost_usd: 0.001, completed_at: null, analysis_mode: "live", ...o });
const msgs = [
  { message_id: "m1", sender_type: "customer", content: "<script>alert(1)</script> quero", created_at: "2026-10-28T12:00:00Z", sequence_number: 1 },
  { message_id: "m2", sender_type: "seller", content: "Olá!", created_at: "2026-10-28T12:01:00Z", sequence_number: 2 },
];
const detail = (o: Partial<Record<string, unknown>> = {}): SessionDetail =>
  ({
    session: { session_id: "s1", channel: "whatsapp", started_at: null, status: "closed" },
    messages: msgs,
    analyses: [analysis()],
    criteria: [
      crit({ criterion_id: "greet", criterion_name: "Saudação", normalized_score: 100, criterion_weight: 10, evaluation_result: JSON.stringify({ answer: "good" }), evidence_message_ids: ["m2"] }),
      crit({ criterion_id: "gate", normalized_score: 100, criterion_weight: 0, evaluation_result: JSON.stringify({ answer: true }), evidence_message_ids: ["m1"] }),
    ],
    decisions: [],
    summaries: [],
    truncated: false,
    ...o,
  }) as unknown as SessionDetail;

describe("evidence lib", () => {
  const cited = (o: Partial<Cited>): Cited => ({ key: "k", id: "c", name: null, weight: 10, score: 100, contrib: 26.667, answer: { answer: "good" }, status: "APPLICABLE", rubric: null, ...o });
  it("a badge says the answer and its share of the grade; a weightless gate says only its answer", () => {
    expect(badgeText(cited({}))).toBe("good · +26,67");
    expect(badgeText(cited({ weight: 0, answer: { answer: true }, contrib: 0 }))).toBe("true");
    expect(badgeText(cited({ contrib: 0, answer: null }))).toBe("0");
    expect(badgeText(cited({ contrib: null, answer: null }))).toBeNull();
  });
  it("maps each message to the criteria that cite it, across analyses", () => {
    const h = highlightOf(detail());
    expect(Object.keys(h).sort()).toEqual(["m1", "m2"]);
    expect(h.m2?.[0]).toMatchObject({ id: "greet", name: "Saudação", rubric: null });
    expect(h.m2?.[0]?.contrib).toBeCloseTo(100);
  });
  it("explains why nothing is highlighted, by whether the evidence step ran", () => {
    const d = detail({ criteria: [crit({})] });
    expect(noEvidenceNote(d, 0)).toContain("não coletou evidências");
    expect(noEvidenceNote({ ...d, analyses: [analysis({ prompt_version: "v1;evidence=x" })] } as SessionDetail, 0)).toContain("rodou, mas não apontou");
    expect(noEvidenceNote(d, 2)).toBeNull();
    expect(noEvidenceNote(detail({ criteria: [] }), 0)).toBeNull();
  });
  it("lists analyses in review or already decided, and says why they came", () => {
    const d = detail({ analyses: [analysis({ analysis_id: "a1", analysis_status: "NEEDS_REVIEW" }), analysis({ analysis_id: "a2" }), analysis({ analysis_id: "a3" })], decisions: [{ analysis_id: "a3", decision: "CONFIRMED", reviewer_email: "r", decided_at: null, comment: null }] });
    expect(reviewable(d).map((x) => [x.analysis.analysis_id, x.decision?.decision])).toEqual([["a1", undefined], ["a3", "CONFIRMED"]]);
    expect(reviewWhy([])[0]).toContain("menos mensagens");
    expect(reviewWhy([crit({ applicability_status: "INSUFFICIENT_EVIDENCE", criterion_id: "x" })])[0]).toBe("Sem evidência suficiente em 1 de 1 critérios: x.");
    expect(reviewWhy([crit({})])[0]).toContain("incerta");
  });
  it("only confirming needs no justification", () => {
    expect(decisionValid(null, "")).toBe(false);
    expect(decisionValid("CONFIRMED", "")).toBe(true);
    expect(decisionValid("DISAGREED", "ab")).toBe(false);
    expect(decisionValid("DISAGREED", "  porque  ")).toBe(true);
    expect(analysedOf(detail())[0]?.breakdown?.matches).toBe(true);
  });
});

let calls: Call[];
const count = (m: string) => calls.filter((c) => c.method === m).length;
const last = (m: string) => calls.filter((c) => c.method === m).at(-1)?.payload as Record<string, unknown>;
const mount = (role: Role, parts: string[]) => render(<Providers role={role}><SessionsView parts={parts} /></Providers>);

describe("SessionsView list", () => {
  const rows = [
    { session_id: "s1", channel: "web", started_at: null, analysis_status: "COMPLETED", approval_status: "APPROVED", overall_score: 80, rubric_id: "q", rubric_version: 1 },
    { session_id: "s1", channel: "web", started_at: null, analysis_status: "COMPLETED", approval_status: "REJECTED", overall_score: 40, rubric_id: "z", rubric_version: 2 },
    { session_id: "s9", channel: "web", started_at: null, analysis_status: null, approval_status: null, overall_score: null, rubric_id: null, rubric_version: null },
  ];
  const server = () => installServer({ "sessions.list": () => ({ rows, nextCursor: null }), "sessions.count": () => ({ total: 3, sessions: 2 }), "sessions.channels": () => ["web", "voz"], "rubrics.ids": () => ["q", "z"] });
  beforeEach(() => sessionStorage.clear());
  afterEach(cleanup);

  it("one row per analysis; the pager says how many sessions are behind them when that differs", async () => {
    calls = server();
    mount("VIEWER", []);
    await screen.findAllByText("s1");
    expect(within(screen.getByRole("table")).getByText("Não analisada")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("(2 sessões)")).toBeTruthy());
    expect(screen.getByLabelText(/Mostrando 1 a 3 de 3 análises/)).toBeTruthy();
  });

  it("applies the filters only on Buscar and offers the channels and rubrics that exist", async () => {
    calls = server();
    mount("VIEWER", []);
    await screen.findAllByText("s1");
    await screen.findByRole("option", { name: "voz" });
    const before = count("sessions.list");
    fireEvent.change(screen.getByLabelText("Canal"), { target: { value: "voz" } });
    fireEvent.change(screen.getByLabelText("Resultado"), { target: { value: "REJECTED" } });
    expect(count("sessions.list")).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    await waitFor(() => expect(last("sessions.list")).toMatchObject({ channel: "voz", result: "REJECTED" }));
    expect(count("sessions.list")).toBe(before + 1);
  });
});

describe("SessionDetail", () => {
  beforeEach(() => {
    sessionStorage.clear();
    installLocalStorage();
  });
  afterEach(cleanup);
  const open = (role: Role, d: SessionDetail, extra: Record<string, (p: Record<string, unknown>) => unknown> = {}) => {
    calls = installServer({ "sessions.get": () => d, ...extra });
    return mount(role, ["s1"]);
  };

  it("says the content is masked and shows message text as text, never as markup", async () => {
    open("VIEWER", detail());
    await screen.findByText(/Conteúdo mascarado/);
    expect(screen.getByText(/<script>alert\(1\)<\/script> quero/)).toBeTruthy();
    expect(document.querySelector("script[src], main script")).toBeNull();
  });

  it("explains the grade: each criterion's share, the total and the formula", async () => {
    open("VIEWER", detail());
    await screen.findByText(/Nota final = Σ/);
    expect(screen.getByText("Total dos critérios que entram no cálculo")).toBeTruthy();
    expect(screen.getByText(/Peso 0 \(gate\)/)).toBeTruthy();
  });

  it("badges under a message name the criterion, can switch to the id, and the choice is remembered", async () => {
    open("VIEWER", detail());
    expect((await screen.findAllByLabelText("Critérios evidenciados nesta mensagem")).length).toBe(2); // one per cited message
    expect(screen.getAllByText("Saudação").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("switch", { name: "Nome do critério nas badges" }));
    await waitFor(() => expect(window.localStorage.getItem("sci.critnames")).toBe("id"));
    expect(screen.getAllByText("greet").length).toBeGreaterThan(0);
  });

  it("a badge jumps to the criterion row and a criterion's evidence jumps to the message", async () => {
    open("VIEWER", detail());
    await screen.findByText(/Nota final = Σ/);
    fireEvent.click(screen.getByRole("button", { name: /Ver o critério Saudação na lista de critérios/ }));
    await waitFor(() => expect(document.querySelectorAll("tr.flash").length).toBe(1));
    fireEvent.click(screen.getAllByRole("button", { name: /Ir para a mensagem #2/ })[0]!);
    await waitFor(() => expect(document.querySelectorAll("[role=log] .flash").length).toBe(1));
    // The highlight surrounds the bubble of the message, not the whole line of the chat (which spans the full width).
    const flashed = document.querySelector("[role=log] .flash") as HTMLElement;
    expect(flashed.classList.contains("rounded-card")).toBe(true);
    expect(flashed.textContent).toContain("Olá!");
    expect(flashed.parentElement?.classList.contains("flex")).toBe(true);
  });

  it("says why no message is highlighted when the evidence step was off", async () => {
    open("VIEWER", detail({ criteria: [crit({ criterion_id: "greet" })] }));
    await screen.findByText(/não coletou evidências/);
    expect(screen.queryByRole("switch", { name: "Nome do critério nas badges" })).toBeNull();
  });

  it("an unanalysed session says so", async () => {
    open("VIEWER", detail({ analyses: [], criteria: [] }));
    await screen.findAllByText("Sessão ainda não analisada.");
  });

  it("shows the general evaluation as text, with its sections and evidence links", async () => {
    const sm = { analysis_id: "a1", overall_summary: "Bom <b>atendimento</b>", strengths: JSON.stringify([{ text: "Cumprimentou", message_ids: ["m2"] }]), weaknesses: "[]", opportunities: JSON.stringify([{ text: "Oferecer upsell" }]), model: "gpt-x", summary_prompt_hash: "abcdef123456" };
    open("VIEWER", detail({ summaries: [sm] }));
    await screen.findByText("Bom <b>atendimento</b>");
    expect(screen.getByText("Cumprimentou")).toBeTruthy();
    expect(screen.getByText("Nenhum ponto identificado.")).toBeTruthy();
    expect(screen.getByText(/escrita por gpt-x · prompt abcdef12/)).toBeTruthy();
    expect(screen.getByText(/não entra no cálculo da nota/)).toBeTruthy();
  });

  describe("review", () => {
    const inReview = () => detail({ analyses: [analysis({ analysis_status: "NEEDS_REVIEW", approval_status: null })], criteria: [crit({ criterion_id: "x", applicability_status: "INSUFFICIENT_EVIDENCE", normalized_score: null })] });

    it("an editor needs a decision, and a justification unless confirming, then confirms in a dialog and records it", async () => {
      open("EDITOR", inReview(), { "review.decide": () => ({}) });
      const send = (await screen.findByRole("button", { name: "Registrar decisão" })) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      expect(screen.getByText("Escolha uma decisão para continuar.")).toBeTruthy();
      fireEvent.click(screen.getByRole("radio", { name: /Discordar do resultado/ }));
      expect(send.disabled).toBe(true);
      expect(screen.getByText(/pelo menos 3 caracteres/)).toBeTruthy();
      fireEvent.input(screen.getByLabelText("Justificativa"), { target: { value: "a nota está injusta" } });
      await waitFor(() => expect(send.disabled).toBe(false));
      fireEvent.click(send);
      const dialog = await screen.findByRole("dialog");
      expect(count("review.decide")).toBe(0);
      fireEvent.click(within(dialog).getByRole("button", { name: "Registrar decisão" }));
      await waitFor(() => expect(count("review.decide")).toBe(1));
      expect(last("review.decide")).toMatchObject({ sessionId: "s1", analysisId: "a1", decision: "DISAGREED", comment: "a nota está injusta" });
      await waitFor(() => expect(count("sessions.get")).toBe(2)); // reads the session again
    });

    it("confirming the result needs no justification", async () => {
      open("EDITOR", inReview());
      const send = (await screen.findByRole("button", { name: "Registrar decisão" })) as HTMLButtonElement;
      fireEvent.click(screen.getByRole("radio", { name: /Confirmar o resultado/ }));
      await waitFor(() => expect(send.disabled).toBe(false));
    });

    it("a viewer can read the review but not decide", async () => {
      open("VIEWER", inReview());
      await screen.findByText(/só Editor ou Administrador registra a decisão/);
      expect(screen.queryByRole("button", { name: "Registrar decisão" })).toBeNull();
      expect(screen.getByText(/Sem evidência suficiente em 1 de 1 critérios: x\./)).toBeTruthy();
    });

    it("a decided analysis shows who decided and why, and that the original did not change", async () => {
      const d = detail({ analyses: [analysis({ analysis_status: "NEEDS_REVIEW" })], decisions: [{ analysis_id: "a1", decision: "DISAGREED", reviewer_email: "rev@x.com", decided_at: null, comment: "injusto" }] });
      open("EDITOR", d);
      await screen.findByText("Discordar do resultado");
      expect(screen.getByText("injusto")).toBeTruthy();
      expect(screen.getByText(/A análise original não foi alterada/)).toBeTruthy();
      expect(screen.queryByRole("radio")).toBeNull();
    });

    it("skipping goes to the next waiting session, or back to the queue when there is none", async () => {
      open("EDITOR", inReview(), { "review.list": () => ({ rows: [{ session_id: "s1" }, { session_id: "s7" }], nextCursor: null }) });
      fireEvent.click(await screen.findByRole("button", { name: "Pular para a próxima" }));
      await waitFor(() => expect(location.hash).toBe("#/sessions/s7"));
      cleanup();
      open("EDITOR", inReview(), { "review.list": () => ({ rows: [{ session_id: "s1" }], nextCursor: null }) });
      fireEvent.click(await screen.findByRole("button", { name: "Pular para a próxima" }));
      await waitFor(() => expect(location.hash).toBe("#/review"));
    });
  });
});
