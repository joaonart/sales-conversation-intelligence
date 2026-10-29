// Local UI preview: node preview/server.mjs
//   /                    the app directly (mock data), ?role=ADMIN|EDITOR|VIEWER
//   /framed?base=top     the app inside a sandboxed iframe like HtmlService, optionally with the old <base target="_top"> to reproduce it
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function app({ withBaseTop, oldJs }) {
  let html = read("src/client/index.html")
    .replace("<?!= include('styles') ?>", `<style>${read("src/client/styles.css")}</style>`)
    .replace("<?= appVersion ?>", "preview")
    .replace("<?!= include('app') ?>", `<script>${read("preview/mock.js")}</script><script>${oldJs ? readFileSync(oldJs, "utf8") : read("src/client/app.js")}</script>`);
  if (withBaseTop) html = html.replace("<head>", '<head><base target="_top" />');
  return html;
}

createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const send = (body) => res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);
  if (url.pathname === "/framed") {
    const variant = url.searchParams.get("base") === "top" ? "top" : "none";
    const old = url.searchParams.get("old") ? `&old=${encodeURIComponent(url.searchParams.get("old"))}` : "";
    // Same sandbox flags HtmlService uses (scripts, forms, same-origin, popups, top navigation only by user activation).
    return send(`<!doctype html><title>host</title><h3 id="host">HOST PAGE (top window)</h3>
      <iframe id="f" style="width:${Number(url.searchParams.get("w")) || 1200}px;max-width:100%;height:640px;border:1px solid #888" src="/app?base=${variant}${old}"
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"></iframe>`);
  }
  if (url.pathname === "/app") {
    // ?old=<path> serves a previous app.js (to reproduce a regression); local debugging only.
    return send(app({ withBaseTop: url.searchParams.get("base") === "top", oldJs: url.searchParams.get("old") || undefined }));
  }
  send(app({ withBaseTop: false }));
}).listen(5173, "127.0.0.1", () => console.log("preview on http://127.0.0.1:5173"));
