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

// Apps Script discovers entry points by scanning for TOP-LEVEL function declarations: functions assigned at runtime (globalThis) are not
// callable from google.script.run. The bundle is an IIFE, so expose them with explicit top-level stubs.
const stubs = `
// ---- entry points (top-level declarations required by Apps Script) ----
function doGet(e) { return globalThis.__sci.doGet(e); }
function include(name) { return globalThis.__sci.include(name); }
function rpc(requestJson) { return globalThis.__sci.rpc(requestJson); }
`;
writeFileSync(`${out}/Code.js`, readFileSync(`${out}/Code.js`, "utf8") + stubs);

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
