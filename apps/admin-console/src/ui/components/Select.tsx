import {
  toChildArray,
  type ComponentChildren,
  type ComponentProps,
  type VNode,
} from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import { cx } from "../lib/cx";
import { CONTROL } from "./controlStyle";
import { Icon } from "./Icon";
import { placePanel, useDismiss, type PanelBox } from "./popover";

interface Opt {
  value: string;
  label: string;
  disabled: boolean;
}

/** What the screens read from a change: the same `e.currentTarget.value` they used with the native select. */
export interface SelectChange {
  currentTarget: { value: string };
  target: { value: string };
}

type SelectProps = Omit<
  ComponentProps<"button">,
  "onChange" | "value" | "children"
> & {
  value: string | number;
  onChange?: (e: SelectChange) => void;
  /** `<option>` elements, as with a native select (an option without `value` uses its text). */
  children?: ComponentChildren;
};

const textOf = (c: ComponentChildren): string =>
  toChildArray(c)
    .map((x) => (typeof x === "object" ? "" : String(x)))
    .join("");

function optionsOf(children: ComponentChildren): Opt[] {
  return toChildArray(children).flatMap((c) => {
    if (typeof c !== "object" || (c as VNode).type !== "option") return [];
    const p = (
      c as VNode<{
        value?: string | number;
        disabled?: boolean;
        children?: ComponentChildren;
      }>
    ).props;
    const label = textOf(p.children);
    return [
      {
        value: p.value === undefined ? label : String(p.value),
        label,
        disabled: Boolean(p.disabled),
      },
    ];
  });
}

/** From this many options the panel has a search box. */
const SEARCH_FROM = 12;
const PANEL_MAX = 288;

/**
 * The combo of the console: a button that opens a panel of options (a listbox), drawn here so it looks the same everywhere, unlike the panel of a
 * native select. Same props as the native one (`value`, `onChange(e.currentTarget.value)`, `<option>` children, `disabled`, `aria-label`), so a
 * screen does not change. Keyboard: arrows, Home/End, Enter or Space to choose, Escape to close, typing jumps to an option (or filters, in a long
 * list). The panel is drawn in the page body (so it is not part of the field's label, which would put every option in the field's accessible name), fixed to the viewport (a card or a dialog never clips it), and opens upwards when there is no room below.
 */
export function Select({
  value,
  onChange,
  children,
  class: className,
  disabled,
  onKeyDown: _k,
  ...rest
}: SelectProps) {
  const opts = useMemo(() => optionsOf(children), [children]);
  const current = String(value);
  const selected = opts.find((o) => o.value === current);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const [box, setBox] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    max: number;
  } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const uid = useId();
  const searchable = opts.length > SEARCH_FROM;
  const shown = useMemo(
    () =>
      query
        ? opts.filter((o) =>
            o.label.toLowerCase().includes(query.toLowerCase()),
          )
        : opts,
    [opts, query],
  );

  const close = (focus = true): void => {
    setOpen(false);
    setQuery("");
    typed.current.text = ""; // what was typed to jump to an option does not carry over to the next time
    if (focus) button.current?.focus();
  };
  const choose = (o: Opt | undefined): void => {
    if (!o || o.disabled) return;
    if (o.value !== current)
      onChange?.({
        currentTarget: { value: o.value },
        target: { value: o.value },
      });
    close();
  };
  const openPanel = (): void => {
    if (disabled) return;
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    setBox({ ...placePanel(r, PANEL_MAX), width: r.width });
    const at = opts.findIndex((o) => o.value === current);
    setActive(
      at >= 0
        ? at
        : Math.max(
            0,
            opts.findIndex((o) => !o.disabled),
          ),
    );
    setOpen(true);
  };
  const move = (from: number, step: 1 | -1): number => {
    for (let i = from + step; i >= 0 && i < shown.length; i += step)
      if (!shown[i]?.disabled) return i;
    return from;
  };

  useDismiss(open, panel, button, () => close(false));
  useEffect(() => {
    if (open && searchable) search.current?.focus();
  }, [open, searchable]);
  useEffect(() => {
    if (open)
      panel.current
        ?.querySelector<HTMLElement>(`[id="${uid}-${active}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, uid]);

  const onKey = (e: KeyboardEvent): void => {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openPanel();
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // typing on a closed combo moves the choice, like a native select
        const now = Date.now();
        typed.current = {
          text:
            now - typed.current.at > 700 ? e.key : typed.current.text + e.key,
          at: now,
        };
        const hit = opts.find(
          (o) =>
            !o.disabled &&
            o.label.toLowerCase().startsWith(typed.current.text.toLowerCase()),
        );
        if (hit && hit.value !== current)
          onChange?.({
            currentTarget: { value: hit.value },
            target: { value: hit.value },
          });
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive(move(active, 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive(move(active, -1));
        break;
      case "Home":
        if (!searchable) {
          e.preventDefault();
          setActive(move(-1, 1));
        }
        break;
      case "End":
        if (!searchable) {
          e.preventDefault();
          setActive(move(shown.length, -1));
        }
        break;
      case "Enter":
        e.preventDefault();
        choose(shown[active]);
        break;
      case " ":
        if (!searchable || !query) {
          e.preventDefault();
          choose(shown[active]);
        }
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation(); // a dialog around it must not close too
        close();
        break;
      case "Tab":
        close(false);
        break;
      default:
        if (
          !searchable &&
          e.key.length === 1 &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey
        ) {
          const now = Date.now();
          typed.current = {
            text:
              now - typed.current.at > 700 ? e.key : typed.current.text + e.key,
            at: now,
          };
          const at = shown.findIndex(
            (o) =>
              !o.disabled &&
              o.label
                .toLowerCase()
                .startsWith(typed.current.text.toLowerCase()),
          );
          if (at >= 0) setActive(at);
        }
    }
  };

  return (
    <>
      <button
        {...rest}
        ref={button}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${uid}-list` : undefined}
        aria-activedescendant={
          open && !searchable ? `${uid}-${active}` : undefined
        }
        value={current}
        disabled={disabled}
        class={cx(
          CONTROL,
          "flex items-center justify-between gap-2 pr-2 text-left",
          className as string,
        )}
        onClick={() => (open ? close() : openPanel())}
        onKeyDown={onKey}
      >
        <span class="min-w-0 flex-1 truncate">
          {selected ? selected.label : ""}
        </span>
        <Icon
          name="chevron"
          size="sm"
          class={cx(
            "text-muted transition-transform",
            open ? "-rotate-90" : "rotate-90",
          )}
        />
      </button>
      {open && box
        ? createPortal(
            <div
              ref={panel}
              class="fixed z-[90] flex flex-col overflow-hidden rounded-control border border-line bg-surface shadow-pop"
              style={{
                left: box.left,
                minWidth: box.width,
                maxWidth: "min(32rem, calc(100vw - 1rem))",
                maxHeight: box.max,
                ...(box.top !== undefined
                  ? { top: box.top }
                  : { bottom: box.bottom }),
              }}
            >
              {searchable ? (
                <input
                  ref={search}
                  type="text"
                  value={query}
                  placeholder="Buscar"
                  aria-label="Buscar na lista"
                  aria-controls={`${uid}-list`}
                  aria-activedescendant={
                    shown[active] ? `${uid}-${active}` : undefined
                  }
                  class="h-9 shrink-0 border-0 border-b border-line bg-surface px-3 text-sm text-fg placeholder:text-faint focus:outline-none"
                  onInput={(e) => {
                    setQuery(e.currentTarget.value);
                    setActive(0);
                  }}
                  onKeyDown={onKey}
                />
              ) : null}
              <div
                id={`${uid}-list`}
                role="listbox"
                aria-label={rest["aria-label"]}
                class="overflow-auto py-1"
              >
                {shown.length === 0 ? (
                  <div class="px-3 py-2 text-muted">Nada encontrado</div>
                ) : null}
                {shown.map((o, i) => (
                  <div
                    key={o.value}
                    id={`${uid}-${i}`}
                    role="option"
                    data-value={o.value}
                    aria-selected={o.value === current}
                    aria-disabled={o.disabled || undefined}
                    class={cx(
                      "flex cursor-pointer items-center px-3 py-2",
                      i === active && "bg-surface-2",
                      o.value === current && "font-medium text-primary",
                      o.disabled && "cursor-default opacity-50",
                    )}
                    onPointerEnter={() => !o.disabled && setActive(i)}
                    onClick={() => choose(o)}
                  >
                    <span class="truncate">{o.label}</span>
                  </div>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
