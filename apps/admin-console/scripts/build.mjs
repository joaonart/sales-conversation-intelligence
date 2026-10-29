// Bundles the server into a single Code.js and wraps the client files as HtmlService includes.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const out = "dist";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: ["src/server/main.ts"],
  outfile: `${out}/Code.js`,
  bundle: true,
  format: "iife",
  target: "es2020",
  platform: "neutral",
  legalComments: "none",
  logLevel: "warning",
});

const client = "src/client";
const css = readFileSync(`${client}/styles.css`, "utf8");
const js = readFileSync(`${client}/app.js`, "utf8");
if (js.includes("</script")) throw new Error("app.js must not contain </script");
writeFileSync(`${out}/styles.html`, `<style>\n${css}\n</style>\n`);
writeFileSync(`${out}/app.html`, `<script>\n${js}\n</script>\n`);
cpSync(`${client}/index.html`, `${out}/index.html`);
cpSync("appsscript.json", `${out}/appsscript.json`);
if (!existsSync(`${out}/Code.js`)) throw new Error("build failed");
console.log("built", out);
