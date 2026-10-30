/** Apps Script entry points. Everything here is a thin adapter over testable modules. */
import { authenticate, type Cache } from "./auth";
import { AppsScriptBq } from "./bq";
import { assertDatasets, loadConfig, type Config } from "./config";
import { AppError } from "./errors";
import { AppsScriptPeople, diagnose } from "./profile";
import { createRpc, type Deps, type RpcResponse } from "./rpc";

const APP_VERSION = "0.15.3"; // keep equal to package.json (tests/account.test.ts)

const cache: Cache = {
  get: (k) => CacheService.getScriptCache().get(k),
  put: (k, v, ttl) => CacheService.getScriptCache().put(k, v, ttl),
  remove: (k) => CacheService.getScriptCache().remove(k),
};

function config(): Config {
  const cfg = loadConfig(PropertiesService.getScriptProperties());
  assertDatasets(cfg);
  return cfg;
}

function sha256Hex(text: string): string {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map((b) => ((b < 0 ? b + 256 : b) as number).toString(16).padStart(2, "0")).join("");
}

let handler: ((json: string) => RpcResponse) | null = null;

function getHandler(): (json: string) => RpcResponse {
  if (handler) return handler;
  const cfg = config();
  const deps: Deps = {
    cfg,
    bq: new AppsScriptBq(cfg.project, cfg.location, cfg.maxBytesBilled),
    cache,
    people: new AppsScriptPeople(),
    // A failure here only means the sign-out button cannot send the person back to the console afterwards; it must never stop anyone from signing in.
    appUrl: () => {
      try {
        return ScriptApp.getService().getUrl() || null;
      } catch {
        return null;
      }
    },
    activeUserEmail: () => Session.getActiveUser().getEmail(),
    platform: {
      newId: () => Utilities.getUuid(),
      sha256: sha256Hex,
      withLock: <T,>(fn: () => T): T => {
        const lock = LockService.getScriptLock();
        if (!lock.tryLock(15_000)) throw new AppError("UNAVAILABLE", "Outra alteração está em andamento. Tente novamente.");
        try {
          return fn();
        } finally {
          lock.releaseLock();
        }
      },
    },
  };
  handler = createRpc(deps);
  return handler;
}

function page(title: string, message: string): GoogleAppsScript.HTML.HtmlOutput {
  // Static text only: nothing from the request or from errors is interpolated.
  return HtmlService.createHtmlOutput(`<main style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem"><h1>${title}</h1><p>${message}</p></main>`).setTitle(title);
}

function doGet(): GoogleAppsScript.HTML.HtmlOutput {
  try {
    const cfg = config();
    authenticate(Session.getActiveUser().getEmail(), cfg);
  } catch (e) {
    if (e instanceof AppError && (e.code === "UNAUTHENTICATED" || e.code === "FORBIDDEN")) {
      return page("Acesso restrito", "Entre com uma conta corporativa autorizada para usar este console.");
    }
    return page("Console indisponível", "O console não está configurado. Procure o administrador.");
  }
  const tpl = HtmlService.createTemplateFromFile("index");
  (tpl as unknown as { appVersion: string }).appVersion = APP_VERSION;
  return tpl.evaluate().setTitle("SCI Console").addMetaTag("viewport", "width=device-width, initial-scale=1");
}

/**
 * Run once from the Apps Script editor by the deployer (Run -> authorize): it triggers the OAuth consent for every scope in the manifest and
 * proves the BigQuery path end to end with `SELECT 1`. The web app executes as the deployer, so this consent must exist before anyone can use it.
 */
function authorize(): string {
  const cfg = config();
  const rows = new AppsScriptBq(cfg.project, cfg.location, cfg.maxBytesBilled).run("SELECT 1 AS ok");
  // The People API needs its own consent (directory.readonly). Failing here only means the UI shows initials instead of a photo.
  let directory = "ok";
  let profile: unknown = null;
  try {
    profile = diagnose(new AppsScriptPeople(), Session.getActiveUser().getEmail().toLowerCase());
  } catch (e) {
    directory = "unavailable";
    profile = { errorType: e instanceof Error ? e.name : typeof e, message: e instanceof Error ? e.message.slice(0, 200) : "" };
  }
  const result = { event: "authorize_ok", project: cfg.project, rows: rows.length, directory, profile, app_url: (() => { try { return Boolean(ScriptApp.getService().getUrl()); } catch { return false; } })() };
  console.log(JSON.stringify(result));
  return JSON.stringify(result);
}

/** Used by the HTML templates: <?!= include('styles') ?> */
function include(name: string): string {
  if (!/^[a-z]+$/.test(name)) throw new Error("invalid include");
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Called by the client through google.script.run. Always returns a JSON string. */
function rpc(requestJson: string): string {
  try {
    return JSON.stringify(getHandler()(requestJson));
  } catch (e) {
    const code = e instanceof AppError ? e.code : "INTERNAL";
    const message = e instanceof AppError ? e.message : "Erro interno.";
    return JSON.stringify({ ok: false, requestId: "none", error: { code, message } });
  }
}

// Apps Script only exposes top-level function declarations (to the runtime lookup and to google.script.run).
// The bundle is an IIFE, so scripts/build.mjs appends top-level stubs that delegate to this object.
(globalThis as unknown as { __sci: unknown }).__sci = { doGet, include, rpc, authorize };
