import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

// The deployed bundle must declare its entry points at the top level: Apps Script ignores functions attached to globalThis at runtime,
// so google.script.run.rpc would be undefined (found on the first real deploy).
describe("Apps Script bundle", () => {
  let code = "";
  beforeAll(() => {
    execFileSync("node", ["scripts/build.mjs"], { cwd: new URL("..", import.meta.url), stdio: "ignore" });
    code = readFileSync(new URL("../dist/Code.js", import.meta.url), "utf8");
  });

  it.each(["doGet", "include", "rpc", "authorize"])("declares %s as a top-level function", (name) => {
    expect(code).toMatch(new RegExp(`^function ${name}\\(`, "m"));
  });

  it("the stubs delegate to the bundled implementation", () => {
    expect(code).toMatch(/__sci = \{ doGet, include, rpc, authorize \}/);
    expect(code).not.toMatch(/Object\.assign\(globalThis/);
  });

  it("is a classic script: no ES module syntax Apps Script cannot parse", () => {
    expect(code).not.toMatch(/^\s*(import|export)\s/m);
  });

  it("ships the manifest with the web app and least-privilege scopes", () => {
    const m = JSON.parse(readFileSync(new URL("../dist/appsscript.json", import.meta.url), "utf8"));
    expect(m.webapp).toEqual({ executeAs: "USER_DEPLOYING", access: "DOMAIN" });
    // Every scope is a decision: adding one widens what the deployer's token (and anyone who can edit the script) can do.
    expect(m.oauthScopes).toEqual([
      "https://www.googleapis.com/auth/bigquery", // read and write the platform data
      "https://www.googleapis.com/auth/userinfo.email", // identify the signed-in user
      "https://www.googleapis.com/auth/directory.readonly", // read the user's own name and photo from the Workspace directory (display only)
    ]);
    const services = m.dependencies.enabledAdvancedServices.map((x: { userSymbol: string; version: string }) => `${x.userSymbol}:${x.version}`);
    expect(services).toEqual(["BigQuery:v2", "People:v1"]);
  });
});
