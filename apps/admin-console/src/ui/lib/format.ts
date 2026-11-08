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

const timeOnly = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const longDay = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" });
const dayUtc = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeZone: "UTC" });

const toDate = (v: string | null | undefined): Date | null => {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

export function fmtTime(v: string | null | undefined): string {
  const d = toDate(v);
  return d ? timeOnly.format(d) : "";
}

/** "8 de novembro de 2026": the separator between the days of a conversation. */
export function fmtLongDay(v: string | null | undefined): string {
  const d = toDate(v);
  return d ? longDay.format(d) : "";
}

/** A key that changes when the (local) day changes. */
export function dayKey(v: string | null | undefined): string {
  const d = toDate(v);
  return d ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : "";
}

/** A calendar day sent as "YYYY-MM-DD" (no time zone shift), as "08/11/2026". */
export function fmtDay(s: string | null | undefined): string {
  const d = s ? new Date(`${s}T00:00:00Z`) : null;
  return d && !Number.isNaN(d.getTime()) ? dayUtc.format(d) : "—";
}
