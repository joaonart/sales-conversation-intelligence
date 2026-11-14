import { describe, expect, it } from "vitest";
import type { TenantApi } from "../../src/ui/lib/api";
import { DASHBOARD_GROUPS, OVERVIEW_GROUPS, loadDashboardSummary, loadPipelineOverview } from "../../src/ui/lib/parts";

/** An api whose calls stay open until released, so we can see how many are in flight together. */
function slowApi(answer: (method: string, parts: string[]) => object) {
  const open: Array<() => void> = [];
  const log: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const api = ((method: string, payload: Record<string, unknown>) => {
    log.push({ method, payload });
    return new Promise((resolve) => open.push(() => resolve(answer(method, payload.parts as string[]))));
  }) as unknown as TenantApi;
  return { api, log, release: () => open.splice(0).forEach((f) => f()) };
}
const byKey = (_m: string, parts: string[]) => Object.fromEntries(parts.map((k) => [k, [{ k }]]));

describe("a page made of several queries is asked for in concurrent calls", () => {
  it("fires every group at once (before any answer), and puts the answers together", async () => {
    const s = slowApi(byKey);
    const done = loadDashboardSummary(s.api, 30);
    expect(s.log).toHaveLength(DASHBOARD_GROUPS.length); // all in flight before the first answer: the wait is the slowest call, not the sum
    expect(s.log.every((c) => c.method === "dashboard.summary" && c.payload.days === 30)).toBe(true);
    s.release();
    const got = (await done) as unknown as Record<string, unknown>;
    expect(Object.keys(got).sort()).toEqual(DASHBOARD_GROUPS.flat().sort());
  });

  it("the overview is asked for in its groups, with the live figures in a group of their own", async () => {
    const s = slowApi(byKey);
    const done = loadPipelineOverview(s.api);
    expect(s.log.map((c) => c.payload.parts)).toEqual(OVERVIEW_GROUPS);
    expect(OVERVIEW_GROUPS[0]).toEqual(["execVisible", "executor", "schedules"]);
    s.release();
    expect(Object.keys((await done) as object).sort()).toEqual(OVERVIEW_GROUPS.flat().sort());
  });

  it("one failed call fails the page (never a half page presented as whole)", async () => {
    const api = ((_m: string, p: { parts: string[] }) => (p.parts.includes("runs") ? Promise.reject(new Error("falhou")) : Promise.resolve(byKey("", p.parts)))) as unknown as TenantApi;
    await expect(loadDashboardSummary(api, 7)).rejects.toThrow("falhou");
  });
});
