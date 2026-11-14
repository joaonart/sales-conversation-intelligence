import type { ComponentChildren, ComponentProps } from "preact";
import { cx } from "../lib/cx";
import { CONTROL, CONTROL_BASE } from "./controlStyle";
import { Icon } from "./Icon";

/** A multi-line field with the look of every other control. */
export function Textarea({ class: className, ...rest }: ComponentProps<"textarea">) {
  return <textarea class={cx(CONTROL_BASE, "p-3", className as string)} {...rest} />;
}

const CHECK = "M5 12.5l4.5 4.5L19 7.5";

interface CheckboxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ComponentChildren;
  disabled?: boolean;
  /** Text under the label. */
  hint?: ComponentChildren;
  class?: string;
}

/** A real checkbox (the browser keeps the keyboard, the focus and the disabled state); only the box is drawn here. */
export function Checkbox({ checked, onChange, label, disabled, hint, class: className }: CheckboxProps) {
  return (
    <label class={cx("inline-flex items-start gap-3", disabled ? "opacity-60" : "cursor-pointer", className)}>
      <input type="checkbox" class="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border-2 border-faint bg-surface text-on-primary transition-colors peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary">
        <svg viewBox="0 0 24 24" class={cx("size-3.5", checked ? "opacity-100" : "opacity-0")} fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d={CHECK} />
        </svg>
      </span>
      <span>
        <span class="block">{label}</span>
        {hint ? <span class="block text-xs text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

/** A radio button, drawn like the Google Cloud one (a ring with a dot); still the browser's own input. */
export function Radio({ class: className, ...rest }: Omit<ComponentProps<"input">, "type">) {
  return (
    <input
      type="radio"
      class={cx(
        "size-4 shrink-0 cursor-pointer appearance-none rounded-full border-2 border-faint bg-surface transition-colors checked:border-[5px] checked:border-primary",
        "hover:border-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-default disabled:opacity-60",
        className as string,
      )}
      {...rest}
    />
  );
}

/** The search box of the header: a pill with a magnifier. */
export function SearchField({ class: className, inputClass, ...rest }: Omit<ComponentProps<"input">, "type" | "class"> & { class?: string; inputClass?: string }) {
  return (
    <div class={cx("relative min-w-0", className)}>
      <Icon name="search" size="sm" class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
      <input type="search" class={cx(CONTROL, "!rounded-full bg-surface-2 pr-3 pl-9", inputClass)} {...rest} />
    </div>
  );
}
