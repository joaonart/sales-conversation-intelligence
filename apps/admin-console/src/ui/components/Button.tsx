import type { ComponentChildren, JSX } from "preact";
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
}

export function Button({ variant = "secondary", small, icon, children, class: className, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      class={cx(
        "inline-flex items-center justify-center gap-2 rounded-control border font-medium whitespace-nowrap transition-colors",
        "disabled:cursor-default disabled:opacity-50",
        small ? "h-8 px-3 text-[13px]" : "h-9 px-4",
        VARIANT[variant],
        className as string,
      )}
      {...rest}
    >
      {icon ? <Icon name={icon} size="sm" /> : null}
      {children}
    </button>
  );
}

interface IconButtonProps extends Omit<JSX.HTMLAttributes<HTMLButtonElement>, "size"> {
  icon: IconName;
  label: string;
  disabled?: boolean;
  pressed?: boolean;
}

/** A button with only an icon: the label is mandatory, because it is the only name a screen reader gets. */
export function IconButton({ icon, label, class: className, pressed, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      class={cx("inline-flex size-9 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-default disabled:opacity-40", className as string)}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}
