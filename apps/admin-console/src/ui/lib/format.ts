/** pt-BR formatting for the numbers, money and dates the console shows. A missing value is an em dash, never "0" or "NaN". */
const DASH = "—";

export function fmtNum(n: number | string | null | undefined, digits = 1): string {
  return n === null || n === undefined || n === "" ? DASH : Number(n).toLocaleString("pt-BR", { maximumFractionDigits: digits });
}

export function fmtInt(n: number | string | null | undefined): string {
  return fmtNum(n, 0);
}

export function fmtPct(n: number | string | null | undefined): string {
  return n === null || n === undefined || n === "" ? DASH : `${(Number(n) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%`;
}

export function fmtUsd(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return DASH;
  const v = Number(n);
  return `US$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 5 : 2 })}`;
}

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

export function fmtDt(v: string | null | undefined): string {
  if (!v) return DASH;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? DASH : dateTime.format(d);
}

/** Today minus `days`, as the YYYY-MM-DD the date inputs and the API use. */
export function isoDay(daysAgo = 0, now: Date = new Date()): string {
  return new Date(now.getTime() - daysAgo * 864e5).toISOString().slice(0, 10);
}
