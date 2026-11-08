import type { ComponentChildren, JSX } from "preact";
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

export function Input({ class: className, ...rest }: JSX.HTMLAttributes<HTMLInputElement>) {
  return <input class={cx(CONTROL, className as string)} {...rest} />;
}

export function Select({ class: className, children, ...rest }: JSX.HTMLAttributes<HTMLSelectElement>) {
  return (
    <select class={cx(CONTROL, "pr-8", className as string)} {...rest}>
      {children}
    </select>
  );
}
