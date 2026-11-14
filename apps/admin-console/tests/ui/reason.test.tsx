// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { ReasonBlock, reasonItems } from "../../src/ui/components/ReasonBlock";

afterEach(cleanup);
const text = (a: { approval_reason: unknown }) => {
  const { container } = render(<ul>{reasonItems(a).map((x, i) => <li key={i}>{x}</li>)}</ul>);
  return container.textContent ?? "";
};

describe("why the engine decided what it decided", () => {
  it("renders every code the engine can persist, in words", () => {
    const reason = (code: string, extra: Record<string, unknown> = {}) => ({ approval_reason: { minimum: 70, overall: 53.3, reasons: [{ code, ...extra }] } });
    // a criterion with a minimum of its own: it is judged by THAT number, and the sentence says which one it fell below
    expect(text(reason("REQUIRED_CRITERION_BELOW_MINIMUM", { criterion_id: "needs", score: 50, minimum: 60 }))).toBe(
      "Critério obrigatório needs obteve 50, abaixo da nota mínima do critério (60). Reprova mesmo com a nota geral acima do mínimo de 70.",
    );
    // an analysis scored before criteria had a minimum of their own (no `minimum` in the stored reason): the rule of the time is said as it was
    expect(text(reason("REQUIRED_CRITERION_BELOW_MINIMUM", { criterion_id: "needs", score: 0 }))).toBe(
      "Critério obrigatório needs obteve 0, abaixo da nota mínima da rubrica (70), que na época também valia para os critérios obrigatórios.",
    );
    expect(text(reason("OVERALL_BELOW_MINIMUM"))).toBe("Nota geral 53,3 abaixo do mínimo de 70.");
    expect(text(reason("MEETS_MINIMUM"))).toBe("Nota geral 53,3 atinge o mínimo de 70 e nenhum critério obrigatório ficou abaixo do próprio mínimo.");
    expect(text(reason("INSUFFICIENT_EVIDENCE", { criterion_id: "x", required: true }))).toBe("Sem evidência suficiente no critério x (obrigatório).");
    expect(text(reason("NO_APPLICABLE_CRITERIA"))).toContain("Nenhum critério da rubrica se aplica");
  });
  it("accepts the reason as stored text, ignores an unknown code and says nothing when there is none", () => {
    expect(text({ approval_reason: JSON.stringify({ minimum: 70, overall: 80, reasons: [{ code: "MEETS_MINIMUM" }, { code: "FUTURE_CODE" }] }) })).toContain("atinge o mínimo");
    expect(reasonItems({ approval_reason: { reasons: [{ code: "FUTURE_CODE" }] } })).toEqual([]);
    expect(reasonItems({ approval_reason: "not json" })).toEqual([]);
    expect(reasonItems(null)).toEqual([]);
    const { container } = render(<ReasonBlock a={{ approval_reason: null }} />);
    expect(container.textContent).toBe("");
  });
  it("a criterion id from stored data is text, never markup", () => {
    const { container } = render(<ReasonBlock a={{ approval_reason: { minimum: 1, reasons: [{ code: "INSUFFICIENT_EVIDENCE", criterion_id: "<img src=x onerror=alert(1)>" }] } }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
