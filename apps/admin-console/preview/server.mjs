// Local UI preview: node preview/server.mjs  (http://localhost:5173/?role=ADMIN|EDITOR|VIEWER)
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
createServer((req, res) => {
  const html = read("src/client/index.html")
    .replace("<?!= include('styles') ?>", `<style>${read("src/client/styles.css")}</style>`)
    .replace("<?= appVersion ?>", "preview")
    .replace("<?!= include('app') ?>", `<script>${read("preview/mock.js")}</script><script>${read("src/client/app.js")}</script>`);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
}).listen(5173, "127.0.0.1", () => console.log("preview on http://127.0.0.1:5173"));
