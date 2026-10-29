import type { Config } from "./config";

/** Fully-qualified, validated table names. Identifiers never come from user input. */
export class Tables {
  constructor(private readonly c: Config) {}
  private t(dataset: string, table: string): string {
    return `\`${this.c.project}.${dataset}.${table}\``;
  }
  get users(): string { return this.t(this.c.configDataset, "app_users"); }
  get audit(): string { return this.t(this.c.configDataset, "audit_log"); }
  get decisions(): string { return this.t(this.c.configDataset, "review_decisions"); }
  get rubrics(): string { return this.t(this.c.configDataset, "evaluation_rubrics"); }
  get criteria(): string { return this.t(this.c.configDataset, "evaluation_criteria"); }
  get policies(): string { return this.t(this.c.configDataset, "evaluation_policies"); }
  get sessions(): string { return this.t(this.c.sourceDataset, "sessions"); }
  get messages(): string { return this.t(this.c.sourceDataset, "messages"); }
  get results(): string { return this.t(this.c.analyticsDataset, "current_session_results"); }
  get criterionResultsRaw(): string { return this.t(this.c.analyticsDataset, "session_criterion_results"); }
  get runs(): string { return this.t(this.c.analyticsDataset, "latest_analysis_runs"); }
  get dailyQuality(): string { return this.t(this.c.analyticsDataset, "gold_daily_quality"); }
  get dailyCost(): string { return this.t(this.c.analyticsDataset, "gold_cost_daily"); }
  get runHealth(): string { return this.t(this.c.analyticsDataset, "gold_run_health"); }
  get reviewQueue(): string { return this.t(this.c.analyticsDataset, "review_queue"); }
}

/** Every tenant-scoped statement uses exactly this predicate with the @org/@ws parameters. */
export const TENANT = "organization_id = @org AND workspace_id = @ws";
export const TENANT_ALIASED = (a: string): string => `${a}.organization_id = @org AND ${a}.workspace_id = @ws`;
