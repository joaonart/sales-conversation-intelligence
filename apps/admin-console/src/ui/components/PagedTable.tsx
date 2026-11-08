import type { ComponentChildren } from "preact";
import type { PagedList } from "../lib/usePagedList";
import { EmptyState } from "./Alert";
import type { IconName } from "./icons";
import { ErrorAlert, Loading } from "./Bits";
import { Card } from "./Card";
import { DataTable, type Column } from "./DataTable";
import { Pager } from "./Pager";

interface PagedTableProps<T> {
  list: PagedList<T>;
  unit: string;
  noun?: string;
  caption: string;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty: ComponentChildren;
  emptyIcon?: IconName;
  /** Without a card around it (the caller already is in one, or draws its own). */
  bare?: boolean;
}

/** The standard look of a paged list: loading, error, empty, the table and the pager that always says where you are. */
export function PagedTable<T>({ list, unit, noun, caption, columns, rowKey, onRowClick, empty, emptyIcon = "inbox", bare }: PagedTableProps<T>) {
  const body = (
    <>
      {list.status === "error" ? <div class="p-4"><ErrorAlert message={list.error ?? ""} /></div> : null}
      {list.status === "loading" && !list.rows.length ? <Loading /> : null}
      {list.status === "ready" && !list.rows.length ? <EmptyState icon={emptyIcon}>{empty}</EmptyState> : null}
      {list.rows.length ? <DataTable caption={caption} columns={columns} rows={list.rows} rowKey={rowKey} onRowClick={onRowClick} /> : null}
      <Pager list={list} unit={unit} noun={noun} />
    </>
  );
  return bare ? body : <Card flush>{body}</Card>;
}
