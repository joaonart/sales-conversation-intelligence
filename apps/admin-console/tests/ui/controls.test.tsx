// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Checkbox, Radio, SearchField, Textarea } from "../../src/ui/components/Controls";
import { Field, Select } from "../../src/ui/components/Field";

afterEach(cleanup);

const LETTERS = ["Alfa", "Beta", "Charlie", "Delta"];
function Harness({ values = LETTERS, initial = "beta", onPick = () => {}, disabled = false }: { values?: string[]; initial?: string; onPick?: (v: string) => void; disabled?: boolean }) {
  const [v, setV] = useState(initial);
  return (
    <Field label="Letra">
      <Select value={v} disabled={disabled} onChange={(e) => (setV(e.currentTarget.value), onPick(e.currentTarget.value))}>
        {values.map((x) => (
          <option key={x} value={x.toLowerCase()}>{x}</option>
        ))}
      </Select>
    </Field>
  );
}
const combo = (): HTMLElement => screen.getByRole("combobox", { name: "Letra" });
const labels = (): string[] => screen.queryAllByRole("option").map((o) => o.textContent ?? "");

describe("Select (the combo of the console)", () => {
  it("shows the chosen label, is named by its Field label and keeps the value like a native select", () => {
    render(<Harness />);
    expect(combo().textContent).toBe("Beta");
    expect((combo() as HTMLButtonElement).value).toBe("beta"); // screens and tests read .value as with a native select
    expect(combo().getAttribute("aria-haspopup")).toBe("listbox");
    expect(combo().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens a listbox on click, marks the chosen option, and a click on another option changes the value and closes", () => {
    const picked = vi.fn();
    render(<Harness onPick={picked} />);
    fireEvent.click(combo());
    expect(combo().getAttribute("aria-expanded")).toBe("true");
    expect(labels()).toEqual(LETTERS);
    expect(screen.getByRole("option", { name: "Beta" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "Delta" }));
    expect(picked).toHaveBeenCalledWith("delta");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(combo().textContent).toBe("Delta");
    expect(document.activeElement).toBe(combo());
  });

  it("does not call onChange when the chosen option is picked again", () => {
    const picked = vi.fn();
    render(<Harness onPick={picked} />);
    fireEvent.click(combo());
    fireEvent.click(screen.getByRole("option", { name: "Beta" }));
    expect(picked).not.toHaveBeenCalled();
  });

  it("works from the keyboard: arrows open and move, Enter chooses, Escape closes without choosing, Home and End jump", () => {
    const picked = vi.fn();
    render(<Harness onPick={picked} />);
    fireEvent.keyDown(combo(), { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(combo(), { key: "ArrowDown" });
    fireEvent.keyDown(combo(), { key: "Enter" });
    expect(picked).toHaveBeenLastCalledWith("charlie");
    fireEvent.keyDown(combo(), { key: "Enter" });
    fireEvent.keyDown(combo(), { key: "End" });
    fireEvent.keyDown(combo(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(picked).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(combo(), { key: " " });
    fireEvent.keyDown(combo(), { key: "Home" });
    fireEvent.keyDown(combo(), { key: " " });
    expect(picked).toHaveBeenLastCalledWith("alfa");
    expect(combo().getAttribute("aria-activedescendant")).toBeNull(); // closed
  });

  it("Escape closes only the combo, not a dialog around it", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <Harness />
      </div>,
    );
    fireEvent.click(combo());
    fireEvent.keyDown(combo(), { key: "Escape" });
    expect(outer).not.toHaveBeenCalled();
  });

  it("typing a letter on the open list jumps to the option that starts with it; on the closed combo it moves the choice", () => {
    const picked = vi.fn();
    render(<Harness onPick={picked} />);
    fireEvent.click(combo());
    fireEvent.keyDown(combo(), { key: "d" });
    fireEvent.keyDown(combo(), { key: "Enter" });
    expect(picked).toHaveBeenLastCalledWith("delta");
    fireEvent.keyDown(combo(), { key: "a" });
    expect(picked).toHaveBeenLastCalledWith("alfa");
  });

  it("closes on a click outside, and a disabled combo never opens", () => {
    render(<Harness />);
    fireEvent.click(combo());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
    cleanup();
    render(<Harness disabled />);
    fireEvent.click(combo());
    fireEvent.keyDown(combo(), { key: "ArrowDown" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect((combo() as HTMLButtonElement).disabled).toBe(true);
  });

  it("the open panel is not inside the field's label (it would put every option in the field's name)", () => {
    render(<Harness />);
    fireEvent.click(combo());
    expect(screen.getByRole("listbox").closest("label")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Letra" })).toBeTruthy();
  });

  it("a long list has a search box that filters the options and says when nothing matches", () => {
    const many = Array.from({ length: 20 }, (_, i) => `Item ${i + 1}`);
    render(<Harness values={many} initial="item 1" />);
    fireEvent.click(combo());
    const search = screen.getByRole("textbox", { name: "Buscar na lista" });
    fireEvent.input(search, { target: { value: "item 2" } });
    expect(labels()).toEqual(["Item 2", "Item 20"]);
    fireEvent.input(search, { target: { value: "zzz" } });
    expect(screen.getByText("Nada encontrado")).toBeTruthy();
    fireEvent.input(search, { target: { value: "item 20" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(combo().textContent).toBe("Item 20");
  });

  it("a short list has no search box", () => {
    render(<Harness />);
    fireEvent.click(combo());
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("a disabled option cannot be chosen", () => {
    const picked = vi.fn();
    render(
      <Field label="Letra">
        <Select value="a" onChange={(e) => picked(e.currentTarget.value)}>
          <option value="a">A</option>
          <option value="b" disabled>B</option>
        </Select>
      </Field>,
    );
    fireEvent.click(combo());
    fireEvent.click(screen.getByRole("option", { name: "B" }));
    expect(picked).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeTruthy(); // still open: nothing was chosen
  });
});

describe("Field", () => {
  it("shows a hint, and an error (announced) in place of it", () => {
    const { rerender } = render(<Field label="Nome" hint="Como aparece na lista"><input /></Field>);
    expect(screen.getByText("Como aparece na lista")).toBeTruthy();
    rerender(<Field label="Nome" hint="Como aparece na lista" error="Informe o nome"><input /></Field>);
    expect(screen.getByRole("alert").textContent).toBe("Informe o nome");
    expect(screen.queryByText("Como aparece na lista")).toBeNull();
  });
});

describe("Checkbox, Radio, Textarea, SearchField", () => {
  it("a checkbox is a real checkbox named by its label, with an optional hint, and reports the new state", () => {
    const seen = vi.fn();
    function C() {
      const [on, setOn] = useState(false);
      return <Checkbox checked={on} onChange={(v) => (setOn(v), seen(v))} label="Guardar este prompt" hint="Fica salvo com versão" />;
    }
    render(<C />);
    const box = screen.getByRole("checkbox", { name: /Guardar este prompt/ }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText("Fica salvo com versão")).toBeTruthy();
    fireEvent.click(box);
    expect(seen).toHaveBeenLastCalledWith(true);
    expect(box.checked).toBe(true);
  });

  it("a disabled checkbox does not change", () => {
    const seen = vi.fn();
    render(<Checkbox checked={false} disabled onChange={seen} label="Fixo" />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Fixo" }));
    expect(seen).not.toHaveBeenCalled();
  });

  it("a radio is a real radio input in its group", () => {
    render(
      <div role="radiogroup" aria-label="Decisão">
        <label><Radio name="d" value="a" checked onChange={() => {}} />Concordo</label>
        <label><Radio name="d" value="b" checked={false} onChange={() => {}} />Discordo</label>
      </div>,
    );
    expect((screen.getByRole("radio", { name: "Concordo" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: "Discordo" }) as HTMLInputElement).checked).toBe(false);
  });

  it("a textarea passes its props through and shares the control look", () => {
    render(<Textarea aria-label="Justificativa" rows={4} maxLength={10} />);
    const t = screen.getByRole("textbox", { name: "Justificativa" }) as HTMLTextAreaElement;
    expect(Number(t.rows)).toBe(4);
    expect(t.maxLength).toBe(10);
    expect(t.className).toContain("border-line");
    expect(t.className).toContain("focus:border-primary");
  });

  it("the search field is a search box with a magnifier", () => {
    render(<SearchField aria-label="Buscar" placeholder="Buscar sessão" />);
    const i = screen.getByRole("searchbox", { name: "Buscar" }) as HTMLInputElement;
    expect(i.placeholder).toBe("Buscar sessão");
  });
});
