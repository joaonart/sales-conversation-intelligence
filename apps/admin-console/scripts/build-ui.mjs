// Builds the client: TypeScript + Preact into ONE script, Tailwind into ONE stylesheet. Apps Script serves no static files, so both are inlined into the HTML
// by build.mjs. Everything is compiled here, ahead of time: nothing runs a compiler (or loads a CDN) in the browser.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function buildUi({ minify = true } = {}) {
  const js = await build({
    entryPoints: ["src/ui/main.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    target: "es2020",
    platform: "browser",
    jsx: "automatic",
    jsxImportSource: "preact",
    minify,
    legalComments: "none",
    logLevel: "warning",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  const dir = mkdtempSync(join(tmpdir(), "sci-css-"));
  try {
    const out = join(dir, "app.css");
    const args = ["tailwindcss", "-i", "src/ui/styles/app.css", "-o", out, ...(minify ? ["--minify"] : [])];
    const r = spawnSync("npx", ["--no-install", ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`tailwind failed: ${r.stderr || r.stdout}`);
    return { js: js.outputFiles[0].text, css: readFileSync(out, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
