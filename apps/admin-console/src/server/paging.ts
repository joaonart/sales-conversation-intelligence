import { s, ts, type Param } from "./bq";
import { invalid } from "./errors";
import type { Row } from "./types";
import * as v from "./validate";

/**
 * Keyset pagination shared by every list. Never OFFSET: BigQuery would read every skipped row again on each page, so cost and latency would grow with the page number.
 * Each page reads one extra row to know whether a next page exists. Lists sorted by time use a (timestamp DESC, id ASC) total order; the cursor carries the timestamp
 * as a string WITH microseconds, formatted by BigQuery: going through a JavaScript Date would cut it to milliseconds and skip rows between pages.
 */
export const CURSOR_TS = "'%Y-%m-%dT%H:%M:%E6SZ'";

export interface TsCursor {
  at: string;
  id: string;
}
export interface KeyCursor {
  key: string;
}
export interface Page<C> {
  rows: Row[];
  nextCursor: C | null;
}

/** SELECT expression that exposes `column` as the microsecond cursor string `cursor_ts`. */
export const cursorTsSelect = (column: string): string => `FORMAT_TIMESTAMP(${CURSOR_TS}, ${column}) AS cursor_ts`;

export function parseTsCursor(raw: unknown): TsCursor | null {
  if (raw === undefined || raw === null) return null;
  const o = v.asObject(raw, "cursor");
  const at = v.text(o.at, "cursor.at", 40, { min: 1 });
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(at)) throw invalid("cursor inválido.");
  return { at, id: v.text(o.id, "cursor.id", 200, { min: 1 }) };
}

export function parseKeyCursor(raw: unknown, check: (value: unknown, field: string) => string): KeyCursor | null {
  if (raw === undefined || raw === null) return null;
  return { key: check(v.asObject(raw, "cursor").key, "cursor.key") };
}

/** Rows strictly after the cursor in the (ts DESC, id ASC) order. */
export const afterTs = (tsColumn: string, idColumn: string): string => `(${tsColumn} < @cur_ts OR (${tsColumn} = @cur_ts AND ${idColumn} > @cur_id))`;

export function tsCursorParams(c: TsCursor | null): Record<string, Param> {
  return c ? { cur_ts: ts(c.at), cur_id: s(c.id) } : {};
}

/** Splits the extra row off, removes the helper `cursor_ts` column and builds the next cursor from the last row of the page. */
export function tsPage(rows: Row[], limit: number, idKey: string): Page<TsCursor> {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map(({ cursor_ts: _cursor, ...row }) => row),
    nextCursor: rows.length > limit && last ? { at: String(last.cursor_ts), id: String(last[idKey]) } : null,
  };
}

export function keyPage(rows: Row[], limit: number, keyOf: (row: Row) => string): Page<KeyCursor> {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: rows.length > limit && last ? { key: keyOf(last) } : null };
}

/** Page sizes the screens offer; the server accepts nothing larger. */
export const MAX_PAGE = 100;
