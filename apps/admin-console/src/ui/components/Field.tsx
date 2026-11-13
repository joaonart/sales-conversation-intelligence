import type { ComponentChildren, ComponentProps } from "preact";
import { cx } from "../lib/cx";

const CONTROL =
  "h-9 w-full min-w-0 rounded-control border border-line bg-surface px-3 text-sm text-fg placeholder:text-faint disabled:opacity-60";

/** A label above its control, the one layout every filter and form uses. */
export function Field({ label, children, class: className }: { label: string; children?: ComponentChildren; class?: string }) {
  return (
    <label class={cx("flex min-w-0 flex-col gap-1 text-xs font-medium text-muted", className)}>
      {label}
      {children}
    </label>
  );
}

export function Input({ class: className, ...rest }: ComponentProps<"input">) {
  return <input class={cx(CONTROL, className as string)} {...rest} />;
}

export function Select({ class: className, children, ...rest }: ComponentProps<"select">) {
  return (
    <select class={cx(CONTROL, "pr-8", className as string)} {...rest}>
      {children}
    </select>
  );
}

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
