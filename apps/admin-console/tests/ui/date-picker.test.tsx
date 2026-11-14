// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatePicker } from "../../src/ui/components/DatePicker";
import { Field } from "../../src/ui/components/Field";

afterEach(cleanup);

function Harness({ initial = "2026-10-15", min, max, onPick = () => {} }: { initial?: string; min?: string; max?: string; onPick?: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <Field label="De">
      <DatePicker value={v} min={min} max={max} onChange={(e) => (setV(e.currentTarget.value), onPick(e.currentTarget.value))} />
    </Field>
  );
}
const field = (): HTMLInputElement => screen.getByRole("textbox", { name: "De" }) as HTMLInputElement;
const calendarButton = (): HTMLElement => screen.getByRole("button", { name: "Abrir calendário" });
const open = (): void => void fireEvent.click(calendarButton());
const day = (iso: string): HTMLElement => document.querySelector(`[data-day="${iso}"]`) as HTMLElement;

describe("DatePicker", () => {
  it("shows the date as dd/mm/aaaa and keeps the value as YYYY-MM-DD", () => {
    render(<Harness />);
    expect(field().value).toBe("15/10/2026");
    expect(field().placeholder).toBe("dd/mm/aaaa");
  });

  it("typing builds the mask and reports a date only when it is complete and real", () => {
    const picked = vi.fn();
    render(<Harness initial="" onPick={picked} />);
    fireEvent.input(field(), { target: { value: "0110" } });
    expect(field().value).toBe("01/10");
    expect(picked).not.toHaveBeenCalled();
    fireEvent.input(field(), { target: { value: "01102026" } });
    expect(field().value).toBe("01/10/2026");
    expect(picked).toHaveBeenLastCalledWith("2026-10-01");
    fireEvent.input(field(), { target: { value: "31022026" } }); // 31 Feb: not a date
    expect(picked).toHaveBeenCalledTimes(1);
  });

  it("an unfinished text goes back to the date that is set when the field loses focus; clearing it clears the value", async () => {
    const picked = vi.fn();
    render(<Harness onPick={picked} />);
    fireEvent.input(field(), { target: { value: "2" } });
    fireEvent.focusOut(field()); // (preact/compat wires onBlur to focusout, which is what a browser fires when the field loses focus)
    await waitFor(() => expect(field().value).toBe("15/10/2026"));
    fireEvent.input(field(), { target: { value: "" } });
    expect(picked).toHaveBeenLastCalledWith("");
  });

  it("opens a calendar on the month of the date, with the chosen day marked and today's ring", () => {
    render(<Harness />);
    open();
    expect(screen.getByRole("dialog", { name: "Escolher data" })).toBeTruthy();
    expect(screen.getByText("outubro de 2026")).toBeTruthy();
    expect(day("2026-10-15").getAttribute("aria-selected")).toBe("true");
    expect(day("2026-10-14").getAttribute("aria-selected")).toBe("false");
    expect(day("2026-10-15").getAttribute("aria-label")).toBe("15 de outubro de 2026");
    expect(document.querySelectorAll("[data-day]")).toHaveLength(42);
  });

  it("choosing a day sets it, closes the calendar and returns the focus to the field", () => {
    const picked = vi.fn();
    render(<Harness onPick={picked} />);
    open();
    fireEvent.click(day("2026-10-20"));
    expect(picked).toHaveBeenLastCalledWith("2026-10-20");
    expect(field().value).toBe("20/10/2026");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(field());
  });

  it("the month arrows change the month shown (a day of another month can be chosen)", () => {
    const picked = vi.fn();
    render(<Harness onPick={picked} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "Próximo mês" }));
    expect(screen.getByText("novembro de 2026")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mês anterior" }));
    fireEvent.click(screen.getByRole("button", { name: "Mês anterior" }));
    expect(screen.getByText("setembro de 2026")).toBeTruthy();
    fireEvent.click(day("2026-09-30"));
    expect(picked).toHaveBeenLastCalledWith("2026-09-30");
  });

  it("works from the keyboard: arrows move a day or a week, PageDown a month, Enter chooses, Escape closes", () => {
    const picked = vi.fn();
    render(<Harness onPick={picked} />);
    open();
    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(document.activeElement).toBe(day("2026-10-23"));
    fireEvent.keyDown(grid, { key: "PageDown" });
    expect(screen.getByText("novembro de 2026")).toBeTruthy();
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(picked).toHaveBeenLastCalledWith("2026-11-23");
    open();
    fireEvent.keyDown(grid.isConnected ? grid : screen.getByRole("grid"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(picked).toHaveBeenCalledTimes(1);
  });

  it("Escape closes only the calendar, not a dialog around it", () => {
    const outer = vi.fn();
    render(<div onKeyDown={outer}><Harness /></div>);
    open();
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Escape" });
    expect(outer).not.toHaveBeenCalled();
  });

  it("a day outside min and max cannot be chosen or typed", () => {
    const picked = vi.fn();
    render(<Harness min="2026-10-10" max="2026-10-20" onPick={picked} />);
    open();
    expect((day("2026-10-09") as HTMLButtonElement).disabled).toBe(true);
    expect((day("2026-10-21") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(day("2026-10-21"));
    expect(picked).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("grid"), { key: "PageDown" });
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Enter" });
    expect(picked).toHaveBeenLastCalledWith("2026-10-20"); // the keyboard stops at the limit
    fireEvent.input(field(), { target: { value: "25102026" } });
    expect(picked).toHaveBeenCalledTimes(1); // typed outside the range: not reported
  });

  it("'Hoje' picks today and 'Limpar' clears the date", () => {
    const picked = vi.fn();
    render(<Harness onPick={picked} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "Limpar" }));
    expect(picked).toHaveBeenLastCalledWith("");
    expect(field().value).toBe("");
    open();
    expect((screen.getByRole("button", { name: "Limpar" }) as HTMLButtonElement).disabled).toBe(true); // nothing to clear
    fireEvent.click(screen.getByRole("button", { name: "Hoje" }));
    expect(picked.mock.calls.at(-1)?.[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(field().value).not.toBe("");
  });

  it("closes on a press outside; Alt+ArrowDown opens it from the field; a disabled field never opens", () => {
    render(<Harness />);
    fireEvent.keyDown(field(), { key: "ArrowDown", altKey: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();
    render(<Field label="De"><DatePicker value="" disabled /></Field>);
    fireEvent.click(calendarButton());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(field().disabled).toBe(true);
  });

  it("the calendar is not inside the field's label (its days would become part of the field's name)", () => {
    render(<Harness />);
    open();
    expect(screen.getByRole("dialog").closest("label")).toBeNull();
    expect(screen.getByRole("textbox", { name: "De" })).toBeTruthy();
  });
});
