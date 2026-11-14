import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
const ui = files("src/ui").filter((f) => f.endsWith(".tsx"));

describe("type sizes come from the theme", () => {
  it("no component writes a font size as an arbitrary value (text-[Npx]): it uses the scale and the two named sizes", () => {
    const offenders = ui.filter((f) => /\btext-\[\d+(\.\d+)?(px|rem)\]/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the named sizes are defined once, in the theme", () => {
    const css = readFileSync("src/ui/styles/app.css", "utf8");
    expect(css).toMatch(/--text-compact:\s*13px;/);
    expect(css).toMatch(/--text-micro:\s*11px;/);
  });
});
