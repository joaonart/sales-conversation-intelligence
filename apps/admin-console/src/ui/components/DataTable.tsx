import type { ComponentChildren } from "preact";
import { cx } from "../lib/cx";

export interface Column<T> {
  header: string;
  cell: (row: T) => ComponentChildren;
  /** Numbers read better flush right. */
  align?: "right";
  class?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Makes a row a link: the whole row is clickable and reachable with the keyboard (Enter). */
  onRowClick?: (row: T) => void;
  caption?: string;
  foot?: ComponentChildren;
  /** Hands out the element of each row, so a link elsewhere can scroll to it (the row is then focusable by script). */
  rowRef?: (row: T, el: HTMLTableRowElement | null) => void;
}

export function DataTable<T>({ columns, rows, rowKey, onRowClick, caption, foot, rowRef }: DataTableProps<T>) {
  return (
    <div class="overflow-x-auto">
      <table class="w-full border-collapse text-left text-sm">
        {caption ? <caption class="sr-only">{caption}</caption> : null}
        <thead>
          <tr class="border-b border-line">
            {columns.map((c) => (
              <th key={c.header} scope="col" class={cx("px-4 py-2.5 text-xs font-medium tracking-wide text-muted uppercase", c.align === "right" && "text-right")}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              ref={rowRef ? (el) => rowRef(row, el) : undefined}
              tabIndex={onRowClick ? 0 : rowRef ? -1 : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? (e) => e.key === "Enter" && onRowClick(row) : undefined}
              class={cx("border-b border-divider last:border-b-0", onRowClick && "cursor-pointer hover:bg-surface-2")}
            >
              {columns.map((c) => (
                <td key={c.header} class={cx("px-4 py-3 align-middle", c.align === "right" && "text-right tabular-nums", c.class)}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {foot ? <tfoot class="border-t-2 border-line font-semibold">{foot}</tfoot> : null}
      </table>
    </div>
  );
}
