import type { RpcMap, RpcMethod, Tenant } from "./types";

/** The slice of `google.script.run` the console uses (the Apps Script client, injected into the page by the platform). */
interface ScriptRun {
  withSuccessHandler(fn: (text: string) => void): ScriptRun;
  withFailureHandler(fn: () => void): ScriptRun;
  rpc(requestJson: string): void;
}
declare const google: { script: { run: ScriptRun } };

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: string[] = [],
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; details?: string[] }; requestId?: string };

/** How many requests are in flight: the thin bar at the top of the page listens to it. */
let pending = 0;
const listeners = new Set<(n: number) => void>();
function busy(delta: number): void {
  pending = Math.max(0, pending + delta);
  listeners.forEach((fn) => fn(pending));
}
export function onBusy(fn: (n: number) => void): () => void {
  listeners.add(fn);
  fn(pending);
  return () => listeners.delete(fn);
}

/** One call to the server. The payload is JSON text both ways: nothing but data crosses (never markup, never code). */
export function call<M extends RpcMethod>(method: M, payload?: RpcMap[M][0]): Promise<RpcMap[M][1]> {
  busy(1);
  return new Promise((resolve, reject) => {
    google.script.run
      .withSuccessHandler((text) => {
        busy(-1);
        let res: Envelope<RpcMap[M][1]>;
        try {
          res = JSON.parse(text) as Envelope<RpcMap[M][1]>;
        } catch {
          reject(new ApiError("INTERNAL", "Resposta inválida do servidor."));
          return;
        }
        if (res.ok) resolve(res.data);
        else reject(new ApiError(res.error.code, res.error.message, res.error.details ?? [], res.requestId));
      })
      .withFailureHandler(() => {
        busy(-1);
        reject(new ApiError("UNAVAILABLE", "Não foi possível falar com o servidor."));
      })
      .rpc(JSON.stringify({ method, payload: payload ?? {} }));
  });
}

/** A call scoped to one workspace: the tenant is added to every payload here, so a view cannot forget it or send another one. */
export type TenantApi = <M extends RpcMethod>(method: M, payload?: RpcMap[M][0]) => Promise<RpcMap[M][1]>;
export function tenantApi(tenant: Tenant): TenantApi {
  return (method, payload) => call(method, { tenant, ...(payload ?? {}) } as RpcMap[typeof method][0]);
}
