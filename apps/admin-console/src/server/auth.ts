import type { Bq } from "./bq";
import { s } from "./bq";
import type { Config } from "./config";
import { AppError, forbidden } from "./errors";
import type { Tables } from "./sql";
import { ROLE_RANK, ROLES, type Actor, type Membership, type Role, type Tenant } from "./types";

export interface Cache {
  get(key: string): string | null;
  put(key: string, value: string, ttlSeconds: number): void;
  remove(key: string): void;
}

export const MEMBERSHIP_TTL_SECONDS = 30;

/** Normalises the Google identity and enforces the Workspace domain. The email is never taken from a request body. */
export function authenticate(rawEmail: string | null | undefined, cfg: Pick<Config, "allowedDomain">): string {
  const email = (rawEmail ?? "").trim().toLowerCase();
  if (!email) throw new AppError("UNAUTHENTICATED", "Não foi possível identificar o usuário. Entre com a conta corporativa.");
  if (!email.endsWith(`@${cfg.allowedDomain}`)) throw forbidden("Conta fora do domínio autorizado.");
  return email;
}

export class AccessControl {
  constructor(
    private readonly bq: Bq,
    private readonly t: Tables,
    private readonly cfg: Config,
    private readonly cache: Cache,
    private readonly onBootstrap: (email: string, tenant: Tenant) => void,
  ) {}

  private key(email: string): string {
    return `mem:${email}`;
  }

  invalidate(email: string): void {
    this.cache.remove(this.key(email));
  }

  /** Active memberships of the caller. Revocations take effect within MEMBERSHIP_TTL_SECONDS (or immediately via invalidate). */
  resolve(email: string): Actor {
    const cached = this.cache.get(this.key(email));
    if (cached) return { email, memberships: JSON.parse(cached) as Membership[] };
    let rows = this.load(email);
    if (rows.length === 0 && this.hasAnyRow(email) === false) rows = this.bootstrap(email);
    this.cache.put(this.key(email), JSON.stringify(rows), MEMBERSHIP_TTL_SECONDS);
    return { email, memberships: rows };
  }

  private load(email: string): Membership[] {
    // The status filter must apply to the latest row only, so filter after the window.
    const latest =
      `SELECT organization_id, workspace_id, role, status FROM ${this.t.users} WHERE email = @email ` +
      "QUALIFY ROW_NUMBER() OVER (PARTITION BY organization_id, workspace_id ORDER BY changed_at DESC) = 1";
    return this.bq
      .run(latest, { email: s(email) })
      .filter((r) => r.status === "ACTIVE" && ROLES.includes(r.role as Role))
      .map((r) => ({ organization_id: String(r.organization_id), workspace_id: String(r.workspace_id), role: r.role as Role }));
  }

  private hasAnyRow(email: string): boolean {
    return this.bq.run(`SELECT 1 AS x FROM ${this.t.users} WHERE email = @email LIMIT 1`, { email: s(email) }).length > 0;
  }

  /** First-run seed: only emails listed in the BOOTSTRAP_ADMINS script property, and only if they have never had a row. */
  private bootstrap(email: string): Membership[] {
    const entries = this.cfg.bootstrapAdmins.filter((b) => b.email === email);
    for (const e of entries) {
      this.bq.run(
        `INSERT INTO ${this.t.users} (organization_id, workspace_id, email, role, status, changed_at, changed_by) ` +
          "VALUES (@org, @ws, @email, 'ADMIN', 'ACTIVE', CURRENT_TIMESTAMP(), 'bootstrap')",
        { org: s(e.organization_id), ws: s(e.workspace_id), email: s(email) },
      );
      this.onBootstrap(email, { organization_id: e.organization_id, workspace_id: e.workspace_id });
    }
    return entries.map((e) => ({ organization_id: e.organization_id, workspace_id: e.workspace_id, role: "ADMIN" as Role }));
  }

  /** Tenant ids in a request are claims, not authorisation: the caller must hold a membership for them. */
  authorize(actor: Actor, tenant: Tenant, min: Role): Membership {
    const m = actor.memberships.find((x) => x.organization_id === tenant.organization_id && x.workspace_id === tenant.workspace_id);
    if (!m || ROLE_RANK[m.role] < ROLE_RANK[min]) throw forbidden();
    return m;
  }
}

