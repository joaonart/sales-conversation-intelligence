import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import { cx } from "../lib/cx";

export interface TabItem {
  id: string;
  label: string;
  /** A count shown after the label: "Tabelas (17)". */
  count?: number | string;
}

interface TabsProps {
  label: string;
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Ids are scoped by this prefix, so several tab bars can live on one page. */
  idPrefix: string;
}

/** An ARIA tablist: arrows move between the tabs (and wrap), only the selected one is in the tab order. */
export function Tabs({ label, items, value, onChange, idPrefix }: TabsProps) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (from: number, step: number) => {
    const next = items[(from + step + items.length) % items.length];
    if (!next) return;
    onChange(next.id);
    refs.current[next.id]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} class="flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]">
      {items.map((t, i) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${t.id}`}
            aria-selected={on}
            aria-controls={`${idPrefix}-panel-${t.id}`}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => {
              const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              move(i, step);
            }}
            class={cx(
              "-mb-px h-11 shrink-0 border-b-2 px-4 text-sm font-medium whitespace-nowrap transition-colors",
              on ? "border-primary text-primary" : "border-transparent text-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            {t.label}
            {t.count !== undefined ? <span class="ml-1.5 font-normal text-faint tabular-nums">({t.count})</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ idPrefix, id, active, children }: { idPrefix: string; id: string; active: boolean; children?: ComponentChildren }) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`} hidden={!active}>
      {children}
    </div>
  );
}
