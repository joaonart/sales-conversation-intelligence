// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { afterEach, describe, expect, it } from "vitest";
import { NumberInput, parseDecimal } from "../../src/ui/components/Field";

afterEach(cleanup);

/** The field as a form uses it: the number lives in the form's state and goes back down. */
function Form({ start, nullable = false, min, max, step }: { start: number | null; nullable?: boolean; min?: number; max?: number; step?: number }) {
  const [v, setV] = useState<number | null>(start);
  return (
    <>
      <NumberInput aria-label="n" value={v} min={min} max={max} step={step} onValue={(n) => setV(n === null && !nullable ? 0 : n)} />
      <output data-testid="state">{v === null ? "null" : String(v)}</output>
    </>
  );
}
const field = () => screen.getByLabelText("n") as HTMLInputElement;
const type = (text: string) => fireEvent.input(field(), { target: { value: text } });
const leave = () =>
  act(() => {
    field().focus();
    field().blur();
  });
const state = () => screen.getByTestId("state").textContent;

describe("parseDecimal", () => {
  it("reads a comma or a dot, nothing for an empty text, and says 'not yet' for a text that is not a number so typing can go on", () => {
    expect(parseDecimal("0,08")).toBe(0.08);
    expect(parseDecimal("0.08")).toBe(0.08);
    expect(parseDecimal(" 12 ")).toBe(12);
    expect(parseDecimal(".5")).toBe(0.5);
    expect(parseDecimal("0,")).toBe(0);
    expect(parseDecimal("-3,5")).toBe(-3.5);
    expect(parseDecimal("")).toBeNull();
    for (const bad of ["-", ",", "abc", "1,2,3", "1e5", "--1", "0x10", "1 000"]) expect(parseDecimal(bad), bad).toBeUndefined();
  });
});

describe("NumberInput", () => {
  it("lets '0,08' be typed one character at a time: the text is kept, the number follows (the defect of the native field)", () => {
    render(<Form start={0.05} nullable />);
    for (const text of ["", "0", "0,", "0,0", "0,08"]) {
      type(text);
      expect(field().value).toBe(text);
    }
    expect(state()).toBe("0.08");
  });

  it("accepts a dot as well, and shows the comma once the field is left", () => {
    render(<Form start={1} />);
    type("0.4");
    expect(state()).toBe("0.4");
    leave();
    expect(field().value).toBe("0,4");
  });

  it("does not report a text that is not a number yet, and puts the last good value back on leaving", () => {
    render(<Form start={7} />);
    type("-");
    expect(field().value).toBe("-");
    expect(state()).toBe("7");
    leave();
    expect(field().value).toBe("7");
  });

  it("an empty field is null for a field that may be empty, and 0 for one that may not", () => {
    const { unmount } = render(<Form start={3} nullable />);
    type("");
    expect(state()).toBe("null");
    unmount();
    render(<Form start={3} />);
    type("");
    expect(state()).toBe("0");
  });

  it("shows a value that changes from outside, but keeps a draft that still says the same number", () => {
    const { rerender } = render(<NumberInput aria-label="n" value={1} onValue={() => {}} />);
    expect(field().value).toBe("1");
    rerender(<NumberInput aria-label="n" value={2.5} onValue={() => {}} />);
    expect(field().value).toBe("2,5");
    type("2,50");
    rerender(<NumberInput aria-label="n" value={2.5} onValue={() => {}} />);
    expect(field().value).toBe("2,50");
  });

  it("the arrows step by `step` inside min and max, without the float noise of 0.1 + 0.2", () => {
    render(<Form start={0.1} min={0} max={0.3} step={0.1} />);
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(state()).toBe("0.2");
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(state()).toBe("0.3"); // 0.1 + 0.1 + 0.1 would be 0.30000000000000004
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(state()).toBe("0.3"); // max
    for (let i = 0; i < 5; i++) fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(state()).toBe("0"); // min
  });

  it("is a text field for decimals: the on-screen keyboard shows digits and the comma", () => {
    render(<Form start={1} />);
    expect(field().getAttribute("inputmode")).toBe("decimal");
    expect(field().type).toBe("text");
  });
});
