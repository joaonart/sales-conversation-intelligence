import type { ComponentChildren } from "preact";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";
import type { IconName } from "./icons";

const TONE = {
  info: ["bg-info-soft text-fg border-info/30", "info"],
  warn: ["bg-warn-soft text-fg border-warn/30", "warn"],
  bad: ["bg-bad-soft text-fg border-bad/30", "bad"],
  ok: ["bg-ok-soft text-fg border-ok/30", "ok"],
} as const satisfies Record<string, readonly [string, IconName]>;

interface AlertProps {
  tone?: keyof typeof TONE;
  children?: ComponentChildren;
  class?: string;
}

export function Alert({ tone = "info", children, class: className }: AlertProps) {
  const [style, icon] = TONE[tone];
  return (
    <div role={tone === "bad" ? "alert" : "status"} class={cx("flex gap-3 rounded-control border px-4 py-3", style, className)}>
      <Icon name={icon} class={tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "text-info"} />
      <div class="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function EmptyState({ icon = "inbox", children }: { icon?: IconName; children?: ComponentChildren }) {
  return (
    <div class="flex flex-col items-center gap-2 px-4 py-12 text-center text-muted">
      <Icon name={icon} size="xl" class="text-faint" />
      <div>{children}</div>
    </div>
  );
}
