// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BareButton, Button, ChipButton, DisclosureButton, IconButton, StepButton, ToggleGroup } from "../../src/ui/components/Button";

afterEach(cleanup);

describe("Button", () => {
  it("loading shows a spinner, blocks the button and says it is busy", () => {
    const click = vi.fn();
    const { rerender } = render(<Button onClick={click}>Salvar</Button>);
    expect((screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(false);
    rerender(<Button loading onClick={click}>Salvar</Button>);
    const b = screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.querySelector(".animate-spin")).not.toBeNull();
    fireEvent.click(b);
    expect(click).not.toHaveBeenCalled();
  });

  it("is a plain button by default (it never submits a form by accident)", () => {
    render(<Button>Ok</Button>);
    expect(screen.getByRole("button", { name: "Ok" }).getAttribute("type")).toBe("button");
  });
});

describe("IconButton", () => {
  it("is named by its label, and the danger variant is red", () => {
    render(<IconButton icon="close" variant="danger" label="Remover" />);
    const b = screen.getByRole("button", { name: "Remover" });
    expect(b.getAttribute("title")).toBe("Remover");
    expect(b.className).toContain("text-bad");
  });
});

describe("ToggleGroup", () => {
  const OPTIONS = [["day", "Dia"], ["week", "Semana"], ["month", "Mês"]] as const;
  function T({ onPick = () => {} }: { onPick?: (v: string) => void }) {
    const [v, setV] = useState<string>("day");
    return <ToggleGroup label="Agrupar por" options={OPTIONS} value={v} onChange={(n) => (setV(n), onPick(n))} autofocus />;
  }

  it("is a named group of buttons, the chosen one pressed, and a click chooses another", () => {
    const picked = vi.fn();
    render(<T onPick={picked} />);
    expect(screen.getByRole("group", { name: "Agrupar por" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dia" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Mês" }));
    expect(picked).toHaveBeenCalledWith("month");
    expect(screen.getByRole("button", { name: "Mês" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Dia" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("marks the chosen option for a dialog's initial focus", () => {
    render(<T />);
    expect(screen.getByRole("button", { name: "Dia" }).hasAttribute("data-autofocus")).toBe(true);
    expect(screen.getByRole("button", { name: "Semana" }).hasAttribute("data-autofocus")).toBe(false);
  });

  it("works with numbers as values", () => {
    const picked = vi.fn();
    render(<ToggleGroup label="Velocidade" options={[[1, "1x"], [2, "2x"]]} value={1} onChange={picked} />);
    fireEvent.click(screen.getByRole("button", { name: "2x" }));
    expect(picked).toHaveBeenCalledWith(2);
  });
});

describe("ChipButton, DisclosureButton, StepButton, BareButton", () => {
  it("a chip is a button that reports its click", () => {
    const click = vi.fn();
    render(<ChipButton tone="warn" aria-label="Ver o critério" onClick={click}>needs</ChipButton>);
    fireEvent.click(screen.getByRole("button", { name: "Ver o critério" }));
    expect(click).toHaveBeenCalled();
  });

  it("a disclosure carries the state and the target of what it opens", () => {
    const toggle = vi.fn();
    const { rerender } = render(<DisclosureButton open={false} controls="body-1" onToggle={toggle}>Detalhes</DisclosureButton>);
    const b = screen.getByRole("button", { name: "Detalhes" });
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(b.getAttribute("aria-controls")).toBe("body-1");
    fireEvent.click(b);
    expect(toggle).toHaveBeenCalled();
    rerender(<DisclosureButton open controls="body-1" onToggle={toggle}>Detalhes</DisclosureButton>);
    expect(screen.getByRole("button", { name: "Detalhes" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("a step shows its number and marks the current one", () => {
    render(
      <div>
        <StepButton number={1} state="done">A conversa</StepButton>
        <StepButton number={2} state="current">A rubrica</StepButton>
        <StepButton number={3} state="todo">O cálculo</StepButton>
      </div>,
    );
    expect(screen.getByRole("button", { name: /A rubrica/ }).getAttribute("aria-current")).toBe("step");
    expect(screen.getByRole("button", { name: /A conversa/ }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("button", { name: "3 O cálculo" })).toBeTruthy();
  });

  it("a bare button gives its element to the screen and brings only the button behaviour", () => {
    let el: HTMLButtonElement | null = null;
    const click = vi.fn();
    render(<BareButton buttonRef={(e) => {
      el = e;
    }} class="custom" aria-label="Conta" onClick={click} />);
    const b = screen.getByRole("button", { name: "Conta" });
    expect(el).toBe(b);
    expect(b.className).toBe("custom");
    expect(b.getAttribute("type")).toBe("button");
    fireEvent.click(b);
    expect(click).toHaveBeenCalled();
  });
});
