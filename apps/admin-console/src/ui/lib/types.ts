/** What the server answers, as the client uses it. The tenant and role types come from the server itself, so the two cannot drift. */
import type { CriterionInput, EvaluationType, Membership, PolicyInput, Role, RubricDraftInput, Tenant } from "../../server/types";
import type { Issue } from "../../server/rubricRules";

export type EvaluationTypeName = EvaluationType;
export type { CriterionInput, EvaluationType, Issue, Membership, PolicyInput, Role, RubricDraftInput, Tenant };
export const ROLE_RANK: Record<Role, number> = { VIEWER: 1, EDITOR: 2, ADMIN: 3 };
export const ROLE_LABEL: Record<Role, string> = { VIEWER: "Leitor", EDITOR: "Editor", ADMIN: "Administrador" };

export interface Profile {
  name: string | null;
  photo_url: string | null;
}

export interface Me {
  email: string;
  memberships: Membership[];
  profile: Profile;
  app_url: string | null;
}

/** A keyset page: the server hands back the cursor of the next one, never an offset. */
export interface Page<T> {
  rows: T[];
  nextCursor: unknown;
}

export interface AuditEvent {
  event_id: string;
  occurred_at: string;
  actor_email: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  outcome: string;
  details: string | null;
  request_id: string | null;
}

export interface AuditFilters {
  from: string;
  to: string;
  actor: string;
  action: string;
  outcome: string;
  entity: string;
}

export interface AuditFacets {
  actors: string[];
  actions: string[];
  outcomes: string[];
}

export type ListPayload<F> = F & { limit?: number; cursor?: unknown };

export interface RubricRow {
  rubric_id: string;
  version: number;
  name: string;
  status: "DRAFT" | "PUBLISHED";
  published_at: string | null;
  created_at: string | null;
  description: string | null;
}
export interface RubricFilters {
  query: string;
  status: string;
}
export interface RubricView {
  header: RubricRow;
  draft: RubricDraftInput;
  etag: string;
  issues: Issue[];
}


export interface UserRow { email: string; role: Role; status: "ACTIVE" | "DISABLED"; changed_at: string | null; changed_by: string | null }
export interface UserFilters { query: string; role: string; status: string }

export interface ReviewRow {
  session_id: string; rubric_id: string; rubric_version: number; completed_at: string | null;
  decision: string | null; reviewer_email: string | null; decided_at: string | null; insufficient: number; criteria: number;
}
export interface ReviewFilters { filter: string; from: string; to: string; reason: string; rubric: string; decision: string; reviewer: string; query: string }

export interface RunRow {
  run_id: string; processing_mode: string | null; run_status: string; rubric_id: string | null; rubric_version: number | null;
  sessions_total: number; sessions_processed: number; sessions_failed: number; sessions_skipped: number;
  actual_cost_usd: number | null; estimated_cost_usd: number | null; created_at: string | null; finished_at: string | null;
}
export interface RunFilters { from: string; to: string; status: string; mode: string; rubric: string; query: string }
export interface RunSessionRow { session_id: string; analysis_status: string; overall_score: number | null; approval_status: string | null; model: string | null; estimated_cost_usd: number | null; completed_at: string | null }
export interface RunFailureRow { session_id: string | null; stage: string; error_code: string; error_type: string | null; http_status: number | null; provider_code: string | null; occurred_at: string | null }
export interface RunDetail { run: RunRow; failures: { available: boolean; total: number; by_code: Array<{ error_code: string; n: number }> } }

export interface ExecRow {
  request_id: string; kind: string; status: string; params: string | null; result: string | null; error: string | null;
  max_cost_usd: number | null; estimate_high_usd: number | null; requested_by: string; requested_at: string | null;
}
export interface ExecFilters { from: string; to: string; status: string; kind: string; rubric: string; requested_by: string; query: string }
export interface ModelChoice { provider: string; model: string; validated: boolean; input_per_million: number; output_per_million: number; verified_on: string }
export interface ModelCatalog { models: ModelChoice[]; default: { provider: string; model: string } }
export interface ExecPreview {
  model: string; provider: string; to_process: number; sessions: number; already: number; approx_input_tokens: number;
  estimate_low_usd: number; estimate_high_usd: number; max_cost_usd: number; within_ceiling: boolean; notes: string[];
}
export interface ScheduleRow {
  schedule_id: string; name: string; status: "ACTIVE" | "PAUSED" | "ARCHIVED"; frequency: "DAILY" | "WEEKLY"; weekday: number | null; hour_utc: number; minute_utc: number;
  rubric_id: string; rubric_version: number; window_days: number; max_sessions: number; only_routed: boolean; provider: string; model: string; max_cost_usd: number;
  next_run: string | null; last_request_id: string | null; last_status: string | null; last_requested_at: string | null;
}


export interface SessionMessage { message_id: string; sender_type: string; content: string; created_at: string | null; sequence_number: number | null }
export interface SessionAnalysis {
  analysis_id: string; rubric_id: string; rubric_version: number; analysis_status: string; approval_status: string | null; approval_reason?: unknown; analysis_mode?: string;
  overall_score: number | null; model: string | null; prompt_version: string | null; estimated_cost_usd: number | null; completed_at: string | null;
}
export interface CriterionResult {
  analysis_id: string; criterion_id: string; criterion_name?: string | null; applicability_status: string; normalized_score: number | null; criterion_weight: number | null;
  weighted_score?: number | null; evaluation_result: string | null; evidence_message_ids: string[] | null; confidence: number | null;
}
export interface ReviewDecisionRow { analysis_id: string; decision: string; reviewer_email: string | null; decided_at: string | null; comment: string | null }
/** What the general evaluation of an analysis stored; the lists are JSON text of [{ text, message_ids }]. */
export interface SummaryRow {
  analysis_id: string; overall_summary: string | null; strengths: string | null; weaknesses: string | null; opportunities: string | null;
  model: string | null; summary_prompt_hash: string | null;
}
export interface SessionDetail {
  session: { session_id: string; channel?: string | null; started_at?: string | null; status?: string | null };
  summaries?: SummaryRow[];
  truncated?: boolean;
  messages: SessionMessage[];
  analyses: SessionAnalysis[];
  criteria: CriterionResult[];
  decisions?: ReviewDecisionRow[];
}
export interface SessionListRow {
  session_id: string; channel: string | null; started_at: string | null; analysis_status: string | null; approval_status: string | null;
  overall_score: number | null; rubric_id: string | null; rubric_version: number | null;
}
export interface SessionFilters {
  from: string; to: string; status: string; result: string; channel: string; rubric: string; query: string; analysed_from: string; analysed_to: string;
}

/** The numbers behind the architecture diagram: each field is the rows of one small query (administrators also get the executor's). */
export interface PipelineOverview {
  source?: Array<{ sessions: number }>;
  cost?: Array<{ analyses: number; cost_usd: number }>;
  results?: Array<{ analyses: number }>;
  decided?: Array<{ decided: number }>;
  rubricCount?: Array<{ total: number; published: number }>;
  historicalRuns?: Array<{ runs: number }>;
  lastRun?: Array<{ processing_mode: string; created_at: string }>;
  liveEvents?: Array<{ run_status: string; events: number; last_at: string | null }>;
  models?: Array<{ provider: string; model: string; analysis_mode: string; analyses: number; current_analyses?: number; cost_usd: number }>;
  execVisible?: Array<{ visible: boolean }>;
  executor?: Array<{ status: string; requests: number; oldest_at: string | null; last_at: string | null }>;
  schedules?: Array<{ active: number; paused: number; next_run: string | null }>;
}

export interface DashboardSummary {
  quality: Array<{ sessions: number; scored_sessions: number; avg_score: number | null; approved: number; rejected: number; needs_review: number; not_evaluable: number }>;
  cost: Array<{ day: string; analysis_mode: string; model: string; analyses: number; cost_usd: number; avg_duration_ms: number | null }>;
  runs: Array<{ day: string; processing_mode: string; run_status: string; runs: number; sessions_processed: number; sessions_failed: number; actual_cost_usd: number }>;
  coverage: Array<{ analysed: number; sessions: number }>;
  models: Array<{ provider: string; model: string; analyses: number; current_analyses: number; cost_usd: number; completed: number }>;
}

/** method -> [payload, response]. Grows with each screen that is ported; an unknown method does not compile. */
export interface RpcMap {
  me: [undefined, Me];
  "audit.list": [ListPayload<AuditFilters>, Page<AuditEvent>];
  "audit.count": [AuditFilters, { total: number }];
  "audit.facets": [{ from: string; to: string }, AuditFacets];
  "audit.get": [{ event_id: string }, AuditEvent];
  "rubrics.list": [ListPayload<RubricFilters>, Page<RubricRow>];
  "rubrics.count": [RubricFilters, { total: number }];
  "rubrics.get": [{ rubric_id: string; version: number }, RubricView];
  "rubrics.createDraft": [{ rubric_id: string; name: string; cloneFromVersion?: number }, { version: number }];
  "rubrics.saveDraft": [{ rubric_id: string; version: number; etag: string; draft: RubricDraftInput }, { etag: string; issues: Issue[] }];
  "rubrics.deleteDraft": [{ rubric_id: string; version: number }, { deleted: true }];
  "sessions.get": [{ sessionId: string }, SessionDetail];
  "sessions.list": [ListPayload<Partial<SessionFilters>>, Page<SessionListRow>];
  "sessions.count": [SessionFilters, { total: number; sessions?: number }];
  "sessions.channels": [{ from: string; to: string }, string[]];
  "rubrics.ids": [undefined, string[]];
  "review.decide": [{ sessionId: string; analysisId: string; decision: string; comment: string }, unknown];
  "pipeline.overview": [Record<string, never>, PipelineOverview];
  "dashboard.summary": [{ days: number }, DashboardSummary];
  "dashboard.score": [{ granularity: string; days: number }, { rows: Array<{ bucket: string; avg_score: number | null }> }];
  "users.list": [ListPayload<UserFilters>, Page<UserRow>];
  "users.count": [UserFilters, { total: number }];
  "users.upsert": [{ email: string; role: string; status: string }, unknown];
  "review.list": [ListPayload<Partial<ReviewFilters>>, Page<ReviewRow>];
  "review.count": [ReviewFilters, { total: number }];
  "review.facets": [{ from: string; to: string }, { rubrics: string[]; reviewers: string[] }];
  "runs.list": [ListPayload<RunFilters>, Page<RunRow>];
  "runs.count": [RunFilters, { total: number }];
  "runs.facets": [{ from: string; to: string }, { statuses: string[]; modes: string[]; rubrics: string[] }];
  "runs.get": [{ run_id: string }, RunDetail];
  "runs.sessions": [{ run_id: string; limit?: number; cursor?: unknown }, Page<RunSessionRow> & { basis?: string }];
  "runs.failures": [{ run_id: string; limit?: number; cursor?: unknown }, Page<RunFailureRow>];
  "executions.list": [ListPayload<ExecFilters>, Page<ExecRow>];
  "executions.facets": [{ from: string; to: string }, { statuses: string[]; kinds: string[]; rubrics: string[]; requesters: string[] }];
  "executions.models": [Record<string, never>, ModelCatalog];
  "executions.preview": [Record<string, unknown>, ExecPreview];
  "executions.request": [Record<string, unknown>, unknown];
  "executions.cancel": [{ request_id: string }, unknown];
  "schedules.list": [Record<string, never>, { rows: ScheduleRow[] }];
  "schedules.create": [Record<string, unknown>, unknown];
  "schedules.setStatus": [{ schedule_id: string; action: string }, unknown];
  "rubrics.publish": [{ rubric_id: string; version: number; etag: string }, { version: number; criteria: number }];
}
export type RpcMethod = keyof RpcMap;
