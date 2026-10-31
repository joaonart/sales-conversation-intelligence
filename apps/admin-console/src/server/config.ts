import { AppError } from "./errors";

export interface Config {
  project: string;
  location: string;
  configDataset: string;
  analyticsDataset: string;
  sourceDataset: string;
  allowedDomain: string;
  bootstrapAdmins: ReadonlyArray<{ email: string; organization_id: string; workspace_id: string }>;
  maxBytesBilled: number;
  /** Guard rails for execution requests made in the console (ADMIN only). */
  exec: {
    maxCostUsd: number;
    maxSessions: number;
  };
}

export interface PropertyReader {
  getProperty(key: string): string | null;
}

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const DATASET = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;
const DOMAIN = /^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/;

/** A strictly positive number from the script properties, or the default when it is not set. A bad value is a configuration error, not a silent default. */
function positive(props: PropertyReader, key: string, fallback: number): number {
  const raw = props.getProperty(key);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new AppError("UNAVAILABLE", `Configuração inválida: ${key}.`);
  return n;
}

export function loadConfig(props: PropertyReader): Config {
  const need = (k: string, re: RegExp): string => {
    const v = props.getProperty(k);
    if (!v || !re.test(v)) throw new AppError("UNAVAILABLE", `Configuração ausente ou inválida: ${k}.`);
    return v;
  };
  let bootstrap: Config["bootstrapAdmins"] = [];
  const raw = props.getProperty("BOOTSTRAP_ADMINS");
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("not a list");
      bootstrap = parsed.map((p: Record<string, unknown>) => ({
        email: String(p.email ?? "").toLowerCase(),
        organization_id: String(p.organization_id ?? ""),
        workspace_id: String(p.workspace_id ?? ""),
      }));
    } catch {
      throw new AppError("UNAVAILABLE", "Configuração inválida: BOOTSTRAP_ADMINS.");
    }
  }
  return {
    project: need("GCP_PROJECT", PROJECT),
    location: props.getProperty("BQ_LOCATION") ?? "US",
    configDataset: props.getProperty("CONFIG_DATASET") ?? "conversation_config",
    analyticsDataset: props.getProperty("ANALYTICS_DATASET") ?? "conversation_analytics",
    sourceDataset: props.getProperty("SOURCE_DATASET") ?? "commerce",
    allowedDomain: need("ALLOWED_DOMAIN", DOMAIN),
    bootstrapAdmins: bootstrap,
    maxBytesBilled: Number(props.getProperty("MAX_BYTES_BILLED") ?? 200 * 1024 * 1024),
    exec: {
      maxCostUsd: positive(props, "EXEC_MAX_COST_USD", 1),
      maxSessions: positive(props, "EXEC_MAX_SESSIONS", 1000),
    },
  };
}

export function assertDatasets(c: Config): void {
  for (const d of [c.configDataset, c.analyticsDataset, c.sourceDataset]) {
    if (!DATASET.test(d)) throw new AppError("UNAVAILABLE", "Configuração inválida: nome de dataset.");
  }
}
