import { cx } from "../lib/cx";

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}

/** A real checkbox (role=switch), so the keyboard, the focus and the disabled state are the browser's own; only the look is drawn here. */
export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <label class={cx("inline-flex items-center gap-3", disabled ? "opacity-60" : "cursor-pointer")}>
      <input type="checkbox" role="switch" class="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span class="relative inline-block h-5 w-9 shrink-0 rounded-full bg-faint transition-colors peer-checked:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-4" />
      <span>{label}</span>
    </label>
  );
}
