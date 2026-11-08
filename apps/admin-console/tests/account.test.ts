import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROLE_RANK, type Role } from "../src/server/types";
import { CAPABILITIES } from "../src/ui/lib/capabilities";
import { A, code, harness } from "./helpers";

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

const clientCaps = (): Array<[string, Role]> => CAPABILITIES.map((c) => [c.label, c.min]);

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

describe("version", () => {
  it("the app version shown in the UI equals the package version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    const main = readFileSync(new URL("../src/server/main.ts", import.meta.url), "utf8");
    expect(main).toContain(`const APP_VERSION = "${pkg.version}"`);
  });
});
