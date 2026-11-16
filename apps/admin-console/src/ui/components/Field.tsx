import type { ComponentChildren, ComponentProps } from "preact";
import { useEffect, useState } from "preact/hooks";
import { cx } from "../lib/cx";
import { CONTROL } from "./controlStyle";
import { Select } from "./Select";

/** A label above its control, the one layout every filter and form uses; `hint` explains the field, `error` replaces it in red (the control itself gets `aria-invalid` from the caller). */
export function Field({ label, children, class: className, hint, error }: { label: string; children?: ComponentChildren; class?: string; hint?: ComponentChildren; error?: ComponentChildren }) {
  return (
    <label class={cx("flex min-w-0 flex-col gap-1 text-xs font-medium text-muted", className)}>
      {label}
      {children}
      {error ? (
        <span role="alert" class="font-normal text-bad">
          {error}
        </span>
      ) : hint ? (
        <span class="font-normal">{hint}</span>
      ) : null}
    </label>
  );
}

export function Input({ class: className, ...rest }: ComponentProps<"input">) {
  return <input class={cx(CONTROL, className as string)} {...rest} />;
}

/** The number a text stands for: `null` for an empty one, `undefined` while it is not a number yet ("-", ","), so typing can go on. Comma or dot. */
export function parseDecimal(text: string): number | null | undefined {
  const t = text.trim().replace(",", ".");
  if (t === "") return null;
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

const show = (v: number | null): string => (v === null ? "" : String(v).replace(".", ","));
const round = (n: number): number => Number(n.toFixed(10));

/**
 * A number field that keeps what the person TYPED. A native number input reports "0," as 0 and the screen then rewrites it, so "0,08" could not be
 * typed; here the text is the field's own state and only a valid number is passed up (`null` when it is empty). The comma is the decimal mark shown,
 * a dot is accepted; the arrows step by `step` within `min` and `max`. The text goes back to the value's own form when the field loses focus.
 */
export function NumberInput({ value, onValue, min, max, step = 1, class: className, ...rest }: {
  value: number | null;
  onValue: (n: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
} & Omit<ComponentProps<"input">, "value" | "onInput" | "onChange" | "onBlur" | "onKeyDown" | "type" | "min" | "max" | "step">) {
  const [draft, setDraft] = useState(show(value));
  useEffect(() => {
    if (parseDecimal(draft) !== value) setDraft(show(value)); // the value changed from outside (a reset, a load); a draft that still says the same stays as typed
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const type = (text: string): void => {
    setDraft(text);
    const n = parseDecimal(text);
    if (n !== undefined) onValue(n);
  };
  return (
    <input
      class={cx(CONTROL, className as string)}
      type="text"
      inputMode="decimal"
      autocomplete="off"
      value={draft}
      onInput={(e) => type(e.currentTarget.value)}
      onChange={(e) => type(e.currentTarget.value)}
      onBlur={() => setDraft(show(value))}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        const next = round((parseDecimal(draft) ?? value ?? 0) + (e.key === "ArrowUp" ? step : -step));
        const n = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next));
        setDraft(show(n));
        onValue(n);
      }}
      {...rest}
    />
  );
}

export { Select };

interface FacetSelectProps {
  label: string;
  /** The label of the "no filter" option ("Todos", "Todas"). */
  first: string;
  value: string;
  values: string[];
  onChange: (v: string) => void;
  labelOf?: (v: string) => string;
}

/**
 * A filter whose options come from what exists in the period (so no option returns an empty list). The chosen value is always kept as an option,
 * even before the options arrive or when it is no longer among them.
 */
export function FacetSelect({ label, first, value, values, onChange, labelOf }: FacetSelectProps) {
  const all = value && !values.includes(value) ? [...values, value] : values;
  return (
    <Field label={label}>
      <Select value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        <option value="">{first}</option>
        {all.map((x) => (
          <option key={x} value={x} selected={x === value}>
            {labelOf ? labelOf(x) : x}
          </option>
        ))}
      </Select>
    </Field>
  );
}
