import type { TenantApi } from "./api";
import type { DashboardSummary, PipelineOverview } from "./types";

/**
 * The server runs one query at a time per call, so a page made of many queries is asked for in a few calls at once (each with its `parts`) and
 * the answers are put together: the wait is the slowest call, not the sum. A failed call fails the page, like the single call did.
 */
export const DASHBOARD_GROUPS: string[][] = [["quality", "cost"], ["runs", "coverage"], ["models"]];
/** The first group has the live figures (executor queue, schedules), which the server never serves from its cache. */
export const OVERVIEW_GROUPS: string[][] = [
  ["execVisible", "executor", "schedules"],
  ["source", "results", "decided"],
  ["cost", "models", "rubricCount"],
  ["historicalRuns", "liveEvents", "lastRun"],
];

async function merged<T extends object>(groups: string[][], one: (parts: string[]) => Promise<T>): Promise<T> {
  const answers = await Promise.all(groups.map(one));
  return Object.assign({}, ...answers) as T;
}

export const loadDashboardSummary = (api: TenantApi, days: number): Promise<DashboardSummary> =>
  merged(DASHBOARD_GROUPS, (parts) => api("dashboard.summary", { days, parts }));

export const loadPipelineOverview = (api: TenantApi): Promise<PipelineOverview> => merged(OVERVIEW_GROUPS, (parts) => api("pipeline.overview", { parts }));
