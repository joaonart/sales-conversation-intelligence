import { createHash } from "node:crypto";
import type { Cache } from "../src/server/auth";
import type { Bq, Params } from "../src/server/bq";
import type { Config } from "../src/server/config";
import type { PeopleLookup } from "../src/server/profile";
import { createRpc, type Deps, type RpcResponse } from "../src/server/rpc";
import type { Row } from "../src/server/types";

export const CFG: Config = {
  project: "proj-123456",
  location: "US",
  configDataset: "conversation_config",
  analyticsDataset: "conversation_analytics",
  sourceDataset: "commerce",
  allowedDomain: "example.com",
  bootstrapAdmins: [],
  maxBytesBilled: 1_000_000,
  exec: { maxCostUsd: 1, maxSessions: 1000 },
};

export interface Call {
  sql: string;
  params: Params;
}

type Reply = Row[] | Error | ((call: Call) => Row[]);

export class FakeBq implements Bq {
  calls: Call[] = [];
  private handlers: Array<{ match: RegExp; reply: Reply }> = [];

  on(match: RegExp, reply: Reply): this {
    this.handlers.unshift({ match, reply });
    return this;
  }

  run(sql: string, params: Params = {}): Row[] {
    const call = { sql, params };
    this.calls.push(call);
    const h = this.handlers.find((x) => x.match.test(sql));
    if (!h) return [];
    if (h.reply instanceof Error) throw h.reply;
    return typeof h.reply === "function" ? h.reply(call) : h.reply;
  }

  /** Statements issued on behalf of the request: everything except the caller's own membership lookup/seed and audit inserts. */
  dataCalls(): Call[] {
    return this.calls.filter(
      (c) => !/WHERE email = @email/.test(c.sql) && !/INSERT INTO `[^`]*audit_log`/.test(c.sql) && !/INSERT INTO `[^`]*app_users`[^;]*'bootstrap'/.test(c.sql),
    );
  }
}

export class MemCache implements Cache {
  store = new Map<string, string>();
  get = (k: string): string | null => this.store.get(k) ?? null;
  put = (k: string, v: string, _ttlSeconds?: number): void => void this.store.set(k, v);
  remove = (k: string): void => void this.store.delete(k);
}

export interface Harness {
  bq: FakeBq;
  cache: MemCache;
  call: (method: string, payload?: Record<string, unknown>, as?: string | null) => RpcResponse;
  setUser: (email: string | null) => void;
}

export const A = { organization_id: "org-a", workspace_id: "ws-a" };
export const B = { organization_id: "org-b", workspace_id: "ws-b" };

/** memberships: email -> list of [tenant, role]. The fake answers the app_users lookup like BigQuery would. */
export function harness(memberships: Record<string, Array<[typeof A, string]>>, opts: { cfg?: Partial<Config>; people?: PeopleLookup; appUrl?: () => string | null } = {}): Harness {
  const bq = new FakeBq();
  const cache = new MemCache();
  let current: string | null = null;
  let n = 0;
  bq.on(/FROM `[^`]*app_users` WHERE email = @email QUALIFY/, (c) => {
    const email = String((c.params.email as { v: string }).v);
    return (memberships[email] ?? []).map(([t, role]) => ({ ...t, role, status: "ACTIVE" }));
  });
  bq.on(/SELECT 1 AS x FROM `[^`]*app_users`/, (c) => (memberships[String((c.params.email as { v: string }).v)] ? [{ x: 1 }] : []));
  const deps: Deps = {
    cfg: { ...CFG, ...opts.cfg },
    bq,
    cache,
    ...(opts.people ? { people: opts.people } : {}),
    ...(opts.appUrl ? { appUrl: opts.appUrl } : {}),
    activeUserEmail: () => current,
    platform: {
      newId: () => `id-${++n}`,
      sha256: (t) => createHash("sha256").update(t).digest("hex"),
      withLock: (fn) => fn(),
    },
  };
  const rpc = createRpc(deps);
  return {
    bq,
    cache,
    setUser: (e) => void (current = e),
    call: (method, payload = {}, as = "ana@example.com") => {
      current = as;
      return rpc(JSON.stringify({ method, payload }));
    },
  };
}

export const ok = (r: RpcResponse): unknown => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.data;
};

export const code = (r: RpcResponse): string => (r.ok ? "OK" : r.error.code);
