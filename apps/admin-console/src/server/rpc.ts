import { Audit } from "./audit";
import { ProfileService, type PeopleLookup } from "./profile";
import { AccessControl, authenticate, type Cache } from "./auth";
import type { Bq } from "./bq";
import type { Config } from "./config";
import { AppError, invalid, type ErrorCode } from "./errors";
import { DashboardService, RunsService, SessionsService } from "./services/read";
import { ReviewService } from "./services/reviews";
import { RubricsService } from "./services/rubrics";
import { AuditLogService, UsersService } from "./services/users";
import { Tables } from "./sql";
import type { Actor, Role, Tenant } from "./types";
import * as v from "./validate";

export interface Platform {
  newId(): string;
  sha256(text: string): string;
  /** Serialises write operations across concurrent executions. */
  withLock<T>(fn: () => T): T;
}

export interface Deps {
  cfg: Config;
  bq: Bq;
  cache: Cache;
  platform: Platform;
  /** Optional directory lookup for the signed-in user's name and photo; without it the UI shows initials. */
  people?: PeopleLookup;
  /** Email from the Google session. */
  activeUserEmail: () => string | null | undefined;
}

interface Ctx {
  actor: Actor;
  tenant: Tenant;
  payload: Record<string, unknown>;
  requestId: string;
}

interface Method {
  min: Role;
  write: boolean;
  /** Metadata recorded in the audit trail for writes. Never message text. */
  details?: (payload: Record<string, unknown>, result: unknown) => Record<string, string | number | boolean | null>;
  run: (ctx: Ctx) => unknown;
}

export type RpcResponse = { ok: true; data: unknown; requestId: string } | { ok: false; error: { code: ErrorCode; message: string; details?: readonly string[] }; requestId: string };

const MAX_REQUEST_CHARS = 262_144;
const LIMITS = { read: 240, write: 40 };

export function buildRegistry(deps: Deps, audit: Audit, access: AccessControl): { methods: Record<string, Method>; tables: Tables } {
  const tables = new Tables(deps.cfg);
  const { bq } = deps;
  const dashboard = new DashboardService(bq, tables);
  const runs = new RunsService(bq, tables);
  const review = new ReviewService(bq, tables, deps.platform);
  const sessions = new SessionsService(bq, tables, audit);
  const rubrics = new RubricsService(bq, tables, deps.platform.sha256);
  const users = new UsersService(bq, tables, deps.cfg, access);
  const auditLog = new AuditLogService(bq, tables);
  const rid = (p: Record<string, unknown>): Record<string, string | number | boolean | null> => ({
    rubric_id: typeof p.rubric_id === "string" ? p.rubric_id : null,
    version: typeof p.version === "number" ? p.version : null,
  });
  const methods: Record<string, Method> = {
    "dashboard.summary": { min: "VIEWER", write: false, run: (c) => dashboard.summary(c.tenant, c.payload) },
    "runs.list": { min: "VIEWER", write: false, run: (c) => runs.list(c.tenant, c.payload) },
    "runs.count": { min: "VIEWER", write: false, run: (c) => runs.count(c.tenant, c.payload) },
    "review.list": { min: "VIEWER", write: false, run: (c) => review.list(c.tenant, c.payload) },
    "review.count": { min: "VIEWER", write: false, run: (c) => review.count(c.tenant, c.payload) },
    "review.decide": {
      min: "EDITOR", write: true,
      details: (p, r) => ({ session_id: typeof p.sessionId === "string" ? p.sessionId : null, analysis_id: (r as { analysis_id: string }).analysis_id, decision: (r as { decision: string }).decision, has_comment: typeof p.comment === "string" && p.comment.trim().length > 0 }),
      run: (c) => review.decide(c.actor.email, c.tenant, c.payload),
    },
    "sessions.list": { min: "VIEWER", write: false, run: (c) => sessions.list(c.tenant, c.payload) },
    "sessions.channels": { min: "VIEWER", write: false, run: (c) => sessions.channels(c.tenant, c.payload) },
    "sessions.count": { min: "VIEWER", write: false, run: (c) => sessions.count(c.tenant, c.payload) },
    "sessions.get": { min: "VIEWER", write: false, run: (c) => sessions.get(c.actor, c.tenant, c.payload, c.requestId) },
    "rubrics.list": { min: "VIEWER", write: false, run: (c) => rubrics.list(c.tenant, c.payload) },
    "rubrics.count": { min: "VIEWER", write: false, run: (c) => rubrics.count(c.tenant) },
    "rubrics.ids": { min: "VIEWER", write: false, run: (c) => rubrics.ids(c.tenant) },
    "rubrics.get": { min: "VIEWER", write: false, run: (c) => rubrics.get(c.tenant, c.payload.rubric_id, c.payload.version) },
    "rubrics.createDraft": {
      min: "EDITOR", write: true,
      details: (p, r) => ({ rubric_id: typeof p.rubric_id === "string" ? p.rubric_id : null, version: (r as { version: number }).version, cloned_from: typeof p.cloneFromVersion === "number" ? p.cloneFromVersion : null }),
      run: (c) => rubrics.createDraft(c.tenant, c.payload),
    },
    "rubrics.saveDraft": {
      min: "EDITOR", write: true,
      details: (p, r) => ({ ...rid(p), issues: (r as { issues: unknown[] }).issues.length, etag: (r as { etag: string }).etag }),
      run: (c) => rubrics.saveDraft(c.tenant, c.payload),
    },
    "rubrics.deleteDraft": { min: "EDITOR", write: true, details: (p) => rid(p), run: (c) => (rubrics.deleteDraft(c.tenant, c.payload), { deleted: true }) },
    "rubrics.publish": { min: "ADMIN", write: true, details: (p, r) => ({ ...rid(p), criteria: (r as { criteria: number }).criteria }), run: (c) => rubrics.publish(c.tenant, c.payload) },
    "users.list": { min: "ADMIN", write: false, run: (c) => users.list(c.tenant, c.payload) },
    "users.count": { min: "ADMIN", write: false, run: (c) => users.count(c.tenant) },
    "users.upsert": {
      min: "ADMIN", write: true,
      details: (_p, r) => ({ target: (r as { email: string }).email, role: (r as { role: string }).role, status: (r as { status: string }).status }),
      run: (c) => users.upsert(c.actor.email, c.tenant, c.payload),
    },
    "audit.list": { min: "ADMIN", write: false, run: (c) => auditLog.list(c.tenant, c.payload) },
    "audit.count": { min: "ADMIN", write: false, run: (c) => auditLog.count(c.tenant, c.payload) },
  };
  return { methods, tables };
}

function throttled(deps: Deps, email: string, write: boolean): boolean {
  const key = `rl:${write ? "w" : "r"}:${email}:${Math.floor(Date.now() / 60_000)}`;
  const n = Number(deps.cache.get(key) ?? "0") + 1;
  deps.cache.put(key, String(n), 90);
  return n > (write ? LIMITS.write : LIMITS.read);
}

export function createRpc(deps: Deps): (requestJson: string) => RpcResponse {
  const tables = new Tables(deps.cfg);
  const audit = new Audit(deps.bq, tables, () => deps.platform.newId());
  const access = new AccessControl(deps.bq, tables, deps.cfg, deps.cache, (email, tenant) =>
    audit.record({ actor: "bootstrap", tenant, action: "user.bootstrap_admin", entityType: "user", entityId: email, outcome: "SUCCESS", requestId: "bootstrap" }),
  );
  const { methods } = buildRegistry(deps, audit, access);
  const profiles = new ProfileService(deps.people, deps.cache);

  return (requestJson: string): RpcResponse => {
    const requestId = deps.platform.newId();
    let method = "unknown";
    let claimedTenant: Tenant | undefined;
    let actorEmail = "unknown";
    try {
      if (typeof requestJson !== "string" || requestJson.length > MAX_REQUEST_CHARS) throw invalid("Requisição inválida.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(requestJson);
      } catch {
        throw invalid("Requisição inválida.");
      }
      const req = v.asObject(parsed, "requisição");
      method = typeof req.method === "string" ? req.method : "";
      const payload = v.asObject(req.payload ?? {}, "payload");
      actorEmail = authenticate(deps.activeUserEmail(), deps.cfg);
      const actor = access.resolve(actorEmail);
      // The profile is looked up for the e-mail of the Google session only; nothing in the request can choose whose profile is returned.
      if (method === "me") return { ok: true, requestId, data: { email: actor.email, memberships: actor.memberships, profile: profiles.resolve(actor.email) } };
      const def = Object.prototype.hasOwnProperty.call(methods, method) ? methods[method] : undefined;
      if (!def) throw invalid("Método desconhecido.");
      claimedTenant = v.tenant(payload.tenant);
      if (throttled(deps, actor.email, def.write)) throw new AppError("RATE_LIMITED", "Muitas requisições. Aguarde um instante.");
      try {
        access.authorize(actor, claimedTenant, def.min);
      } catch (e) {
        audit.record({ actor: actor.email, tenant: claimedTenant, action: method, outcome: "DENIED", requestId });
        throw e;
      }
      const ctx: Ctx = { actor, tenant: claimedTenant, payload, requestId };
      const exec = (): unknown => def.run(ctx);
      const data = def.write ? deps.platform.withLock(exec) : exec();
      if (def.write) {
        audit.record({ actor: actor.email, tenant: claimedTenant, action: method, entityType: method.split(".")[0], entityId: typeof payload.rubric_id === "string" ? payload.rubric_id : undefined, outcome: "SUCCESS", details: def.details?.(payload, data), requestId });
      }
      return { ok: true, data, requestId };
    } catch (e) {
      if (e instanceof AppError) {
        return { ok: false, requestId, error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } };
      }
      // Unknown failure: log only the error type and the request id, never the message (it may echo data).
      console.error(JSON.stringify({ event: "rpc_error", method, requestId, errorType: e instanceof Error ? e.name : typeof e, actor: actorEmail }));
      return { ok: false, requestId, error: { code: "INTERNAL", message: `Erro interno. Informe o código ${requestId}.` } };
    }
  };
}

