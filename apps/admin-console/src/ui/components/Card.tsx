import type { ComponentChildren } from "preact";
import { cx } from "../lib/cx";

interface CardProps {
  title?: string;
  /** Right of the title: a count, a hint, an action. */
  aside?: ComponentChildren;
  children?: ComponentChildren;
  class?: string;
  /** Lets a table or a pager reach the card's edges. */
  flush?: boolean;
}

export function Card({ title, aside, children, class: className, flush }: CardProps) {
  return (
    <section class={cx("rounded-card border border-line bg-surface shadow-card", flush ? "overflow-hidden" : "p-5", className)}>
      {title ? (
        <header class={cx("flex flex-wrap items-center gap-x-3 gap-y-1", flush ? "px-5 pt-5" : "", "mb-3")}>
          <h2 class="text-base font-semibold tracking-tight">{title}</h2>
          {aside ? <div class="ml-auto text-xs text-muted">{aside}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}
