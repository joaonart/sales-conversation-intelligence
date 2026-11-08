import { ICON_PATHS, type IconName } from "./icons";
import { cx } from "../lib/cx";

const SIZE = { sm: "size-4", md: "size-5", lg: "size-6", xl: "size-10" } as const;

interface IconProps {
  name: IconName;
  size?: keyof typeof SIZE;
  class?: string;
}

/** Decorative by default (`aria-hidden`): whatever it sits in carries the accessible name. */
export function Icon({ name, size = "md", class: className }: IconProps) {
  return (
    <svg class={cx(SIZE[size], "shrink-0", className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      {ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
