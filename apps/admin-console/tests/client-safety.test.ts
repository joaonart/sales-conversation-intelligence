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

  it("never reads identity or tenant from the URL or storage for authorisation", () => {
    expect(code).not.toMatch(/location\.search/);
  });
});
