import { afterEach, describe, expect, it, vi } from "vitest";
import { AppsScriptBq, s, i } from "../src/server/bq";
import { AppError } from "../src/server/errors";

type Req = { query: string; queryParameters: Array<Record<string, unknown>>; maximumBytesBilled: string; parameterMode: string; useLegacySql: boolean };

function install(impl: (req: Req) => unknown): { requests: Req[] } {
  const requests: Req[] = [];
  vi.stubGlobal("BigQuery", {
    Jobs: {
      query: (req: Req) => (requests.push(req), impl(req)),
      getQueryResults: () => ({ jobComplete: true, schema: { fields: [] }, rows: [] }),
    },
  });
  vi.stubGlobal("Utilities", { sleep: () => undefined });
  return { requests };
}

afterEach(() => vi.unstubAllGlobals());
const client = () => new AppsScriptBq("proj-123456", "US", 5_000_000);

describe("AppsScriptBq", () => {
  it("sends named, typed parameters and a bytes-billed cap; never legacy SQL", () => {
    const { requests } = install(() => ({ jobComplete: true, schema: { fields: [] }, rows: [] }));
    client().run("SELECT @a, @n, @arr, @rows", {
      a: s("x"),
      n: i(null),
      arr: { t: "ARRAY", of: "STRING", v: ["p", "q"] },
      rows: { t: "STRUCTS", fields: { k: "STRING", w: "FLOAT64" }, v: [{ k: "a", w: 1.5 }] },
    });
    const r = requests[0]!;
    expect(r.useLegacySql).toBe(false);
    expect(r.parameterMode).toBe("NAMED");
    expect(r.maximumBytesBilled).toBe("5000000");
    const by = Object.fromEntries(r.queryParameters.map((p) => [p.name as string, p]));
    expect(by.a).toMatchObject({ parameterType: { type: "STRING" }, parameterValue: { value: "x" } });
    expect(by.n).toMatchObject({ parameterType: { type: "INT64" }, parameterValue: {} });
    expect(by.arr).toMatchObject({ parameterType: { type: "ARRAY", arrayType: { type: "STRING" } }, parameterValue: { arrayValues: [{ value: "p" }, { value: "q" }] } });
    expect(JSON.stringify(by.rows)).toContain('"structTypes"');
  });

  it("converts BigQuery cells to typed values", () => {
    install(() => ({
      jobComplete: true,
      schema: { fields: [{ name: "n", type: "INTEGER" }, { name: "x", type: "FLOAT" }, { name: "ok", type: "BOOLEAN" }, { name: "t", type: "TIMESTAMP" }, { name: "ids", type: "STRING", mode: "REPEATED" }, { name: "z", type: "STRING" }] },
      rows: [{ f: [{ v: "3" }, { v: "2.5" }, { v: "true" }, { v: "1767225600" }, { v: [{ v: "a" }, { v: "b" }] }, { v: null }] }],
    }));
    expect(client().run("SELECT 1")[0]).toEqual({ n: 3, x: 2.5, ok: true, t: "2026-01-01T00:00:00.000Z", ids: ["a", "b"], z: null });
  });

  it("maps our RAISE sentinel to CONFLICT and hides every other BigQuery message", () => {
    install(() => { throw new Error("Query error: SCI_CONFLICT at [3:1]"); });
    expect(() => client().run("x")).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    install(() => { throw new Error("Access Denied: Table proj-123456:conversation_config.app_users SECRET"); });
    try {
      client().run("x");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe("UNAVAILABLE");
      expect((e as AppError).message).not.toContain("SECRET");
    }
  });

  it("logs a reason without quoted values", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    install(() => { throw new Error("Cannot parse 'joao@empresa.com' as TIMESTAMP"); });
    expect(() => client().run("x")).toThrow();
    expect(String(log.mock.calls[0]?.[0])).not.toContain("joao@empresa.com");
    log.mockRestore();
  });

  it("refuses truncated results instead of silently returning a partial page", () => {
    install(() => ({ jobComplete: true, schema: { fields: [] }, rows: [], pageToken: "more" }));
    expect(() => client().run("x")).toThrowError(expect.objectContaining({ code: "UNAVAILABLE" }));
  });
});
