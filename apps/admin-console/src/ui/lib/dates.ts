/**
 * Calendar days as YYYY-MM-DD text (what the API and the filters carry), with the arithmetic done in UTC so a day never shifts with the time zone.
 * Pure functions: the date picker is built on them and they are tested on their own.
 */
export const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
/** Sunday first, as the calendars of Brazil show it. */
export const WEEKDAYS = ["D", "S", "T", "Q", "Q", "S", "S"];
export const WEEKDAY_NAMES = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The parts of a real date, or null (2026-02-30 is not one). */
export function parseIso(s: string | null | undefined): { y: number; m: number; d: number } | null {
  const hit = s ? ISO.exec(s) : null;
  if (!hit) return null;
  const [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? { y, m, d } : null;
}

export function toIso(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

/** 2026-10-01 -> 01/10/2026 (empty when it is not a date). */
export function formatBr(iso: string | null | undefined): string {
  const p = parseIso(iso);
  return p ? `${String(p.d).padStart(2, "0")}/${String(p.m).padStart(2, "0")}/${p.y}` : "";
}

/** 01/10/2026 -> 2026-10-01; null when it is not a complete, real date. */
export function parseBr(text: string): string | null {
  const hit = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  if (!hit) return null;
  const iso = `${hit[3]}-${hit[2]}-${hit[1]}`;
  return parseIso(iso) ? iso : null;
}

/** What is typed, as dd/mm/aaaa: only digits are kept and the slashes appear by themselves (at most 8 digits). */
export function maskBr(text: string): string {
  const d = text.replace(/\D/g, "").slice(0, 8);
  return d.length <= 2 ? d : d.length <= 4 ? `${d.slice(0, 2)}/${d.slice(2)}` : `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
}

export function addDays(iso: string, n: number): string {
  const p = parseIso(iso);
  return p ? toIso(p.y, p.m, p.d + n) : iso;
}

/** The same day some months on, or the last day of that month when it has no such day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(iso: string, n: number): string {
  const p = parseIso(iso);
  if (!p) return iso;
  const first = new Date(Date.UTC(p.y, p.m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return toIso(first.getUTCFullYear(), first.getUTCMonth() + 1, Math.min(p.d, last));
}

/** 0 (Sunday) to 6. */
export function weekday(iso: string): number {
  const p = parseIso(iso);
  return p ? new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() : 0;
}

/** The 42 days (six weeks, Sunday first) that show the month of `iso`, with the days of the neighbouring months that fill the first and last week. */
export function monthGrid(iso: string): string[] {
  const p = parseIso(iso);
  if (!p) return [];
  const first = toIso(p.y, p.m, 1);
  const start = addDays(first, -weekday(first));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** `iso` held inside [min, max] (either bound may be empty). */
export function clampDay(iso: string, min?: string, max?: string): string {
  if (min && parseIso(min) && iso < min) return min;
  if (max && parseIso(max) && iso > max) return max;
  return iso;
}

/** Today in the person's own time zone (a calendar must not show tomorrow in the evening, which the UTC date does in Brazil). */
export function todayLocal(now: Date = new Date()): string {
  return toIso(now.getFullYear(), now.getMonth() + 1, now.getDate());
}
