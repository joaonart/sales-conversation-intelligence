import type { ComponentChildren, ComponentProps } from "preact";
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
