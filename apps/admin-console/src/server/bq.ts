import { AppError } from "./errors";
import type { Cell, Row } from "./types";

type Scalar = "STRING" | "INT64" | "FLOAT64" | "BOOL" | "DATE" | "TIMESTAMP";
export type Param =
  | { t: Scalar; v: string | number | boolean | null }
  | { t: "ARRAY"; of: Scalar; v: ReadonlyArray<string | number | boolean | null> }
  | { t: "STRUCTS"; fields: Readonly<Record<string, Scalar>>; v: ReadonlyArray<Readonly<Record<string, string | number | boolean | null>>> };
export type Params = Readonly<Record<string, Param>>;

export const s = (v: string | null): Param => ({ t: "STRING", v });
export const i = (v: number | null): Param => ({ t: "INT64", v });
export const f = (v: number | null): Param => ({ t: "FLOAT64", v });
export const b = (v: boolean): Param => ({ t: "BOOL", v });
export const d = (v: string): Param => ({ t: "DATE", v });
export const ts = (v: string | null): Param => ({ t: "TIMESTAMP", v });

/** Everything the server needs from BigQuery. Tests use an in-memory fake. */
export interface Bq {
  /** Runs one parameterised statement (query, DML or script) and returns at most `maxRows` rows. */
  run(sql: string, params?: Params, opts?: { maxRows?: number }): Row[];
}


function toParameter(name: string, p: Param): GoogleAppsScript.BigQuery.Schema.QueryParameter {
  const scalarValue = (v: string | number | boolean | null): GoogleAppsScript.BigQuery.Schema.QueryParameterValue => (v === null ? {} : { value: String(v) });
  if (p.t === "ARRAY") {
    return {
      name,
      parameterType: { type: "ARRAY", arrayType: { type: p.of } },
      parameterValue: { arrayValues: p.v.map(scalarValue) },
    };
  }
  if (p.t === "STRUCTS") {
    const structTypes = Object.entries(p.fields).map(([n, t]) => ({ name: n, type: { type: t } }));
    return {
      name,
      parameterType: { type: "ARRAY", arrayType: { type: "STRUCT", structTypes } },
      parameterValue: {
        arrayValues: p.v.map((row) => ({
          structValues: Object.fromEntries(Object.keys(p.fields).map((k) => [k, scalarValue(row[k] ?? null)])),
        })),
      },
    };
  }
  return { name, parameterType: { type: p.t }, parameterValue: scalarValue(p.v) };
}

function convert(field: GoogleAppsScript.BigQuery.Schema.TableFieldSchema, cell: unknown): Cell {
  const v = (cell as { v?: unknown } | null)?.v;
  if (v === null || v === undefined) return null;
  if (field.mode === "REPEATED") return (v as Array<{ v: unknown }>).map((x) => String(x.v));
  switch (field.type) {
    case "INTEGER":
    case "INT64":
    case "FLOAT":
    case "FLOAT64":
    case "NUMERIC":
    case "BIGNUMERIC":
      return Number(v);
    case "BOOLEAN":
    case "BOOL":
      return v === "true" || v === true;
    case "TIMESTAMP":
      return new Date(Number(v) * 1000).toISOString();
    default:
      return String(v);
  }
}

/** BigQuery advanced service (Apps Script). Every query is capped by maximumBytesBilled. */
export class AppsScriptBq implements Bq {
  constructor(
    private readonly project: string,
    private readonly location: string,
    private readonly maxBytesBilled: number,
  ) {}

  run(sql: string, params: Params = {}, opts: { maxRows?: number } = {}): Row[] {
    const maxRows = opts.maxRows ?? 1000;
    try {
      // maximumBytesBilled is part of the REST QueryRequest but missing from @types/google-apps-script.
      const request: GoogleAppsScript.BigQuery.Schema.QueryRequest & { maximumBytesBilled: string } = {
        query: sql,
        useLegacySql: false,
        parameterMode: "NAMED",
        queryParameters: Object.entries(params).map(([n, p]) => toParameter(n, p)),
        location: this.location,
        maximumBytesBilled: String(this.maxBytesBilled),
        timeoutMs: 20000,
        maxResults: maxRows,
      };
      let res = BigQuery.Jobs!.query(request, this.project);
      const jobId = res.jobReference?.jobId;
      for (let attempt = 0; !res.jobComplete && jobId && attempt < 20; attempt++) {
        Utilities.sleep(1000);
        res = BigQuery.Jobs!.getQueryResults(this.project, jobId, { location: this.location, maxResults: maxRows, timeoutMs: 5000 });
      }
      if (!res.jobComplete) throw new Error("query did not complete in time");
      if (res.pageToken) throw new Error("result exceeds the row limit");
      const fields = res.schema?.fields ?? [];
      return (res.rows ?? []).map((r) => Object.fromEntries(fields.map((fld, idx) => [fld.name ?? `c${idx}`, convert(fld, r.f?.[idx])])));
    } catch (e) {
      const raw = e instanceof Error ? e.message : "unknown";
      // The logged reason never carries quoted values, which could echo request data.
      const reason = raw.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "?").slice(0, 160);
      // Statements may RAISE one of our own sentinels; those map to a fixed, safe client error.
      if (raw.includes("SCI_CONFLICT")) throw new AppError("CONFLICT", "O item mudou ou não está mais em rascunho. Recarregue e tente de novo.");
      // Never forward other BigQuery text to the client: it can echo identifiers or SQL.
      console.error(JSON.stringify({ event: "bq_error", reason }));
      throw new AppError("UNAVAILABLE", "Falha ao consultar o BigQuery. Tente novamente.");
    }
  }
}
