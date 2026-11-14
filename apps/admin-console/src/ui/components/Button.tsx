import type { ComponentChildren, JSX, Ref } from "preact";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";
import type { IconName } from "./icons";

const VARIANT = {
  primary: "bg-primary text-on-primary hover:bg-primary-hover border-transparent",
  secondary: "bg-surface text-fg border-line hover:bg-surface-2",
  text: "bg-transparent text-primary border-transparent hover:bg-primary-soft",
  danger: "bg-surface text-bad border-line hover:bg-bad-soft",
} as const;

interface ButtonProps extends Omit<JSX.HTMLAttributes<HTMLButtonElement>, "size"> {
  variant?: keyof typeof VARIANT;
  small?: boolean;
  icon?: IconName;
  children?: ComponentChildren;
  type?: "button" | "submit";
  disabled?: boolean;
  /** Shows a spinner and blocks the button while something it started is running. */
  loading?: boolean;
}

const SPINNER = "size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent";

export function Button({ variant = "secondary", small, icon, children, class: className, type = "button", loading, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      class={cx(
        "inline-flex items-center justify-center gap-2 rounded-control border font-medium whitespace-nowrap transition-colors",
        "disabled:cursor-default disabled:opacity-50",
        small ? "h-8 px-3 text-compact" : "h-9 px-4",
        VARIANT[variant],
        className as string,
      )}
      {...rest}
    >
      {loading ? <span class={SPINNER} aria-hidden="true" /> : icon ? <Icon name={icon} size="sm" /> : null}
      {children}
    </button>
  );
}

const ICON_VARIANT = {
  plain: "rounded-control text-muted hover:bg-surface-2 hover:text-fg",
  outlined: "rounded-control border border-line text-muted hover:bg-surface-2 hover:text-fg",
  danger: "rounded-control border border-line text-bad hover:bg-bad-soft",
} as const;

interface IconButtonProps extends Omit<JSX.HTMLAttributes<HTMLButtonElement>, "size"> {
  icon: IconName;
  label: string;
  disabled?: boolean;
  pressed?: boolean;
  variant?: keyof typeof ICON_VARIANT;
}

/** A button with only an icon: the label is mandatory, because it is the only name a screen reader gets. */
export function IconButton({ icon, label, class: className, pressed, variant = "plain", ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      class={cx("inline-flex size-9 items-center justify-center transition-colors disabled:cursor-default disabled:opacity-40", ICON_VARIANT[variant], className as string)}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}

interface ToggleGroupProps<T extends string | number> {
  /** [value, label] pairs. */
  options: ReadonlyArray<readonly [T, string]>;
  value: T;
  onChange: (next: T) => void;
  /** Names the group for a screen reader. */
  label: string;
  /** `md` is as tall as a button; `sm` as a small one. */
  size?: "sm" | "md";
  /** The options share the width of the group. */
  grow?: boolean;
  /** Puts the focus on the chosen option when a dialog opens (the dialog looks for `data-autofocus`). */
  autofocus?: boolean;
  class?: string;
}

/** One choice out of a few that act at once (a period, a kind, a theme): buttons side by side in one outline, the chosen one filled. */
export function ToggleGroup<T extends string | number>({ options, value, onChange, label, size = "sm", grow, autofocus, class: className }: ToggleGroupProps<T>) {
  return (
    <div role="group" aria-label={label} class={cx("flex overflow-hidden rounded-control border border-line", className)}>
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={v === value}
          data-autofocus={autofocus && v === value ? "" : undefined}
          onClick={() => onChange(v)}
          class={cx(
            "text-compact font-medium transition-colors not-last:border-r not-last:border-line",
            size === "sm" ? "h-8 px-3" : "h-9 px-4",
            grow && "flex-1",
            v === value ? "bg-primary-soft text-on-primary-soft" : "bg-surface text-muted hover:bg-surface-2",
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

const CHIP = {
  warn: "bg-warn-soft px-2.5 py-0.5 text-xs text-warn",
  primary: "h-6 bg-primary-soft px-2 text-xs font-medium text-on-primary-soft",
} as const;

/** A small rounded button inside a line of text or a row of badges (it jumps to something). */
export function ChipButton({ tone = "primary", class: className, children, ...rest }: Omit<JSX.HTMLAttributes<HTMLButtonElement>, "size"> & { tone?: keyof typeof CHIP; children?: ComponentChildren }) {
  return (
    <button type="button" class={cx("inline-flex items-center gap-1.5 rounded-full transition hover:brightness-95", CHIP[tone], className as string)} {...rest}>
      {children}
    </button>
  );
}

/** The header of something that opens and closes: it carries the state (`aria-expanded`) and the target (`aria-controls`); the screen draws what is inside it. */
export function DisclosureButton({ open, controls, onToggle, class: className, children }: { open: boolean; controls: string; onToggle: () => void; class?: string; children?: ComponentChildren }) {
  return (
    <button type="button" aria-expanded={open} aria-controls={controls} onClick={onToggle} class={cx("text-left transition-colors hover:bg-surface-2", className)}>
      {children}
    </button>
  );
}

/** A step of a sequence the person can jump to: the current one is filled, the ones already seen are quiet. */
export function StepButton({ state, number, children, ...rest }: Omit<JSX.HTMLAttributes<HTMLButtonElement>, "size"> & { state: "current" | "done" | "todo"; number: number; children?: ComponentChildren }) {
  return (
    <button
      type="button"
      aria-current={state === "current" ? "step" : undefined}
      class={cx(
        "inline-flex h-9 items-center gap-2 rounded-full border px-3 text-compact font-medium transition-colors",
        state === "current" ? "border-primary bg-primary-soft text-on-primary-soft" : state === "done" ? "border-line bg-surface-2 text-fg" : "border-line text-muted hover:bg-surface-2",
      )}
      {...rest}
    >
      <span class="inline-flex size-5 items-center justify-center rounded-full bg-surface text-xs">{number}</span>
      {children}
    </button>
  );
}

/** A button with no look of its own, for a target the screen draws entirely (the avatar, a box of the diagram): it only brings the button behaviour. */
export function BareButton({ buttonRef, class: className, children, ...rest }: Omit<JSX.HTMLAttributes<HTMLButtonElement>, "size" | "ref"> & { buttonRef?: Ref<HTMLButtonElement>; children?: ComponentChildren }) {
  return (
    <button type="button" ref={buttonRef} class={className as string} {...rest}>
      {children}
    </button>
  );
}
