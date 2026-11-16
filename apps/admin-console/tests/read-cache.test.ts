import { describe, expect, it } from "vitest";
import { A, B, code, harness, ok, type Harness } from "./helpers";

const two = (): Harness =>
  harness({ "viewer@example.com": [[A, "VIEWER"]], "admin@example.com": [[A, "ADMIN"]], "other@example.com": [[B, "VIEWER"]], "both@example.com": [[A, "VIEWER"], [B, "VIEWER"]] });
const summary = (h: Harness, payload: Record<string, unknown> = {}, as = "viewer@example.com", tenant = A) => h.call("dashboard.summary", { tenant, ...payload }, as);
const overview = (h: Harness, payload: Record<string, unknown> = {}, as = "viewer@example.com") => h.call("pipeline.overview", { tenant: A, ...payload }, as);
const reads = (h: Harness): number => h.bq.dataCalls().length;

describe("the blocks of a page are asked for separately (parts)", () => {
  it("returns only the blocks asked for, and queries only for them", () => {
    const h = two();
    const only = ok(summary(h, { days: 30, parts: ["cost"] })) as Record<string, unknown>;
    expect(Object.keys(only)).toEqual(["cost"]);
    expect(reads(h)).toBe(1);
    const h2 = two();
    expect(Object.keys(ok(summary(h2, { days: 30 })) as object).sort()).toEqual(["cost", "coverage", "models", "quality", "runs", "steps"]); // no parts: all, as before
  });

  it("the groups the page uses cover every block exactly once", async () => {
    const { DASHBOARD_GROUPS, OVERVIEW_GROUPS } = await import("../src/ui/lib/parts");
    const h = two();
    const all = (m: "dashboard.summary" | "pipeline.overview", groups: string[][]) => {
      const keys = groups.flat();
      expect(new Set(keys).size).toBe(keys.length);
      const full = Object.keys(ok(h.call(m, { tenant: A }, "admin@example.com")) as object).sort();
      expect([...keys].sort()).toEqual(full);
    };
    all("dashboard.summary", DASHBOARD_GROUPS);
    all("pipeline.overview", OVERVIEW_GROUPS);
  });

  it("refuses an unknown, empty or malformed list of blocks instead of ignoring it", () => {
    const h = two();
    for (const parts of [["nope"], [], "cost", [1], ["cost", "cost", "cost", "cost", "cost", "cost", "cost"], null]) expect(code(summary(h, { parts })), JSON.stringify(parts)).toBe("INVALID_INPUT");
  });

  it("the executor and schedules blocks stay hidden from a VIEWER, also when asked for one by one", () => {
    const h = two();
    const v = ok(overview(h, { parts: ["executor", "schedules"] })) as { executor: unknown[]; schedules: unknown[] };
    expect(v.executor).toEqual([]);
    expect(v.schedules).toEqual([]);
    expect(h.bq.dataCalls().some((c) => /run_requests|run_schedules/.test(c.sql))).toBe(false);
  });
});

describe("a page's numbers are reused for a short while", () => {
  it("answers the same question again without querying", () => {
    const h = two();
    const first = ok(summary(h, { days: 30, parts: ["quality"] }));
    const n = reads(h);
    expect(ok(summary(h, { days: 30, parts: ["quality"] }))).toEqual(first);
    expect(reads(h)).toBe(n);
    // the key does not depend on the order of the keys of the payload
    expect(ok(h.call("dashboard.summary", { parts: ["quality"], days: 30, tenant: A }, "viewer@example.com"))).toEqual(first);
    expect(reads(h)).toBe(n);
  });

  it("another period, other blocks or another score grain are other questions", () => {
    const h = two();
    summary(h, { days: 30, parts: ["quality"] });
    const n = reads(h);
    summary(h, { days: 90, parts: ["quality"] });
    expect(reads(h)).toBe(n + 1);
    summary(h, { days: 30, parts: ["cost"] });
    expect(reads(h)).toBe(n + 2);
    h.call("dashboard.score", { tenant: A, granularity: "day", days: 30 }, "viewer@example.com");
    const m = reads(h);
    h.call("dashboard.score", { tenant: A, granularity: "day", days: 30 }, "viewer@example.com");
    expect(reads(h)).toBe(m);
    h.call("dashboard.score", { tenant: A, granularity: "month", days: 30 }, "viewer@example.com");
    expect(reads(h)).toBeGreaterThan(m);
  });

  it("is per workspace: an answer cached for one is never given for another, and access is checked before the cache", () => {
    const h = two();
    summary(h, { days: 30, parts: ["quality"] });
    const n = reads(h);
    // a person of workspace B asking about A is refused even though A's answer is cached
    expect(code(summary(h, { days: 30, parts: ["quality"] }, "other@example.com", A))).toBe("FORBIDDEN");
    // a person of both asking about B gets B's own query, not A's cached answer
    expect(code(summary(h, { days: 30, parts: ["quality"] }, "both@example.com", B))).toBe("OK");
    const q = h.bq.dataCalls().slice(n).find((c) => /daily_quality|quality/.test(c.sql));
    expect(q?.params.org).toEqual({ t: "STRING", v: "org-b" });
  });

  it("does not mix what an ADMIN may see with what a VIEWER may", () => {
    const h = two();
    overview(h, { parts: ["source"] }, "admin@example.com");
    const n = reads(h);
    overview(h, { parts: ["source"] }, "viewer@example.com");
    expect(reads(h)).toBe(n + 1); // the viewer's question is not answered with the admin's cached one
  });

  it("never reuses the live blocks (executor queue, schedules), nor a call without blocks", () => {
    const h = two();
    for (const parts of [["executor"], ["schedules"], ["execVisible", "executor", "schedules"]]) {
      overview(h, { parts }, "admin@example.com");
      const n = reads(h);
      overview(h, { parts }, "admin@example.com");
      expect(reads(h), JSON.stringify(parts)).toBeGreaterThan(n);
    }
    overview(h, {}, "admin@example.com");
    const n = reads(h);
    overview(h, {}, "admin@example.com");
    expect(reads(h)).toBeGreaterThan(n);
  });

  it("`fresh` skips the cache and renews it; a failed query is not cached", () => {
    const h = two();
    summary(h, { days: 30, parts: ["quality"] });
    const n = reads(h);
    summary(h, { days: 30, parts: ["quality"], fresh: true });
    expect(reads(h)).toBe(n + 1);
    const g = two();
    g.bq.on(/FROM `[^`]*daily_quality`/, new Error("boom") as never);
    expect(code(summary(g, { days: 30, parts: ["quality"] }))).not.toBe("OK");
    g.bq.on(/FROM `[^`]*daily_quality`/, []);
    expect(code(summary(g, { days: 30, parts: ["quality"] }))).toBe("OK"); // the failure was not kept
  });

  it("keeps the answer for the time stated, and writes are never cached", () => {
    const h = two();
    const ttls: number[] = [];
    const put = h.cache.put;
    h.cache.put = (k, v, t) => {
      if (k.startsWith("rc1:")) ttls.push(Number(t));
      put(k, v, t);
    };
    summary(h, { days: 30, parts: ["quality"] });
    overview(h, { parts: ["source"] });
    expect(ttls).toEqual([120, 60]);
    const w = two();
    expect(code(w.call("rubrics.list", { tenant: A }, "viewer@example.com"))).toBe("OK");
    expect([...w.cache.store.keys()].some((k) => k.startsWith("rc1:rubrics"))).toBe(false); // only the methods that ask for it are cached
  });
});
