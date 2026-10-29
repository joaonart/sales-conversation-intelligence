import { invalid } from "./errors";
import type { Tenant } from "./types";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function asObject(v: unknown, what = "payload"): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw invalid(`${what} inválido.`);
  return v as Record<string, unknown>;
}

export function id(v: unknown, field: string): string {
  if (typeof v !== "string" || !ID.test(v)) throw invalid(`${field} inválido.`);
  return v;
}

export function email(v: unknown, field = "email"): string {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!EMAIL.test(s)) throw invalid(`${field} inválido.`);
  return s;
}

export function text(v: unknown, field: string, max: number, opts: { min?: number } = {}): string {
  if (typeof v !== "string") throw invalid(`${field} deve ser texto.`);
  const s = v.trim();
  if (s.length < (opts.min ?? 0)) throw invalid(`${field} é obrigatório.`);
  if (s.length > max) throw invalid(`${field} excede ${max} caracteres.`);
  return s;
}

export function int(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw invalid(`${field} deve ser um inteiro entre ${min} e ${max}.`);
  return v;
}

export function num(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw invalid(`${field} deve estar entre ${min} e ${max}.`);
  return v;
}

export function bool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw invalid(`${field} deve ser verdadeiro ou falso.`);
  return v;
}

export function date(v: unknown, field: string): string {
  if (typeof v !== "string" || !DATE.test(v)) throw invalid(`${field} deve ser AAAA-MM-DD.`);
  const parsed = new Date(`${v}T00:00:00Z`);
  // Date.parse is lenient (2026-02-30 becomes March 2): require the date to survive a round trip.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== v) throw invalid(`${field} deve ser uma data válida.`);
  return v;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw invalid(`${field} inválido.`);
  return v as T;
}

export function tenant(v: unknown): Tenant {
  const o = asObject(v, "tenant");
  return { organization_id: id(o.organization_id, "organization_id"), workspace_id: id(o.workspace_id, "workspace_id") };
}
