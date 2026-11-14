import type { ComponentProps } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { cx } from "../lib/cx";
import {
  MONTHS,
  WEEKDAYS,
  WEEKDAY_NAMES,
  addDays,
  addMonths,
  clampDay,
  formatBr,
  maskBr,
  monthGrid,
  parseBr,
  parseIso,
  todayLocal,
  weekday,
} from "../lib/dates";
import { Button, IconButton } from "./Button";
import { CONTROL } from "./controlStyle";
import { Icon } from "./Icon";
import { placePanel, useDismiss, type PanelBox } from "./popover";
import type { SelectChange } from "./Select";

type DatePickerProps = Omit<
  ComponentProps<"input">,
  "value" | "onChange" | "type" | "min" | "max"
> & {
  /** YYYY-MM-DD, or empty. */
  value: string;
  /** Same shape as the other controls: `e.currentTarget.value` is YYYY-MM-DD, or "" when the date is cleared. */
  onChange?: (e: SelectChange) => void;
  min?: string;
  max?: string;
};

const PANEL_WIDTH = 288;

/**
 * A date field of the console: type dd/mm/aaaa (the slashes come by themselves) or open the calendar. The value is YYYY-MM-DD, like the date input it
 * replaces, so the screens did not change. A date outside `min`/`max` cannot be chosen or typed. Calendar keyboard: arrows move a day or a week,
 * Home/End the week, PageUp/PageDown a month (Shift: a year), Enter chooses, Escape closes. Like the combo, the calendar is drawn in the page body.
 */
export function DatePicker({
  value,
  onChange,
  min,
  max,
  disabled,
  class: className,
  onBlur,
  onKeyDown,
  ...rest
}: DatePickerProps) {
  const [text, setText] = useState(formatBr(value));
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState(todayLocal()); // the day the calendar's keyboard is on (its month is the one shown)
  const [box, setBox] = useState<PanelBox | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const uid = useId();
  const today = todayLocal();
  const inRange = (iso: string): boolean =>
    (!min || iso >= min) && (!max || iso <= max);

  useEffect(() => setText(formatBr(value)), [value]);

  const emit = (iso: string): void => {
    if (iso !== value)
      onChange?.({ currentTarget: { value: iso }, target: { value: iso } });
  };
  const close = (focus = true): void => {
    setOpen(false);
    if (focus) input.current?.focus();
  };
  const openPanel = (): void => {
    if (disabled) return;
    const r = wrap.current?.getBoundingClientRect();
    if (!r) return;
    setBox(placePanel(r, 380));
    setDay(clampDay(parseIso(value) ? value : today, min, max));
    setOpen(true);
  };
  const choose = (iso: string): void => {
    if (!inRange(iso)) return;
    emit(iso);
    setText(formatBr(iso));
    close();
  };
  useDismiss(open, panel, wrap, () => close(false));
  // The keyboard follows the chosen day: focus the button of that day each time it moves.
  useEffect(() => {
    if (open)
      panel.current?.querySelector<HTMLElement>(`[data-day="${day}"]`)?.focus();
  }, [open, day]);

  const typed = (e: Event & { currentTarget: HTMLInputElement }): void => {
    const masked = maskBr(e.currentTarget.value);
    setText(masked);
    if (masked === "") emit("");
    else {
      const iso = parseBr(masked);
      if (iso && inRange(iso)) emit(iso);
    }
  };

  const move = (e: KeyboardEvent): void => {
    const step: Record<string, string> = {
      ArrowLeft: addDays(day, -1),
      ArrowRight: addDays(day, 1),
      ArrowUp: addDays(day, -7),
      ArrowDown: addDays(day, 7),
      Home: addDays(day, -weekday(day)),
      End: addDays(day, 6 - weekday(day)),
      PageUp: addMonths(day, e.shiftKey ? -12 : -1),
      PageDown: addMonths(day, e.shiftKey ? 12 : 1),
    };
    if (e.key in step) {
      e.preventDefault();
      setDay(clampDay(step[e.key] as string, min, max));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(day);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // a dialog around it must not close too
      close();
    } else if (e.key === "Tab") close(false);
  };

  const p = parseIso(day) as { y: number; m: number; d: number };
  const selected = parseIso(value) ? value : "";
  const days = monthGrid(day);
  const label = `${MONTHS[p.m - 1]} de ${p.y}`;

  return (
    <>
      <div ref={wrap} class={cx("relative min-w-0", className as string)}>
        <input
          {...rest}
          ref={input}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="dd/mm/aaaa"
          maxLength={10}
          value={text}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? `${uid}-cal` : undefined}
          class={cx(CONTROL, "pr-10")}
          onInput={typed}
          onBlur={(e) => {
            setText(formatBr(value)); // what is not a complete, allowed date goes back to the date that is set
            (onBlur as ((ev: FocusEvent) => void) | undefined)?.(
              e as unknown as FocusEvent,
            );
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && e.altKey) {
              e.preventDefault();
              openPanel();
            } else if (e.key === "Enter") {
              const iso = parseBr(text);
              if (iso && inRange(iso)) emit(iso);
            }
            (onKeyDown as ((ev: KeyboardEvent) => void) | undefined)?.(
              e as unknown as KeyboardEvent,
            );
          }}
        />
        <button
          type="button"
          aria-label="Abrir calendário"
          title="Abrir calendário"
          disabled={disabled}
          class="absolute top-1/2 right-1.5 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-default disabled:opacity-40"
          onClick={() => (open ? close() : openPanel())}
        >
          <Icon name="calendar" size="sm" />
        </button>
      </div>
      {open && box
        ? createPortal(
            <div
              ref={panel}
              id={`${uid}-cal`}
              role="dialog"
              aria-label="Escolher data"
              class="fixed z-[90] rounded-control border border-line bg-surface p-3 shadow-pop"
              style={{
                left: Math.min(box.left, window.innerWidth - PANEL_WIDTH - 8),
                width: PANEL_WIDTH,
                ...(box.top !== undefined
                  ? { top: box.top }
                  : { bottom: box.bottom }),
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  close();
                }
              }}
            >
              <div class="mb-2 flex items-center justify-between">
                <IconButton
                  icon="prev"
                  label="Mês anterior"
                  class="!size-8"
                  onClick={() => setDay(clampDay(addMonths(day, -1), min, max))}
                />
                <div class="font-medium first-letter:uppercase" aria-live="polite">
                  {label}
                </div>
                <IconButton
                  icon="chevron"
                  label="Próximo mês"
                  class="!size-8"
                  onClick={() => setDay(clampDay(addMonths(day, 1), min, max))}
                />
              </div>
              <div role="grid" aria-label={label} onKeyDown={move}>
                <div
                  role="row"
                  class="grid grid-cols-7 text-center text-xs text-muted"
                >
                  {WEEKDAYS.map((w, i) => (
                    <span
                      key={i}
                      role="columnheader"
                      aria-label={WEEKDAY_NAMES[i]}
                      class="py-1"
                    >
                      {w}
                    </span>
                  ))}
                </div>
                {Array.from({ length: 6 }, (_, row) => (
                  <div key={row} role="row" class="grid grid-cols-7">
                    {days.slice(row * 7, row * 7 + 7).map((iso) => {
                      const here = parseIso(iso)?.m === p.m;
                      const off = !inRange(iso);
                      return (
                        <button
                          key={iso}
                          type="button"
                          role="gridcell"
                          data-day={iso}
                          tabIndex={iso === day ? 0 : -1}
                          disabled={off}
                          aria-selected={iso === selected}
                          aria-current={iso === today ? "date" : undefined}
                          aria-label={`${parseIso(iso)?.d} de ${MONTHS[(parseIso(iso)?.m ?? 1) - 1]} de ${parseIso(iso)?.y}`}
                          class={cx(
                            "mx-auto flex size-9 items-center justify-center rounded-full text-sm transition-colors disabled:cursor-default disabled:opacity-30",
                            iso === selected
                              ? "bg-primary text-on-primary"
                              : "hover:bg-surface-2",
                            iso !== selected && !here && "text-faint",
                            iso === today &&
                              iso !== selected &&
                              "border border-primary text-primary",
                          )}
                          onClick={() => choose(iso)}
                        >
                          {parseIso(iso)?.d}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
              <div class="mt-2 flex items-center justify-between border-t border-line pt-2">
                <Button
                  variant="text"
                  small
                  disabled={!inRange(today)}
                  onClick={() => choose(today)}
                >
                  Hoje
                </Button>
                <Button
                  variant="text"
                  small
                  disabled={!value}
                  onClick={() => (emit(""), setText(""), close())}
                >
                  Limpar
                </Button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
