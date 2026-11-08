// Local UI preview: node preview/server.mjs   (builds the client on every page load, so a refresh shows the latest source)
//   /                    the app directly (mock data), ?role=ADMIN|EDITOR|VIEWER, ?lightos=1 to simulate a machine whose system theme is light
//   /framed?base=top     the app inside a sandboxed iframe like HtmlService, optionally with <base target="_top"> to reproduce that old bug
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { buildUi } from "../scripts/build-ui.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

async function app({ withBaseTop, lightOs }) {
  const { js, css } = await buildUi({ minify: false });
  const mock = read("preview/mock.js");
  // Function replacers: the bundle may contain `$'` or `$&`, which a string replacement would expand.
  // ?lightos=1: the dark rules only apply when the toggle pins dark.
  let html = read("src/ui/index.html")
    .replace("<?!= include('styles') ?>", () => `<style>${lightOs ? css.replaceAll("@media (prefers-color-scheme: dark)", "@media not all") : css}</style>`)
    .replace("<?= appVersion ?>", "preview")
    .replace("<?!= include('app') ?>", () => `<script>${mock}</script><script>${js}</script>`);
  if (withBaseTop) html = html.replace("<head>", '<head><base target="_top" />');
  return html;
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const send = (body, status = 200) => res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);
  try {
    if (url.pathname === "/framed") {
      const variant = url.searchParams.get("base") === "top" ? "top" : "none";
      // Same sandbox flags HtmlService uses (scripts, forms, same-origin, popups, top navigation only by user activation).
      return send(`<!doctype html><title>host</title><h3 id="host">HOST PAGE (top window)</h3>
      <iframe id="f" style="width:${Number(url.searchParams.get("w")) || 1200}px;max-width:100%;height:640px;border:1px solid #888" src="/app?base=${variant}"
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"></iframe>`);
    }
    if (url.pathname === "/app") return send(await app({ withBaseTop: url.searchParams.get("base") === "top" }));
    return send(await app({ withBaseTop: false, lightOs: url.searchParams.get("lightos") === "1" }));
  } catch (e) {
    send(`<pre>${String(e instanceof Error ? e.message : e).replace(/</g, "&lt;")}</pre>`, 500);
  }
}).listen(5173, "127.0.0.1", () => console.log("preview on http://127.0.0.1:5173"));
