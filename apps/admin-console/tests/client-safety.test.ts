import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const js = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../src/client/index.html", import.meta.url), "utf8");

describe("client cannot turn data into markup or code", () => {
  const code = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  it.each([
    ["innerHTML assignment", /\.innerHTML\s*=/],
    ["outerHTML assignment", /\.outerHTML\s*=/],
    ["insertAdjacentHTML", /insertAdjacentHTML/],
    ["document.write", /document\.write/],
    ["eval", /\beval\s*\(/],
    ["new Function", /new\s+Function\s*\(/],
    ["string timers", /set(Timeout|Interval)\s*\(\s*["'`]/],
    ["external scripts or styles", /https?:\/\/[^"'\s]+\.(js|css)/],
  ])("has no %s", (_n, re) => {
    expect(code).not.toMatch(re);
  });

  it("the page template pulls in nothing from other origins", () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/i);
  });

  it("keeps navigation inside the sandboxed iframe (no <base target=_top>, internal links set the hash themselves)", () => {
    expect(html).not.toMatch(/<base\b/i);
    const anchors = code.match(/h\("a",\s*\{[^}]*href:\s*"#\/[^}]*\}/g) ?? [];
    expect(anchors.length).toBeGreaterThanOrEqual(3);
    for (const a of anchors) expect(a, a).toMatch(/onclick:\s*go\(/);
  });

  it("a view that throws shows an error instead of a blank page", () => {
    expect(code).toMatch(/try\s*\{\s*VIEWS\[name\]\(main, parts\);\s*\}\s*catch/);
    expect(code).toMatch(/addEventListener\("unhandledrejection"/);
  });

  it("never reads identity or tenant from the URL or storage for authorisation", () => {
    expect(code).not.toMatch(/location\.search/);
  });
});
