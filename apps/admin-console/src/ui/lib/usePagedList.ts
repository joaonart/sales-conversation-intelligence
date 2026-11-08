import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { readStore, writeStore } from "./storage";
import type { Page } from "./types";

export const PAGE_SIZES = [25, 50, 100];

/** Where a person was in a list: opening a row and coming back lands on the same page, with the same filters. */
interface Saved<F> {
  t: string;
  size: number;
  page: number;
  cursors: unknown[];
  filters: F;
}

export function readPaging<F>(key: string, tenantKey: string, sizes: number[] = PAGE_SIZES): Saved<F> | null {
  try {
    const raw = readStore("session", `sci.page.${key}`);
    if (!raw) return null;
    const o = JSON.parse(raw) as Saved<F>;
    if (o.t !== tenantKey || !sizes.includes(o.size) || !Array.isArray(o.cursors) || !Number.isInteger(o.page) || o.page < 0) return null;
    return o;
  } catch {
    return null;
  }
}

export interface CountResult {
  total: number;
  [extra: string]: unknown;
}

export interface PagedOptions<T, F> {
  key: string;
  tenantKey: string;
  /** The filters that are APPLIED (what the person committed with "Buscar"), not the ones being typed. A change of them starts the list over. */
  filters: F;
  sizes?: number[];
  size?: number;
  /** What `readPaging` found when the screen opened: the page to come back to. */
  restore?: Saved<F> | null;
  load: (cursor: unknown, limit: number) => Promise<Page<T>>;
  count?: () => Promise<CountResult>;
  noteOf?: (r: CountResult) => string;
  /** How many UNITS a page of rows holds, when a row is not one (a rubric page lists versions but counts rubrics). */
  unitsOf?: (rows: T[]) => number;
  onCountError?: (e: unknown) => void;
}

export interface PagedList<T> {
  rows: T[];
  status: "loading" | "ready" | "error";
  error: string | null;
  page: number;
  size: number;
  sizes: number[];
  setSize: (n: number) => void;
  hasNext: boolean;
  goFirst: () => void;
  goPrev: () => void;
  goNext: () => void;
  reload: () => void;
  /** 1-based position of the first and last row on this page. */
  first: number;
  last: number;
  total: number | null;
  totalNote: string;
  /** Number of pages, known only once the total is. Never below the page the person is on, even if the set shrank meanwhile. */
  pages: number | null;
  counting: boolean;
  countFailed: boolean;
  countNow: () => void;
}

/**
 * A keyset-paginated list. Pages are walked with the cursor the server returns (never an offset), so the TOTAL is what says how many pages there are:
 * it is counted once per set of filters, in the background, after the first page is on the screen. A response that arrives after a newer request is
 * ignored, and a page that disappeared (the data changed) steps back to the one before.
 */
export function usePagedList<T, F>(o: PagedOptions<T, F>): PagedList<T> {
  const sizes = o.sizes ?? PAGE_SIZES;
  const filterKey = JSON.stringify(o.filters);
  const initial = useRef(o.restore ?? null);
  const [size, setSizeState] = useState<number>(o.restore?.size ?? o.size ?? sizes[Math.min(1, sizes.length - 1)] ?? 25);
  const [view, setView] = useState<{ idx: number; page: Page<T> | null; status: "loading" | "ready" | "error"; error: string | null }>({ idx: 0, page: null, status: "loading", error: null });
  const [total, setTotal] = useState<number | null>(null);
  const [totalNote, setTotalNote] = useState("");
  const [counting, setCounting] = useState(false);
  const [countFailed, setCountFailed] = useState(false);

  const cursors = useRef<unknown[]>([null]);
  const cache = useRef(new Map<number, Page<T>>());
  const seq = useRef(0);
  const autoTried = useRef(false);
  const totalRef = useRef<number | null>(null);
  const countingRef = useRef(false);
  const latest = useRef({ o, filterKey, size });
  latest.current = { o, filterKey, size };

  const persist = (idx: number) => {
    const cur = latest.current;
    writeStore("session", `sci.page.${cur.o.key}`, JSON.stringify({ t: cur.o.tenantKey, size: cur.size, page: idx, cursors: cursors.current, filters: cur.o.filters } satisfies Saved<F>));
  };

  const countNow = (manual: boolean) => {
    const cur = latest.current;
    if (!cur.o.count || countingRef.current) return;
    const startedWith = cur.filterKey;
    countingRef.current = true;
    setCounting(true);
    setCountFailed(false);
    cur.o
      .count()
      .then((r) => {
        countingRef.current = false;
        setCounting(false);
        if (startedWith !== latest.current.filterKey) return; // the filters changed while counting: this total belongs to another set
        totalRef.current = r.total;
        setTotal(r.total);
        setTotalNote(latest.current.o.noteOf?.(r) ?? "");
      })
      .catch((e: unknown) => {
        countingRef.current = false;
        setCounting(false);
        setCountFailed(true);
        if (manual) latest.current.o.onCountError?.(e);
      });
  };

  const run = useCallback(async (idx: number, force = false): Promise<void> => {
    const hit = cache.current.get(idx);
    if (!force && hit) {
      setView({ idx, page: hit, status: "ready", error: null });
      persist(idx);
      return;
    }
    const my = ++seq.current;
    setView((v) => ({ ...v, status: "loading" }));
    try {
      const { o: cur, size: limit } = latest.current;
      const res = await cur.load(cursors.current[idx] ?? null, limit);
      if (my !== seq.current) return;
      if (!res.rows.length && idx > 0) {
        cursors.current.length = idx;
        cache.current.clear();
        await run(idx - 1, true);
        return;
      }
      cache.current.set(idx, res);
      cursors.current.length = idx + 1;
      if (res.nextCursor) cursors.current[idx + 1] = res.nextCursor;
      setView({ idx, page: res, status: "ready", error: null });
      persist(idx);
      if (cur.count && totalRef.current === null && !autoTried.current && res.rows.length) {
        autoTried.current = true;
        countNow(false);
      }
    } catch (e) {
      if (my !== seq.current) return;
      setView((v) => ({ ...v, status: "error", error: e instanceof Error ? e.message : "Erro inesperado." }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // New filters or a new page size: a new list. The first time, the page the person left is the one that opens.
  useEffect(() => {
    const restore = initial.current;
    initial.current = null;
    const mine = restore && restore.size === size && JSON.stringify(restore.filters) === filterKey ? restore : null;
    cursors.current = mine ? [...mine.cursors] : [null];
    cache.current.clear();
    totalRef.current = null;
    autoTried.current = false;
    setTotal(null);
    setTotalNote("");
    setCountFailed(false);
    void run(mine ? mine.page : 0, true);
  }, [filterKey, size, run]);

  const rows = view.page?.rows ?? [];
  const units = o.unitsOf ? o.unitsOf(rows) : rows.length;
  return {
    rows,
    status: view.status,
    error: view.error,
    page: view.idx,
    size,
    sizes,
    setSize: (n) => setSizeState(n),
    hasNext: Boolean(view.page?.nextCursor),
    goFirst: () => void run(0),
    goPrev: () => void run(Math.max(0, view.idx - 1)),
    goNext: () => void run(view.idx + 1),
    reload: () => void run(view.idx, true),
    first: view.idx * size + 1,
    last: view.idx * size + units,
    total,
    totalNote,
    pages: total !== null ? Math.max(1, Math.ceil(total / size), view.idx + 1) : null,
    counting,
    countFailed,
    countNow: () => countNow(true),
  };
}
