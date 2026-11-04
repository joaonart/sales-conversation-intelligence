import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROLE_RANK, type Role } from "../src/server/types";
import { A, code, harness } from "./helpers";

const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");

/** The account menu lists what each profile can do. That list is descriptive, so it must never drift from what the server enforces. */
const ENFORCED_BY: Record<string, { method: string; payload: Record<string, unknown> }> = {
  "Ver painel, sessões, resultados e execuções": { method: "dashboard.summary", payload: {} },
  "Ver o conteúdo das conversas (mascarado)": { method: "sessions.get", payload: { sessionId: "s1" } },
  "Registrar decisão de revisão": { method: "review.decide", payload: { sessionId: "s1", analysisId: "a1", decision: "CONFIRMED" } },
  "Criar e editar rascunhos de rubricas": { method: "rubrics.createDraft", payload: { rubric_id: "r1", name: "n" } },
  "Publicar rubricas": { method: "rubrics.publish", payload: { rubric_id: "r1", version: 1, etag: "x" } },
  "Pedir e cancelar execuções (roteamento e análises)": { method: "executions.request", payload: { kind: "ROUTING", confirm: true } },
  "Gerenciar usuários e acessos": { method: "users.upsert", payload: { email: "n@example.com", role: "VIEWER" } },
  "Consultar a auditoria": { method: "audit.list", payload: {} },
};

function clientCaps(): Array<[string, Role]> {
  const block = appJs.match(/var CAPS = \[(.*?)\];/s)?.[1] ?? "";
  return [...block.matchAll(/\["([^"]+)",\s*"(VIEWER|EDITOR|ADMIN)"\]/g)].map((m) => [m[1]!, m[2] as Role]);
}

describe("account menu: the permissions it shows are the ones the server enforces", () => {
  const caps = clientCaps();

  it("lists exactly the capabilities that are checked here", () => {
    expect(caps.length).toBeGreaterThan(0);
    expect(caps.map(([label]) => label).sort()).toEqual(Object.keys(ENFORCED_BY).sort());
  });

  it.each(caps)("%s -> minimum role %s", (label, min) => {
    const { method, payload } = ENFORCED_BY[label]!;
    for (const role of ["VIEWER", "EDITOR", "ADMIN"] as Role[]) {
      const h = harness({ "ana@example.com": [[A, role]] });
      const result = code(h.call(method, { tenant: A, ...payload }));
      const shouldBeAllowed = ROLE_RANK[role] >= ROLE_RANK[min];
      // A role below the minimum is refused outright; a role at or above it gets past authorisation (it may still fail validation or find nothing).
      expect(result === "FORBIDDEN", `${label} as ${role}: got ${result}`).toBe(!shouldBeAllowed);
    }
  });
});

describe("account menu: content", () => {
  it("does not repeat the workspace list (the header picker is the one place to switch workspace)", () => {
    expect(appJs).not.toContain("Seus acessos");
    expect(appJs).not.toContain("acct-row");
  });
});

describe("account menu: behaviour and safety", () => {
  it("is an accessible dialog that closes with Escape and on outside click, and restores focus", () => {
    expect(appJs).toContain('role: "dialog"');
    expect(appJs).toMatch(/"aria-expanded"/);
    expect(appJs).toMatch(/e\.key === "Escape"/);
    expect(appJs).toMatch(/addEventListener\("mousedown", onDoc, true\)/);
    expect(appJs).toMatch(/removeEventListener\("mousedown", onDoc, true\)/); // listeners never leak
    expect(appJs).toMatch(/anchor\.focus\(\)/);
  });

  it("opens the Google account page only in a new tab without opener access", () => {
    expect(appJs).toContain('window.open("https://myaccount.google.com/", "_blank", "noopener")');
  });

  it("the app version shown in the UI equals the package version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    const main = readFileSync(new URL("../src/server/main.ts", import.meta.url), "utf8");
    expect(main).toContain(`const APP_VERSION = "${pkg.version}"`);
  });
});


describe("workspace picker", () => {
  const app = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  it("is a menu only when there is more than one workspace; with one it is a fixed label that says so", () => {
    expect(app).toContain("var sel = tenants.length > 1");
    expect(app).toContain('"Você tem acesso a apenas 1 workspace"');
    expect(app).toMatch(/h\("div", \{ class: "picker" \}, h\("label", null, "Workspace"\), sel\)/);
    expect(css).toMatch(/\.picker \.ws-fixed \{/);
  });
  it("switching goes through pick(), which sets the claimed tenant and the role of that membership", () => {
    expect(app).toMatch(/function pick\(i\) \{\s*var m = state\.me\.memberships\[i\];\s*state\.tenant = \{ organization_id: m\.organization_id, workspace_id: m\.workspace_id \}; state\.role = m\.role;/);
  });
});


describe("account menu: the list of capabilities opens from one entry", () => {
  it("describes every capability of CAPS in one sentence, and nothing else", () => {
    const block = appJs.match(/var CAP_INFO = \{(.*?)\n  \};/s)?.[1] ?? "";
    const labels = [...block.matchAll(/^\s*"([^"]+)":\s*"/gm)].map((m) => m[1]!);
    expect(labels.sort()).toEqual(clientCaps().map(([l]) => l).sort());
  });
  it("expands the capabilities inside the menu itself (a disclosure with the count), not in a dialog of its own", () => {
    expect(appJs).toContain('"Funcionalidades disponíveis"');
    expect(appJs).toMatch(/class: "acct-link", "aria-expanded": "false", "aria-controls": "acct-caps"/);
    expect(appJs).toMatch(/panel_\.hidden = !open; e\.currentTarget\.setAttribute\("aria-expanded", open \? "true" : "false"\)/);
    expect(appJs).not.toMatch(/capsDialog|caps-modal|h\("ul", \{ class: "caps" \}/); // no modal, no inline list from before
    const fn = appJs.slice(appJs.indexOf("function capsPanel"), appJs.indexOf("// In-app navigation"));
    expect(fn).toContain("el.hidden = true"); // starts collapsed
    expect(fn).toContain('role: "region"');
    expect(fn).not.toMatch(/innerHTML|insertAdjacentHTML/);
  });
});
